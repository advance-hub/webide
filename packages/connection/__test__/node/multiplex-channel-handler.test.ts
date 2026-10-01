import net from 'net';

import { Deferred, IDisposable } from '@opensumi/ide-core-common';

import { WSChannelHandler } from '../../src/browser';
import { IRuntimeSocketConnection } from '../../src/common/connection';
import { IConnectionShape } from '../../src/common/connection/types';
import { CommonChannelPathHandler } from '../../src/common/server-handler';
import { MultiplexElectronChannelHandler } from '../../src/electron';

const preface = Buffer.from('OMUX1\n');
const headerBytes = 9;
const openFrame = 1;
const dataFrame = 2;
const closeFrame = 3;

class TestMultiplexConnection implements IRuntimeSocketConnection<Uint8Array> {
  private readonly messageListeners = new Set<(data: Uint8Array) => void>();
  private readonly closeListeners = new Set<(code?: number, reason?: string) => void>();
  private readonly openListeners = new Set<() => void>();
  private open = true;

  constructor(
    readonly streamId: number,
    private readonly transport: TestMultiplexTransport,
  ) {}

  send(data: Uint8Array): void {
    this.transport.writeFrame(dataFrame, this.streamId, data);
  }

  onMessage(cb: (data: Uint8Array) => void): IDisposable {
    this.messageListeners.add(cb);
    return { dispose: () => this.messageListeners.delete(cb) };
  }

  onceClose(cb: (code?: number, reason?: string) => void): IDisposable {
    const wrapper = (code?: number, reason?: string) => {
      this.closeListeners.delete(wrapper);
      cb(code, reason);
    };
    this.closeListeners.add(wrapper);
    return { dispose: () => this.closeListeners.delete(wrapper) };
  }

  onOpen(cb: () => void): IDisposable {
    this.openListeners.add(cb);
    return { dispose: () => this.openListeners.delete(cb) };
  }

  onClose(cb: (code?: number, reason?: string) => void): IDisposable {
    this.closeListeners.add(cb);
    return { dispose: () => this.closeListeners.delete(cb) };
  }

  isOpen(): boolean {
    return this.open;
  }

  destroy(): void {
    if (!this.open) {
      return;
    }
    this.transport.writeFrame(closeFrame, this.streamId, Buffer.alloc(0));
    this.acceptClose();
  }

  dispose(): void {
    this.destroy();
  }

  acceptData(data: Uint8Array): void {
    this.messageListeners.forEach((listener) => listener(data));
  }

  acceptClose(code = 0, reason = ''): void {
    if (!this.open) {
      return;
    }
    this.open = false;
    const listeners = Array.from(this.closeListeners);
    this.closeListeners.clear();
    this.messageListeners.clear();
    this.openListeners.clear();
    listeners.forEach((listener) => listener(code, reason));
  }
}

class TestMultiplexTransport {
  private buffer: Buffer = Buffer.alloc(0);
  private nextStreamId = 0;
  private readonly streams = new Map<number, TestMultiplexConnection>();

  constructor(readonly socket: net.Socket) {
    socket.on('data', (chunk) => this.accept(chunk));
    socket.once('close', () => {
      this.streams.forEach((stream) => stream.acceptClose(1, 'physical transport closed'));
      this.streams.clear();
    });
  }

  open(): TestMultiplexConnection {
    const stream = new TestMultiplexConnection(++this.nextStreamId, this);
    this.streams.set(stream.streamId, stream);
    this.writeFrame(openFrame, stream.streamId, Buffer.alloc(0));
    return stream;
  }

  writeFrame(frameType: number, streamId: number, data: Uint8Array): void {
    const frame = Buffer.allocUnsafe(headerBytes + data.byteLength);
    frame.writeUInt8(frameType, 0);
    frame.writeUInt32LE(streamId, 1);
    frame.writeUInt32LE(data.byteLength, 5);
    Buffer.from(data.buffer, data.byteOffset, data.byteLength).copy(frame, headerBytes);
    this.socket.write(frame);
  }

  private accept(chunk: Buffer): void {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    while (this.buffer.length >= headerBytes) {
      const frameType = this.buffer.readUInt8(0);
      const streamId = this.buffer.readUInt32LE(1);
      const payloadLength = this.buffer.readUInt32LE(5);
      const frameLength = headerBytes + payloadLength;
      if (this.buffer.length < frameLength) {
        return;
      }
      const payload = this.buffer.subarray(headerBytes, frameLength);
      this.buffer = this.buffer.subarray(frameLength);
      const stream = this.streams.get(streamId);
      if (!stream) {
        throw new Error(`response for unknown stream ${streamId}`);
      }
      if (frameType === dataFrame) {
        stream.acceptData(payload);
      } else if (frameType === closeFrame) {
        this.streams.delete(streamId);
        stream.acceptClose();
      } else {
        throw new Error(`unexpected response frame type ${frameType}`);
      }
    }
  }
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('server did not announce a TCP address'));
        return;
      }
      resolve(address.port);
    });
  });
}

