import { ErrorMessageCode } from '@opensumi/ide-connection';
import { WSChannelHandler } from '@opensumi/ide-connection/browser';
import { BrowserConnectionErrorEvent, BrowserConnectionOpenEvent, IEventBus, ILogger } from '@opensumi/ide-core-common';
import { createBrowserInjector } from '@opensumi/ide-dev-tool/browser';
import { MockInjector } from '@opensumi/ide-dev-tool/injector';

import { ClientAppStateService } from '../../src/application';
import { createConnectionService } from '../../src/bootstrap/connection';

import type { ChannelMessage, IRuntimeSocketConnection, ISerializer } from '@opensumi/ide-connection';
import type { WSChannelPreflight } from '@opensumi/ide-connection/browser';

const preflightPath = 'RuntimeTopologyHandshake';
const rpcPath = 'RPCService';

const identitySerializer: ISerializer<ChannelMessage, ChannelMessage> = {
  deserialize: (message) => message,
  serialize: (message) => message,
};

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`Timed out while waiting for ${description}`);
}

class ManualRuntimeConnection implements IRuntimeSocketConnection<ChannelMessage> {
  private open = false;
  private readonly messageListeners = new Set<(message: ChannelMessage) => void>();
  private readonly openListeners = new Set<() => void>();
  private readonly closeListeners = new Set<(code?: number, reason?: string) => void>();
  private readonly onceCloseListeners = new Set<(code?: number, reason?: string) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();

  readonly sentMessages: ChannelMessage[] = [];

  isOpen(): boolean {
    return this.open;
  }

  send(message: ChannelMessage): void {
    this.sentMessages.push(message);
  }

  onMessage(listener: (message: ChannelMessage) => void) {
    this.messageListeners.add(listener);
    return { dispose: () => this.messageListeners.delete(listener) };
  }

  onceClose(listener: (code?: number, reason?: string) => void) {
    this.onceCloseListeners.add(listener);
    return { dispose: () => this.onceCloseListeners.delete(listener) };
  }

  onOpen(listener: () => void) {
    this.openListeners.add(listener);
    return { dispose: () => this.openListeners.delete(listener) };
  }

  onClose(listener: (code?: number, reason?: string) => void) {
    this.closeListeners.add(listener);
    return { dispose: () => this.closeListeners.delete(listener) };
  }

  onError(listener: (error: Error) => void) {
    this.errorListeners.add(listener);
    return { dispose: () => this.errorListeners.delete(listener) };
  }

  emitMessage(message: ChannelMessage): void {
    for (const listener of this.messageListeners) {
      listener(message);
    }
  }

  emitOpen(): void {
    this.open = true;
    for (const listener of this.openListeners) {
      listener();
    }
  }

  emitClose(code = 1006, reason = 'transport lost'): void {
    this.open = false;
    for (const listener of this.closeListeners) {
      listener(code, reason);
    }
    for (const listener of this.onceCloseListeners) {
      listener(code, reason);
    }
    this.onceCloseListeners.clear();
  }

  emitError(error: Error): void {
    for (const listener of this.errorListeners) {
      listener(error);
    }
  }

  openMessages(path: string): Array<Extract<ChannelMessage, { kind: 'open' }>> {
    return this.sentMessages.filter(
      (message): message is Extract<ChannelMessage, { kind: 'open' }> =>
        message.kind === 'open' && message.path === path,
    );
  }

  readyLatest(path: string): void {
    const message = this.openMessages(path).at(-1);
    if (!message) {
      throw new Error(`No open message found for ${path}`);
    }
    this.emitMessage({ id: message.id, kind: 'server-ready', traceId: message.traceId });
  }

  rejectLatest(path: string, message: string): void {
    const openMessage = this.openMessages(path).at(-1);
    if (!openMessage) {
      throw new Error(`No open message found for ${path}`);
    }
    this.emitMessage({
      id: openMessage.id,
      kind: 'error',
      code: ErrorMessageCode.ChannelDraining,
      message,
      traceId: openMessage.traceId,
    });
  }

  readonly dispose = jest.fn(() => {
    this.open = false;
  });
}

function createLogger() {
  return { error: jest.fn(), log: jest.fn(), warn: jest.fn() };
}

