import { Readable } from 'stream';

import { Type } from '@furyjs/fury';

import { CancellationToken, CancellationTokenSource, Deferred, sleep } from '@opensumi/ide-core-common';
import { IReadableStream, SumiReadableStream, listenReadable } from '@opensumi/ide-utils/stream';

import { ChannelMessage } from '../../../src/common/channel/types';
import { SimpleConnection } from '../../../src/common/connection/drivers/simple';
import { METHOD_NOT_REGISTERED } from '../../../src/common/constants';
import { SumiConnection } from '../../../src/common/rpc/connection';
import { MessageIO, OperationType } from '../../../src/common/rpc/message-io';
import { WSChannel } from '../../../src/common/ws-channel';

import { test } from './common-tester';
import { createConnectionPair, createSumiRPCClientPair, message } from './utils';

class ControllableConnection extends SimpleConnection<Uint8Array> {
  private readonly messageListeners = new Set<(data: Uint8Array) => void>();
  private readonly closeListeners = new Set<(code?: number, reason?: string) => void>();
  readonly sent: Uint8Array[] = [];
  closed = false;
  throwOnSend = false;

  override send(data: Uint8Array): void {
    if (this.closed || this.throwOnSend) {
      throw new Error('socket send failed');
    }
    this.sent.push(data);
  }

  override onMessage(cb: (data: Uint8Array) => void) {
    this.messageListeners.add(cb);
    return { dispose: () => this.messageListeners.delete(cb) };
  }

  override onceClose(cb: (code?: number, reason?: string) => void) {
    this.closeListeners.add(cb);
    return { dispose: () => this.closeListeners.delete(cb) };
  }

  emitMessage(data: Uint8Array): void {
    this.messageListeners.forEach((listener) => listener(data));
  }

  close(): void {
    this.closed = true;
    const listeners = Array.from(this.closeListeners);
    this.closeListeners.clear();
    listeners.forEach((listener) => listener(1006, 'connection closed'));
  }

  reopen(): void {
    this.closed = false;
  }

  get closeListenerCount(): number {
    return this.closeListeners.size;
  }
}

test('sumi rpc', {
  factory: createSumiRPCClientPair,
  pairFactory: createConnectionPair,
});