function connect(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

describe('multiplex channel handler', () => {
  it('keeps two logical RPC connections isolated on one physical socket', async () => {
    const server = net.createServer();
    let physicalConnections = 0;
    server.on('connection', () => physicalConnections++);
    const port = await listen(server);
    const paths = new CommonChannelPathHandler();
    const logger = { log() {}, warn() {}, error() {} };
    const nodeHandler = new MultiplexElectronChannelHandler(server, paths, logger);
    nodeHandler.listen();
    paths.register('echo', {
      handler(channel, clientId) {
        channel.onMessage((message) => channel.send(`${clientId}:${message}`));
      },
      dispose() {},
    });

    const socket = await connect(port);
    socket.write(preface.subarray(0, 2));
    socket.write(preface.subarray(2));
    const transport = new TestMultiplexTransport(socket);
    const firstConnection = transport.open();
    const secondConnection = transport.open();
    const firstHandler = new WSChannelHandler(firstConnection, 'first-client', { logger });
    const secondHandler = new WSChannelHandler(secondConnection, 'second-client', { logger });
    await Promise.all([firstHandler.initHandler(), secondHandler.initHandler()]);
    const [firstChannel, secondChannel] = await Promise.all([
      firstHandler.openChannel('echo'),
      secondHandler.openChannel('echo'),
    ]);

    const firstResponse = new Deferred<string>();
    const secondResponse = new Deferred<string>();
    firstChannel.onMessage((message) => firstResponse.resolve(message));
    secondChannel.onMessage((message) => secondResponse.resolve(message));
    firstChannel.send('one');
    secondChannel.send('two');
    await expect(Promise.all([firstResponse.promise, secondResponse.promise])).resolves.toEqual([
      'first-client:one',
      'second-client:two',
    ]);
    expect(physicalConnections).toBe(1);

    firstConnection.destroy();
    const stillOpenResponse = new Deferred<string>();
    secondChannel.onMessage((message) => stillOpenResponse.resolve(message));
    secondChannel.send('still-open');
    await expect(stillOpenResponse.promise).resolves.toBe('second-client:still-open');

    const extMainThreadHandler = jest.fn();
    paths.register('ExtMainThreadConnection', {
      handler: extMainThreadHandler,
      dispose() {},
    });
    nodeHandler.stopAccepting();
    const rejectedConnection = transport.open();
    const rejectedHandler = new WSChannelHandler(rejectedConnection, 'draining-client', { logger });
    await rejectedHandler.initHandler();
    await expect(rejectedHandler.openChannel('ExtMainThreadConnection')).rejects.toThrow('server is draining');
    expect(extMainThreadHandler).not.toHaveBeenCalled();

    firstHandler.dispose();
    secondHandler.dispose();
    rejectedHandler.dispose();
    rejectedConnection.destroy();
    secondConnection.destroy();
    socket.destroy();
    nodeHandler.dispose();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });
});

describe('multiplex stream retirement', () => {
  let server: net.Server;
  let handler: MultiplexElectronChannelHandler;
  let socket: net.Socket;
  let transport: TestMultiplexTransport;
  let connections: IConnectionShape<Uint8Array>[];
  const logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };

  beforeEach(async () => {
    connections = [];
    server = net.createServer();
    const port = await listen(server);
    handler = new MultiplexElectronChannelHandler(server, new CommonChannelPathHandler(), logger, { maxPayload: 1024 });
    jest.spyOn(handler, 'receiveConnection').mockImplementation((connection) => {
      connections.push(connection);
      connection.onMessage((data) => connection.send(data));
    });
    handler.listen();
    socket = await connect(port);
    socket.write(preface);
    transport = new TestMultiplexTransport(socket);
  });

  afterEach(async () => {
    socket?.destroy();
    handler?.dispose();
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  });

  function echo(connection: TestMultiplexConnection, payload: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('multiplex echo timed out')), 2000);
      const listener = connection.onMessage((data) => {
        clearTimeout(timeout);
        listener.dispose();
        resolve(Buffer.from(data).toString());
      });
      connection.send(Buffer.from(payload));
    });
  }

  it.each(['local', 'remote'])(
    'ignores in-flight frames after %s retirement and serves replacement sessions',
    async (side) => {
      const first = transport.open();
      await expect(echo(first, 'first')).resolves.toBe('first');
      if (side === 'local') {
        const closed = new Promise<void>((resolve) => first.onceClose(() => resolve()));
        connections[0].send(Buffer.alloc(1025));
        await closed;
      } else {
        first.destroy();
      }
      transport.writeFrame(dataFrame, first.streamId, Buffer.from('in-flight'));
      transport.writeFrame(closeFrame, first.streamId, Buffer.alloc(0));
      const replacement = transport.open();
      await expect(echo(replacement, 'replacement')).resolves.toBe('replacement');
      expect(socket.destroyed).toBe(false);
      expect(connections).toHaveLength(2);
    },
  );

  it.each([
    ['future DATA', dataFrame, 2, Buffer.alloc(0)],
    ['future CLOSE', closeFrame, 2, Buffer.alloc(0)],
    ['reused OPEN', openFrame, 1, Buffer.alloc(0)],
    ['skipped OPEN', openFrame, 3, Buffer.alloc(0)],
    ['invalid CLOSE payload', closeFrame, 1, Buffer.from('bad')],
    ['unknown type', 255, 1, Buffer.alloc(0)],
  ])('rejects %s even after retirement', async (_name, kind, id, payload) => {
    const first = transport.open();
    await echo(first, 'first');
    first.destroy();
    const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
    transport.writeFrame(kind as number, id as number, payload as Buffer);
    await closed;
    expect(connections).toHaveLength(1);
  });
});