describe('packages/core-browser/src/bootstrap/connection.ts', () => {
  let injector: MockInjector;
  let eventBus: IEventBus;
  let stateService: ClientAppStateService;

  beforeEach(() => {
    injector = createBrowserInjector([]);
    injector.mockService(ILogger, { reportToServer: jest.fn() });
    eventBus = injector.get(IEventBus);
    stateService = injector.get(ClientAppStateService);
    stateService.state = 'core_module_initialized';
  });

  afterEach(async () => {
    await injector.disposeAll();
  });

  function startConnection(preflight?: WSChannelPreflight, logger = createLogger()) {
    const connection = new ManualRuntimeConnection();
    const channelHandler = new WSChannelHandler(
      connection as unknown as IRuntimeSocketConnection<Uint8Array>,
      'readiness-client',
      { logger, preflight, serializer: identitySerializer },
    );
    const openListener = jest.fn();
    eventBus.on(BrowserConnectionOpenEvent, openListener);
    const service = createConnectionService(injector, [], channelHandler);
    return { channelHandler, connection, hasPreflight: Boolean(preflight), logger, openListener, service };
  }

  async function finishInitialConnection(context: ReturnType<typeof startConnection>): Promise<void> {
    context.connection.emitOpen();
    if (context.hasPreflight) {
      await waitFor(() => context.connection.openMessages(preflightPath).length === 1, 'initial preflight open');
      context.connection.readyLatest(preflightPath);
    }
    await waitFor(() => context.connection.openMessages(rpcPath).length === 1, 'initial RPC open');
    context.connection.readyLatest(rpcPath);
    await context.service;
    await waitFor(() => context.openListener.mock.calls.length === 1, 'initial browser connection event');
  }

  it('fires the initial open event only after preflight and RPC server-ready', async () => {
    expect.hasAssertions();
    const releasePreflight = createDeferred();
    const preflightChannelReady = createDeferred();
    const context = startConnection({
      channelPath: preflightPath,
      run: async (_channel, open) => {
        await open();
        preflightChannelReady.resolve();
        await releasePreflight.promise;
      },
    });

    expect(context.openListener).not.toHaveBeenCalled();
    context.connection.emitOpen();
    await waitFor(() => context.connection.openMessages(preflightPath).length === 1, 'preflight open');

    expect(context.openListener).not.toHaveBeenCalled();
    context.connection.readyLatest(preflightPath);
    await preflightChannelReady.promise;

    expect(context.openListener).not.toHaveBeenCalled();
    expect(context.connection.openMessages(rpcPath)).toHaveLength(0);
    releasePreflight.resolve();
    await waitFor(() => context.connection.openMessages(rpcPath).length === 1, 'RPC open');

    expect(context.openListener).not.toHaveBeenCalled();
    context.connection.readyLatest(rpcPath);
    await context.service;
    await waitFor(() => context.openListener.mock.calls.length === 1, 'browser connection open event');

    expect(context.openListener).toHaveBeenCalledTimes(1);
  });

  it('fires a reconnect event only after the new preflight and RPC channel are ready', async () => {
    expect.hasAssertions();
    const releaseReconnectPreflight = createDeferred();
    const reconnectPreflightReady = createDeferred();
    let runCount = 0;
    const context = startConnection({
      channelPath: preflightPath,
      run: async (_channel, open) => {
        runCount++;
        await open();
        if (runCount === 2) {
          reconnectPreflightReady.resolve();
          await releaseReconnectPreflight.promise;
        }
      },
    });
    await finishInitialConnection(context);

    context.connection.emitClose();
    context.connection.emitOpen();
    await waitFor(() => context.connection.openMessages(preflightPath).length === 2, 'reconnect preflight open');

    expect(context.openListener).toHaveBeenCalledTimes(1);
    expect(context.connection.openMessages(rpcPath)).toHaveLength(1);
    context.connection.readyLatest(preflightPath);
    await reconnectPreflightReady.promise;

    expect(context.openListener).toHaveBeenCalledTimes(1);
    expect(context.connection.openMessages(rpcPath)).toHaveLength(1);
    releaseReconnectPreflight.resolve();
    await waitFor(() => context.connection.openMessages(rpcPath).length === 2, 'reconnect RPC open');

    expect(context.openListener).toHaveBeenCalledTimes(1);
    context.connection.readyLatest(rpcPath);
    await waitFor(() => context.openListener.mock.calls.length === 2, 'browser reconnect event');

    expect(context.openListener).toHaveBeenCalledTimes(2);
  });

  it('retires settled preflight channels from heartbeat and reconnect bookkeeping', async () => {
    expect.hasAssertions();
    jest.useFakeTimers();
    try {
      const context = startConnection({
        channelPath: preflightPath,
        run: async (_channel, open) => open(),
      });
      await finishInitialConnection(context);

      expect(context.channelHandler.getChannel(preflightPath)).toBeUndefined();
      expect(context.channelHandler.getChannel(rpcPath)).toBeDefined();
      context.connection.sentMessages.length = 0;
      jest.advanceTimersByTime(10_000);

      expect(
        context.connection.sentMessages.filter((message) => message.kind === 'ping').map((message) => message.id),
      ).toEqual([`readiness-client:${rpcPath}`]);

      context.connection.emitClose();
      context.connection.emitOpen();
      await waitFor(() => context.connection.openMessages(preflightPath).length === 1, 'reconnect preflight open');
      context.connection.readyLatest(preflightPath);
      await waitFor(() => context.connection.openMessages(rpcPath).length === 1, 'reconnect RPC open');
      context.connection.readyLatest(rpcPath);
      await waitFor(() => context.openListener.mock.calls.length === 2, 'browser reconnect event');

      expect(context.channelHandler.getChannel(preflightPath)).toBeUndefined();
      expect(context.channelHandler.getChannel(rpcPath)).toBeDefined();
      context.connection.sentMessages.length = 0;
      jest.advanceTimersByTime(10_000);

      expect(
        context.connection.sentMessages.filter((message) => message.kind === 'ping').map((message) => message.id),
      ).toEqual([`readiness-client:${rpcPath}`]);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not fire a reconnect event when preflight rejects the new epoch', async () => {
    expect.hasAssertions();
    const preflightError = new Error('runtime topology rejected');
    const onFatalError = jest.fn();
    let runCount = 0;
    const context = startConnection({
      channelPath: preflightPath,
      onFatalError,
      run: async (_channel, open) => {
        runCount++;
        await open();
        if (runCount === 2) {
          throw preflightError;
        }
      },
    });
    await finishInitialConnection(context);

    context.connection.emitClose();
    context.connection.emitOpen();
    await waitFor(() => context.connection.openMessages(preflightPath).length === 2, 'reconnect preflight open');
    context.connection.readyLatest(preflightPath);
    await waitFor(() => onFatalError.mock.calls.length === 1, 'fatal preflight callback');
    await waitFor(
      () => context.logger.error.mock.calls.some((call) => call[1] === 'failed to restore logical channels'),
      'failed reconnect log',
    );

    expect(context.connection.openMessages(rpcPath)).toHaveLength(1);
    expect(context.openListener).toHaveBeenCalledTimes(1);
    expect(context.connection.dispose).toHaveBeenCalledTimes(1);
    expect(context.connection.isOpen()).toBe(false);
    expect(onFatalError).toHaveBeenCalledTimes(1);
    expect(onFatalError).toHaveBeenCalledWith(preflightError);
    expect(context.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('WSChannelHandler'),
      'failed to restore logical channels',
      preflightError,
    );
  });

  it('does not fire a reconnect event when the RPC channel is rejected before server-ready', async () => {
    expect.hasAssertions();
    const onFatalError = jest.fn();
    const context = startConnection({
      channelPath: preflightPath,
      onFatalError,
      run: async (_channel, open) => open(),
    });
    await finishInitialConnection(context);

    context.connection.emitClose();
    context.connection.emitOpen();
    await waitFor(() => context.connection.openMessages(preflightPath).length === 2, 'reconnect preflight open');
    context.connection.readyLatest(preflightPath);
    await waitFor(() => context.connection.openMessages(rpcPath).length === 2, 'reconnect RPC open');
    context.connection.rejectLatest(rpcPath, 'server is draining');
    await waitFor(
      () => context.logger.error.mock.calls.some((call) => call[1] === 'failed to restore logical channels'),
      'failed RPC reconnect log',
    );

    expect(context.openListener).toHaveBeenCalledTimes(1);
    expect(onFatalError).not.toHaveBeenCalled();
    expect(context.connection.dispose).not.toHaveBeenCalled();
    expect(context.connection.isOpen()).toBe(true);
    expect(context.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('WSChannelHandler'),
      'failed to restore logical channels',
      expect.objectContaining({ message: 'server is draining' }),
    );
  });

  it('forwards physical WebSocket errors after the core module is initialized', async () => {
    expect.hasAssertions();
    const errorListener = jest.fn();
    eventBus.on(BrowserConnectionErrorEvent, errorListener);
    const context = startConnection();
    await finishInitialConnection(context);
    const error = new Error('socket failed');

    context.connection.emitError(error);
    await waitFor(() => errorListener.mock.calls.length === 1, 'browser connection error event');

    expect(errorListener).toHaveBeenCalledTimes(1);
    expect(errorListener.mock.calls[0][0].payload).toBe(error);
  });
});