describe('sumi rpc only', () => {
  let pair: ReturnType<typeof createConnectionPair>;
  beforeEach(() => {
    pair = createConnectionPair();
  });

  afterEach(() => {
    pair && pair.close();
  });

  it('can throw error', async () => {
    const { invoker1, invoker2, client1, client2 } = createSumiRPCClientPair(pair);

    client1.listenService({
      shortUrl: (url: string) => {
        if (!url) {
          throw new Error('url is empty');
        }
        return url.slice(0, 10);
      },
    });
    client2.listenService({
      add: (a: number, b: number) => {
        if (a === 0) {
          throw new Error('a is zero');
        }
        return a + b;
      },
    });

    await expect(invoker1.add(0, 2)).rejects.toThrow('a is zero');
    await expect(invoker2.shortUrl('')).rejects.toThrow('url is empty');

    await expect(invoker1.throwAString()).resolves.toEqual(METHOD_NOT_REGISTERED);
    await expect(invoker2.throwAString()).resolves.toEqual(METHOD_NOT_REGISTERED);

    client2.listenService({
      throwAString: () => {
        throw 'a string';
      },
    });

    try {
      await invoker1.throwAString();
    } catch (error) {
      expect(typeof error).toBe('string');
      expect(error).toBe('a string');
    }
  });

  it('can throw error when method not found', async () => {
    const { invoker1, invoker2, repo } = createSumiRPCClientPair(pair);
    repo.loadProtocolMethod({
      method: 'notFound',
      request: [],
      response: {
        type: Type.any(),
      },
    });

    await expect(invoker1.notFound()).resolves.toEqual(METHOD_NOT_REGISTERED);
    await expect(invoker2.notFound()).resolves.toEqual(METHOD_NOT_REGISTERED);
  });

  it('support readable stream', async () => {
    const { invoker1 } = createSumiRPCClientPair(pair);
    const result = (await invoker1.readFileStream('test.txt')) as IReadableStream<Uint8Array>;

    const deferred = new Deferred<void>();
    let msg = '';

    listenReadable(result, {
      onData: (d) => {
        msg += d.toString();
      },
      onEnd() {
        deferred.resolve();
      },
    });

    await deferred.promise;
    expect(msg).toBe(message);
  });

  it('can cancel a call', async () => {
    expect.hasAssertions();

    const method = 'cancelTest';
    const canceledRequest = new Deferred<void>();
    pair.connection2.onRequest(method, async (t: CancellationToken) => {
      while (!t.isCancellationRequested) {
        // regular cancellation requires async for it to work
        await sleep(0);
      }

      canceledRequest.resolve();
    });

    pair.connection1.listen();
    pair.connection2.listen();

    const source = new CancellationTokenSource();

    const request = pair.connection1.sendRequest(method, source.token);
    source.cancel();

    await canceledRequest.promise;
    await expect(request).resolves.toBeUndefined();
  });

  it('drains admitted request and async notification handlers without admitting new work', async () => {
    expect.hasAssertions();

    const requestStarted = new Deferred<void>();
    const requestCompletion = new Deferred<void>();
    const notificationStarted = new Deferred<void>();
    const notificationCompletion = new Deferred<void>();
    const lateNotification = jest.fn();

    pair.connection2.onRequest('deferredRequest', async () => {
      requestStarted.resolve();
      await requestCompletion.promise;
      return 'done';
    });
    pair.connection2.onNotification('deferredNotification', async () => {
      notificationStarted.resolve();
      await notificationCompletion.promise;
    });
    pair.connection2.onNotification('lateNotification', lateNotification);
    pair.connection1.listen();
    pair.connection2.listen();

    const request = pair.connection1.sendRequest('deferredRequest');
    pair.connection1.sendNotification('deferredNotification');
    await Promise.all([requestStarted.promise, notificationStarted.promise]);

    pair.connection2.beginInboundDrain();
    let idle = false;
    const inboundIdle = pair.connection2.whenInboundIdle().then(() => {
      idle = true;
    });

    pair.connection1.sendNotification('lateNotification');
    await expect(pair.connection1.sendRequest('lateRequest')).rejects.toThrow('RPC connection is draining');
    expect(lateNotification).not.toHaveBeenCalled();
    expect(idle).toBe(false);

    requestCompletion.resolve();
    await expect(request).resolves.toBe('done');
    expect(idle).toBe(false);

    notificationCompletion.resolve();
    await inboundIdle;
    expect(idle).toBe(true);
  });

  it('keeps a streamed request active until the stream ends', async () => {
    expect.hasAssertions();

    const stream = new SumiReadableStream<string>();
    const requestStarted = new Deferred<void>();

    pair.connection2.onRequest('streamRequest', () => {
      requestStarted.resolve();
      return stream;
    });
    pair.connection1.listen();
    pair.connection2.listen();

    const request = pair.connection1.sendRequest('streamRequest');
    await requestStarted.promise;
    pair.connection2.beginInboundDrain();

    let idle = false;
    const inboundIdle = pair.connection2.whenInboundIdle().then(() => {
      idle = true;
    });

    stream.emitData('chunk');
    await expect(request).resolves.toEqual(expect.any(SumiReadableStream));
    expect(idle).toBe(false);

    stream.end();
    await inboundIdle;
    expect(idle).toBe(true);
  });

  it('settles an admitted request when response delivery throws during drain', async () => {
    expect.hasAssertions();

    const socket = new ControllableConnection();
    const logger = { error: jest.fn(), warn: jest.fn() };
    const connection = new SumiConnection(socket, { logger: logger as any });
    const requestStarted = new Deferred<void>();
    const requestCompletion = new Deferred<string>();
    const io = new MessageIO();

    connection.onRequest('deferredRequest', () => {
      requestStarted.resolve();
      return requestCompletion.promise;
    });
    connection.listen();
    socket.emitMessage(io.Request(1, 'deferredRequest', {}, []));
    await requestStarted.promise;

    connection.beginInboundDrain();
    socket.throwOnSend = true;
    requestCompletion.resolve('done');

    await connection.whenInboundIdle();
    await expect(connection.whenInboundIdle()).resolves.toBeUndefined();
    expect(socket.sent).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith(
      'Could not send inbound RPC response 1 for deferredRequest',
      expect.any(Error),
    );
    connection.dispose();
  });

  it('cancels inbound work and rejects pending outbound requests on natural close', async () => {
    expect.hasAssertions();

    const socket = new ControllableConnection();
    const connection = new SumiConnection(socket, { logger: { error() {}, warn() {} } as any });
    const requestStarted = new Deferred<void>();
    const requestCanceled = new Deferred<void>();
    const io = new MessageIO();

    connection.onRequest('cancelOnClose', async (token: CancellationToken) => {
      requestStarted.resolve();
      await new Promise<void>((resolve) => {
        token.onCancellationRequested(() => {
          requestCanceled.resolve();
          resolve();
        });
      });
    });
    connection.listen();
    expect(socket.closeListenerCount).toBe(1);
    socket.emitMessage(io.Request(1, 'cancelOnClose', { cancelable: true }, []));
    await requestStarted.promise;

    const outbound = connection.sendRequest('pendingOutbound');
    const outboundRejection = outbound.catch((error) => error);
    socket.close();
    expect(socket.closeListenerCount).toBe(0);

    await requestCanceled.promise;
    await expect(outboundRejection).resolves.toMatchObject({ name: 'ConnectionClosedError' });
    await expect(connection.whenInboundIdle()).resolves.toBeUndefined();
    await expect(connection.sendRequest('afterClose')).rejects.toMatchObject({ name: 'ConnectionClosedError' });
    expect(() => connection.sendNotification('afterClose')).not.toThrow();
    expect(() => connection.cancelRequest(1)).not.toThrow();
    expect(socket.sent).toHaveLength(1);

    socket.reopen();
    connection.resumeAfterReconnect();
    expect(socket.closeListenerCount).toBe(0);
    connection.sendNotification('afterReconnect');
    await expect(connection.sendRequest('afterReconnect')).rejects.toMatchObject({ name: 'ConnectionClosedError' });
    expect(socket.sent).toHaveLength(1);
    connection.dispose();
    expect(socket.closeListenerCount).toBe(0);
  });

  it('keeps one socket close subscription across reconnectable transport cycles', () => {
    expect.hasAssertions();

    const socket = new ControllableConnection();
    const connection = new SumiConnection(socket, {
      logger: { error() {}, warn() {} } as any,
      reconnectable: true,
    });
    connection.listen();

    expect(socket.closeListenerCount).toBe(1);
    for (let cycle = 0; cycle < 3; cycle++) {
      socket.close();
      expect(socket.closeListenerCount).toBe(0);
      socket.reopen();
      connection.resumeAfterReconnect();
      expect(socket.closeListenerCount).toBe(1);
    }

    connection.dispose();
    expect(socket.closeListenerCount).toBe(0);
  });

  it('rejects the old outbound epoch while preserving work queued after disconnect', async () => {
    expect.hasAssertions();

    const io = new MessageIO();
    let respondDuringFlush = false;
    let channel: WSChannel;
    const transport = {
      send: jest.fn((message: ChannelMessage) => {
        if (!respondDuringFlush || message.kind !== 'binary') {
          return;
        }
        const outbound = io.parse(message.binary);
        if (outbound.method === 'queuedDuringReconnect') {
          channel.dispatch({
            binary: io.Response(outbound.requestId, outbound.method, {}, 'restored'),
            id: channel.id,
            kind: 'binary',
          });
        }
      }),
    };
    channel = new WSChannel(transport as any, { ensureServerReady: true, id: 'reconnectable' });
    const rpcLogger = { error: jest.fn(), warn: jest.fn() };
    const connection = channel.createSumiConnection({ logger: rpcLogger as any, timeout: 1_000 });
    const interruptedCancellation = new CancellationTokenSource();
    connection.listen();
    channel.dispatch({ id: channel.id, kind: 'server-ready', traceId: 'initial' });
    let queued!: Promise<unknown>;
    channel.onClose(() => {
      connection.sendNotification('notificationDuringReconnect');
      queued = connection.sendRequest('queuedDuringReconnect');
    });

    const interrupted = connection.sendRequest('interrupted', interruptedCancellation.token);
    const interruptedMessage = io.parse(transport.send.mock.calls[transport.send.mock.calls.length - 1][0].binary);
    channel.close(1006, 'transient disconnect');
    const sendsBeforeQueue = transport.send.mock.calls.length;
    await expect(interrupted).rejects.toMatchObject({ name: 'ConnectionClosedError' });

    // Canceling an already-cleaned request must not enqueue a Cancel message
    // for the replacement server scope.
    interruptedCancellation.cancel();

    expect(transport.send).toHaveBeenCalledTimes(sendsBeforeQueue);

    respondDuringFlush = true;
    channel.dispatch({ id: channel.id, kind: 'server-ready', traceId: 'reconnected' });
    respondDuringFlush = false;
    channel.fireReopen();
    expect(transport.send).toHaveBeenCalledTimes(sendsBeforeQueue + 2);

    channel.dispatch({
      binary: io.Response(interruptedMessage.requestId, 'interrupted', { chunked: true }, 'stale-chunk'),
      id: channel.id,
      kind: 'binary',
    });
    expect(rpcLogger.error).not.toHaveBeenCalled();

    const flushedMessages = transport.send.mock.calls
      .slice(sendsBeforeQueue)
      .map(([message]) => io.parse(message.binary));
    expect(flushedMessages).toContainEqual(expect.objectContaining({ method: 'notificationDuringReconnect' }));
    expect(flushedMessages).not.toContainEqual(expect.objectContaining({ kind: OperationType.Cancel }));

    await expect(queued).resolves.toBe('restored');

    const nextEpoch = connection.sendRequest('nextEpoch');
    const nextEpochMessage = io.parse(transport.send.mock.calls[transport.send.mock.calls.length - 1][0].binary);
    channel.dispatch({
      binary: io.Response(nextEpochMessage.requestId, 'nextEpoch', {}, 'fresh'),
      id: channel.id,
      kind: 'binary',
    });
    await expect(nextEpoch).resolves.toBe('fresh');

    connection.dispose();
    const sendsBeforeDisposedCalls = transport.send.mock.calls.length;
    await expect(connection.sendRequest('afterDispose')).rejects.toMatchObject({ name: 'ConnectionClosedError' });
    connection.sendNotification('afterDispose');
    connection.cancelRequest(interruptedMessage.requestId);
    expect(transport.send).toHaveBeenCalledTimes(sendsBeforeDisposedCalls);
    channel.dispose();
  });

  it('fences an old inbound stream from the replacement server scope', async () => {
    expect.hasAssertions();

    const transport = { send: jest.fn() };
    const channel = new WSChannel(transport as any, { ensureServerReady: true, id: 'reconnectable-stream' });
    const connection = channel.createSumiConnection();
    const io = new MessageIO();
    const oldStream = new SumiReadableStream<string>();
    const oldStreamAbort = jest.spyOn(oldStream, 'abort').mockImplementation(() => undefined);
    const oldStreamResult = new Deferred<SumiReadableStream<string>>();
    const newStream = new SumiReadableStream<string>();
    const requestStarted = new Deferred<void>();
    const requestCanceled = new Deferred<void>();
    let invocation = 0;
    connection.onRequest('streamAcrossReconnect', (token?: CancellationToken) => {
      invocation++;
      if (invocation === 1) {
        requestStarted.resolve();
        token!.onCancellationRequested(() => requestCanceled.resolve());
        return oldStreamResult.promise;
      }
      return newStream;
    });
    connection.listen();
    channel.dispatch({ id: channel.id, kind: 'server-ready', traceId: 'initial' });
    channel.dispatch({
      binary: io.Request(1, 'streamAcrossReconnect', { cancelable: true }, []),
      id: channel.id,
      kind: 'binary',
    });
    await requestStarted.promise;

    channel.close(1006, 'transient disconnect');
    await requestCanceled.promise;
    let idle = false;
    const inboundIdle = connection.whenInboundIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);

    const sendsBeforeOldCompletion = transport.send.mock.calls.length;
    oldStreamResult.resolve(oldStream);
    await Promise.resolve();
    await Promise.resolve();
    expect(oldStreamAbort).toHaveBeenCalledTimes(1);
    expect(idle).toBe(false);
    oldStream.emitData('old-chunk');
    expect(transport.send).toHaveBeenCalledTimes(sendsBeforeOldCompletion);
    oldStream.end();
    await inboundIdle;
    expect(idle).toBe(true);
    expect(transport.send).toHaveBeenCalledTimes(sendsBeforeOldCompletion);
    const sendsBeforeReconnect = transport.send.mock.calls.length;

    channel.dispatch({ id: channel.id, kind: 'server-ready', traceId: 'reconnected' });
    channel.fireReopen();
    expect(transport.send).toHaveBeenCalledTimes(sendsBeforeReconnect);

    channel.dispatch({
      binary: io.Request(2, 'streamAcrossReconnect', {}, []),
      id: channel.id,
      kind: 'binary',
    });
    await Promise.resolve();
    newStream.emitData('new-chunk');
    newStream.end();
    await Promise.resolve();

    const newEpochResponses = transport.send.mock.calls
      .slice(sendsBeforeReconnect)
      .map(([message]) => io.parse(message.binary));
    expect(newEpochResponses).toEqual([
      expect.objectContaining({ requestId: 2, result: 'new-chunk' }),
      expect.objectContaining({ requestId: 2, result: null }),
    ]);
    expect(invocation).toBe(2);
    connection.dispose();
    channel.dispose();
  });

  it('keeps non-cancelable old-epoch handlers in idle accounting until they settle', async () => {
    expect.hasAssertions();

    const transport = { send: jest.fn() };
    const channel = new WSChannel(transport as any, { ensureServerReady: true, id: 'reconnectable-async' });
    const connection = channel.createSumiConnection();
    const io = new MessageIO();
    const oldRequestStarted = new Deferred<void>();
    const oldRequestCompletion = new Deferred<string>();
    const oldNotificationStarted = new Deferred<void>();
    const oldNotificationCompletion = new Deferred<void>();
    let requestInvocation = 0;

    connection.onRequest('epochRequest', () => {
      requestInvocation++;
      if (requestInvocation === 1) {
        oldRequestStarted.resolve();
        return oldRequestCompletion.promise;
      }
      return 'fresh';
    });
    connection.onNotification('epochNotification', async () => {
      oldNotificationStarted.resolve();
      await oldNotificationCompletion.promise;
    });
    connection.listen();
    channel.dispatch({ id: channel.id, kind: 'server-ready', traceId: 'initial' });
    channel.dispatch({ binary: io.Request(7, 'epochRequest', {}, []), id: channel.id, kind: 'binary' });
    channel.dispatch({ binary: io.Notification(8, 'epochNotification', {}, []), id: channel.id, kind: 'binary' });
    await Promise.all([oldRequestStarted.promise, oldNotificationStarted.promise]);

    channel.close(1006, 'transient disconnect');
    let idle = false;
    const inboundIdle = connection.whenInboundIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);

    channel.dispatch({ id: channel.id, kind: 'server-ready', traceId: 'reconnected' });
    channel.fireReopen();
    channel.dispatch({ binary: io.Request(7, 'epochRequest', {}, []), id: channel.id, kind: 'binary' });
    await Promise.resolve();
    await Promise.resolve();

    const freshResponses = transport.send.mock.calls.map(([message]) => io.parse(message.binary));
    expect(freshResponses).toEqual([expect.objectContaining({ requestId: 7, result: 'fresh' })]);
    expect(requestInvocation).toBe(2);

    oldRequestCompletion.resolve('stale');
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.send).toHaveBeenCalledTimes(1);
    expect(idle).toBe(false);

    oldNotificationCompletion.resolve();
    await inboundIdle;
    expect(idle).toBe(true);
    expect(transport.send).toHaveBeenCalledTimes(1);
    connection.dispose();
    channel.dispose();
  });

  it('retires a disconnected request and never-settling notification while fencing their late settlement', async () => {
    expect.hasAssertions();

    const transport = { send: jest.fn() };
    const channel = new WSChannel(transport as any, { ensureServerReady: true, id: 'retired-inbound-epoch' });
    const connection = channel.createSumiConnection();
    const io = new MessageIO();
    const requestStarted = new Deferred<void>();
    const requestCompletion = new Deferred<string>();
    const notificationStarted = new Deferred<void>();
    const notificationCompletion = new Deferred<void>();

    connection.onRequest('retiredRequest', () => {
      requestStarted.resolve();
      return requestCompletion.promise;
    });
    connection.onNotification('retiredNotification', async () => {
      notificationStarted.resolve();
      await notificationCompletion.promise;
    });
    connection.listen();
    channel.dispatch({ id: channel.id, kind: 'server-ready', traceId: 'initial' });
    channel.dispatch({ binary: io.Request(17, 'retiredRequest', {}, []), id: channel.id, kind: 'binary' });
    channel.dispatch({
      binary: io.Notification(18, 'retiredNotification', {}, []),
      id: channel.id,
      kind: 'binary',
    });
    await Promise.all([requestStarted.promise, notificationStarted.promise]);

    channel.close(1006, 'transport lost');
    let idle = false;
    const inboundIdle = connection.whenInboundIdle().then(() => {
      idle = true;
    });
    await Promise.resolve();
    expect(idle).toBe(false);

    connection.retireDisconnectedInboundOperations();
    await inboundIdle;
    expect(idle).toBe(true);
    const sendsAfterRetirement = transport.send.mock.calls.length;

    requestCompletion.resolve('late response');
    notificationCompletion.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(transport.send).toHaveBeenCalledTimes(sendsAfterRetirement);
    await expect(connection.whenInboundIdle()).resolves.toBeUndefined();

    connection.dispose();
    channel.dispose();
  });

  it('terminates a readable stream produced after its disconnected operation was retired', async () => {
    expect.hasAssertions();

    const transport = { send: jest.fn() };
    const channel = new WSChannel(transport as any, { ensureServerReady: true, id: 'late-retired-stream' });
    const connection = channel.createSumiConnection();
    const io = new MessageIO();
    const requestStarted = new Deferred<void>();
    const streamResult = new Deferred<Readable>();

    connection.onRequest('lateStream', () => {
      requestStarted.resolve();
      return streamResult.promise;
    });
    connection.listen();
    channel.dispatch({ id: channel.id, kind: 'server-ready', traceId: 'initial' });
    channel.dispatch({ binary: io.Request(19, 'lateStream', {}, []), id: channel.id, kind: 'binary' });
    await requestStarted.promise;

    channel.close(1006, 'transport lost');
    connection.retireDisconnectedInboundOperations();
    await expect(connection.whenInboundIdle()).resolves.toBeUndefined();
    const sendsAfterRetirement = transport.send.mock.calls.length;

    const stream = new Readable({ read() {} });
    const lateStreamError = jest.fn();
    stream.on('error', lateStreamError);
    streamResult.resolve(stream);
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(stream.destroyed).toBe(true);
    expect(lateStreamError).not.toHaveBeenCalled();
    expect(transport.send).toHaveBeenCalledTimes(sendsAfterRetirement);

    connection.dispose();
    channel.dispose();
  });

  it('destroys an active inbound stream when the connection closes', async () => {
    expect.hasAssertions();

    const socket = new ControllableConnection();
    const connection = new SumiConnection(socket, { logger: { error() {}, warn() {} } as any });
    const stream = new Readable({ read() {} });
    const requestStarted = new Deferred<void>();
    const io = new MessageIO();

    connection.onRequest('activeStream', () => {
      requestStarted.resolve();
      return stream;
    });
    connection.listen();
    socket.emitMessage(io.Request(1, 'activeStream', {}, []));
    await requestStarted.promise;
    await Promise.resolve();

    socket.close();

    await expect(connection.whenInboundIdle()).resolves.toBeUndefined();
    expect(stream.destroyed).toBe(true);
    connection.dispose();
  });

  it('retires an outbound stream after a chunked remote error', async () => {
    expect.hasAssertions();

    const socket = new ControllableConnection();
    const connection = new SumiConnection(socket, { logger: { error() {}, warn() {} } as any });
    const io = new MessageIO();
    connection.listen();

    const request = connection.sendRequest('outboundStreamError');
    const requestMessage = io.parse(socket.sent[0]);
    socket.emitMessage(io.Response(requestMessage.requestId, 'outboundStreamError', { chunked: true }, 'first'));
    const stream = (await request) as SumiReadableStream<string>;
    const streamError = new Deferred<Error>();
    listenReadable(stream, {
      onData() {},
      onEnd() {},
      onError: (error) => streamError.resolve(error),
    });

    socket.emitMessage(
      io.Error(requestMessage.requestId, 'outboundStreamError', { chunked: true }, new Error('stream failed')),
    );
    await expect(streamError.promise).resolves.toMatchObject({ message: 'stream failed' });

    const sendsBeforeCancel = socket.sent.length;
    connection.cancelRequest(requestMessage.requestId);
    expect(socket.sent).toHaveLength(sendsBeforeCancel);
    connection.dispose();
  });

  it('errors an active outbound stream on a transient close and starts a fresh epoch', async () => {
    expect.hasAssertions();

    const socket = new ControllableConnection();
    const connection = new SumiConnection(socket, {
      logger: { error() {}, warn() {} } as any,
      reconnectable: true,
    });
    const io = new MessageIO();
    connection.listen();

    const request = connection.sendRequest('outboundStream');
    const requestMessage = io.parse(socket.sent[0]);
    socket.emitMessage(io.Response(requestMessage.requestId, 'outboundStream', { chunked: true }, 'first'));
    const stream = (await request) as SumiReadableStream<string>;
    const streamError = new Deferred<Error>();
    listenReadable(stream, {
      onData() {},
      onEnd() {},
      onError: (error) => streamError.resolve(error),
    });

    socket.close();

    await expect(streamError.promise).resolves.toMatchObject({ name: 'ConnectionClosedError' });

    socket.reopen();
    connection.resumeAfterReconnect();
    const freshRequest = connection.sendRequest('freshRequest');
    const freshRequestMessage = io.parse(socket.sent[socket.sent.length - 1]);
    socket.emitMessage(io.Response(freshRequestMessage.requestId, 'freshRequest', {}, 'fresh'));
    await expect(freshRequest).resolves.toBe('fresh');
    connection.dispose();
  });

  it('settles already-ended and prematurely closed Node readable streams', async () => {
    expect.hasAssertions();

    const alreadyEnded = Readable.from([]);
    alreadyEnded.resume();
    await new Promise<void>((resolve) => alreadyEnded.once('end', resolve));

    const endedRequestStarted = new Deferred<void>();
    pair.connection2.onRequest('alreadyEndedStream', () => {
      endedRequestStarted.resolve();
      return alreadyEnded;
    });
    pair.connection1.listen();
    pair.connection2.listen();

    const endedRequest = pair.connection1.sendRequest('alreadyEndedStream');
    await endedRequestStarted.promise;
    pair.connection2.beginInboundDrain();
    await expect(pair.connection2.whenInboundIdle()).resolves.toBeUndefined();
    await expect(endedRequest).resolves.toEqual(expect.any(SumiReadableStream));

    const secondPair = createConnectionPair();
    try {
      const prematurelyClosed = new Readable({ read() {} });
      const closeRequestStarted = new Deferred<void>();
      secondPair.connection2.onRequest('closedStream', () => {
        closeRequestStarted.resolve();
        return prematurelyClosed;
      });
      secondPair.connection1.listen();
      secondPair.connection2.listen();

      const closeRequest = secondPair.connection1.sendRequest('closedStream');
      await closeRequestStarted.promise;
      secondPair.connection2.beginInboundDrain();
      prematurelyClosed.destroy();

      await expect(secondPair.connection2.whenInboundIdle()).resolves.toBeUndefined();
      await expect(closeRequest).resolves.toEqual(expect.any(SumiReadableStream));
    } finally {
      secondPair.close();
    }
  });
});
