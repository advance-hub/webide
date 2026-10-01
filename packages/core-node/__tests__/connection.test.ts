import http from 'http';

import { Injectable, Injector } from '@opensumi/di';
import { ChannelMessage, WSChannel, furySerializer } from '@opensumi/ide-connection';
import { IConnectionShape } from '@opensumi/ide-connection/drivers';
import { MessageIO } from '@opensumi/ide-connection/rpc';
import {
  BaseCommonChannelHandler,
  CommonChannelPathHandler,
  RPCServiceChannelPath,
} from '@opensumi/ide-connection/server';

import {
  INodeLogger,
  IRuntimeTopologyHandshakeServer,
  IServerConnectionRegistry,
  NodeModule,
  RPCServiceCenter,
  ServerConnectionRegistry,
  createServerConnection2,
} from '../src';

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

class TestWireConnection implements IConnectionShape<Uint8Array> {
  private closeListeners: Array<() => void> = [];
  private messageListeners: Array<(message: Uint8Array) => void> = [];

  readonly sentMessages: ChannelMessage[] = [];

  send(message: Uint8Array): void {
    this.sentMessages.push(furySerializer.deserialize(message));
  }

  onMessage(listener: (message: Uint8Array) => void) {
    this.messageListeners.push(listener);
    return {
      dispose: () => {
        this.messageListeners = this.messageListeners.filter((candidate) => candidate !== listener);
      },
    };
  }

  onceClose(listener: () => void) {
    this.closeListeners.push(listener);
    return { dispose() {} };
  }

  message(message: ChannelMessage): void {
    const serialized = furySerializer.serialize(message);
    this.messageListeners.forEach((listener) => listener(serialized));
  }

  close(): void {
    this.closeListeners.forEach((listener) => listener());
  }
}

class TestWireChannelHandler extends BaseCommonChannelHandler {
  constructor(pathHandler: CommonChannelPathHandler) {
    super('core-node-connection-test', pathHandler, { error() {}, log() {}, warn() {} }, { heartbeatInterval: 0 });
  }

  doHeartbeat(): void {}
}

function createTestLogger(): INodeLogger {
  return {
    debug: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
  } as unknown as INodeLogger;
}

function observeRPCServiceCenterConstruction() {
  const originalUidDescriptor = Object.getOwnPropertyDescriptor(RPCServiceCenter.prototype, 'uid');
  const constructed = jest.fn();

  // RPCServiceCenter assigns its generated uid at the end of construction.
  // A prototype setter lets this test observe `new RPCServiceCenter()` without
  // replacing the production class used by the rest of this suite.
  Object.defineProperty(RPCServiceCenter.prototype, 'uid', {
    configurable: true,
    set(this: RPCServiceCenter, value: string) {
      constructed(value);
      Object.defineProperty(this, 'uid', {
        configurable: true,
        enumerable: true,
        value,
        writable: true,
      });
    },
  });

  return {
    constructed,
    restore() {
      if (originalUidDescriptor) {
        Object.defineProperty(RPCServiceCenter.prototype, 'uid', originalUidDescriptor);
      } else {
        delete (RPCServiceCenter.prototype as { uid?: string }).uid;
      }
    },
  };
}

describe('runtime topology handshake admission', () => {
  test('registers the reserved handshake path and sends hello before server-ready', async () => {
    expect.hasAssertions();

    const logger = createTestLogger();
    const channelPathHandler = new CommonChannelPathHandler();
    const hello = JSON.stringify({ type: 'hello', protocol: 'opensumi.runtime-topology' });
    const runtimeTopologyHandshake: IRuntimeTopologyHandshakeServer = {
      channelPath: 'RuntimeTopologyHandshake',
      handleChannel: jest.fn((channel: WSChannel) => channel.send(hello)),
      admitRPC: jest.fn(() => ({ accepted: true })),
    };
    const injector = new Injector([
      { token: INodeLogger, useValue: logger },
      { token: CommonChannelPathHandler, useValue: channelPathHandler },
    ]);
    const server = http.createServer();
    createServerConnection2(server, injector, [], [], { runtimeTopologyHandshake });
    const wireHandler = new TestWireChannelHandler(channelPathHandler);
    const connection = new TestWireConnection();

    try {
      expect(channelPathHandler.get(runtimeTopologyHandshake.channelPath)).toHaveLength(1);

      wireHandler.receiveConnection(connection);
      connection.message({
        kind: 'open',
        id: 'runtime-topology-channel',
        path: runtimeTopologyHandshake.channelPath,
        clientId: 'runtime-topology-client',
        traceId: 'runtime-topology-trace',
      });

      expect(runtimeTopologyHandshake.handleChannel).toHaveBeenCalledTimes(1);
      expect(runtimeTopologyHandshake.admitRPC).not.toHaveBeenCalled();
      expect(connection.sentMessages).toEqual([
        {
          kind: 'data',
          id: 'runtime-topology-channel',
          content: hello,
        },
        {
          kind: 'server-ready',
          id: 'runtime-topology-channel',
          traceId: 'runtime-topology-trace',
        },
      ]);
    } finally {
      wireHandler.dispose();
      await injector.get(IServerConnectionRegistry).dispose();
      await injector.disposeAll();
    }
  });

  test('delegates compatible and required admission per physical connection epoch', async () => {
    expect.hasAssertions();

    const serviceConstructed = jest.fn();
    @Injectable()
    class EpochScopedService {
      constructor() {
        serviceConstructed();
      }
    }

    const logger = createTestLogger();
    const channelPathHandler = new CommonChannelPathHandler();
    const admitRPC = jest
      .fn<
        ReturnType<IRuntimeTopologyHandshakeServer['admitRPC']>,
        Parameters<IRuntimeTopologyHandshakeServer['admitRPC']>
      >()
      // compatible: an unseen handshake epoch may still enter RPC.
      .mockReturnValueOnce({ accepted: true })
      // required: that same unseen state is rejected for a different epoch.
      .mockReturnValueOnce({ accepted: false, reason: 'runtime topology handshake required' });
    const runtimeTopologyHandshake: IRuntimeTopologyHandshakeServer = {
      channelPath: 'RuntimeTopologyHandshake',
      handleChannel: jest.fn(),
      admitRPC,
    };
    const injector = new Injector([
      EpochScopedService,
      { token: INodeLogger, useValue: logger },
      { token: CommonChannelPathHandler, useValue: channelPathHandler },
    ]);
    const module = {
      backServices: [{ servicePath: 'test.runtime-topology-epoch', token: EpochScopedService }],
    } as NodeModule;
    const server = http.createServer();
    createServerConnection2(server, injector, [module], [], { runtimeTopologyHandshake });
    const createChild = jest.spyOn(injector, 'createChild');
    const serviceCenterConstruction = observeRPCServiceCenterConstruction();
    const wireHandler = new TestWireChannelHandler(channelPathHandler);
    const compatibleConnection = new TestWireConnection();
    const requiredConnection = new TestWireConnection();
    const sharedClientId = 'shared-runtime-client';

    try {
      wireHandler.receiveConnection(compatibleConnection);
      compatibleConnection.message({
        kind: 'open',
        id: 'compatible-rpc-channel',
        path: RPCServiceChannelPath,
        clientId: sharedClientId,
        traceId: 'compatible-rpc-trace',
      });

      expect(compatibleConnection.sentMessages).toEqual([
        {
          kind: 'server-ready',
          id: 'compatible-rpc-channel',
          traceId: 'compatible-rpc-trace',
        },
      ]);
      expect(serviceCenterConstruction.constructed).toHaveBeenCalledTimes(1);
      expect(createChild).toHaveBeenCalledTimes(1);
      expect(serviceConstructed).toHaveBeenCalledTimes(1);

      wireHandler.receiveConnection(requiredConnection);
      requiredConnection.message({
        kind: 'open',
        id: 'required-rpc-channel',
        path: RPCServiceChannelPath,
        clientId: sharedClientId,
        traceId: 'required-rpc-trace',
      });

      expect(requiredConnection.sentMessages).toEqual([
        {
          kind: 'error',
          id: 'required-rpc-channel',
          code: 2,
          message: 'runtime topology handshake required',
        },
      ]);
      expect(admitRPC).toHaveBeenCalledTimes(2);
      expect(admitRPC.mock.calls[0][0]).not.toBe(admitRPC.mock.calls[1][0]);
      expect(serviceCenterConstruction.constructed).toHaveBeenCalledTimes(1);
      expect(createChild).toHaveBeenCalledTimes(1);
      expect(serviceConstructed).toHaveBeenCalledTimes(1);
      expect(injector.get(IServerConnectionRegistry).activeConnectionCount).toBe(1);
    } finally {
      wireHandler.dispose();
      await injector.get(IServerConnectionRegistry).dispose();
      serviceCenterConstruction.restore();
      await injector.disposeAll();
    }
  });

  test.each([
    ['pending', 'runtime topology handshake pending'],
    ['rejected', 'runtime topology handshake rejected: Browser feature graph mismatch'],
  ])('preserves the precise %s admission reason in wire error code 2', async (_state, reason) => {
    expect.hasAssertions();

    const serviceConstructed = jest.fn();
    @Injectable()
    class GuardedTopologyService {
      constructor() {
        serviceConstructed();
      }
    }

    const logger = createTestLogger();
    const channelPathHandler = new CommonChannelPathHandler();
    const runtimeTopologyHandshake: IRuntimeTopologyHandshakeServer = {
      channelPath: 'RuntimeTopologyHandshake',
      handleChannel: jest.fn(),
      admitRPC: jest.fn(() => ({ accepted: false, reason })),
    };
    const injector = new Injector([
      GuardedTopologyService,
      { token: INodeLogger, useValue: logger },
      { token: CommonChannelPathHandler, useValue: channelPathHandler },
    ]);
    const module = {
      backServices: [{ servicePath: 'test.guarded-topology', token: GuardedTopologyService }],
    } as NodeModule;
    const server = http.createServer();
    createServerConnection2(server, injector, [module], [], { runtimeTopologyHandshake });
    const createChild = jest.spyOn(injector, 'createChild');
    const serviceCenterConstruction = observeRPCServiceCenterConstruction();
    const wireHandler = new TestWireChannelHandler(channelPathHandler);
    const connection = new TestWireConnection();

    try {
      wireHandler.receiveConnection(connection);
      connection.message({
        kind: 'open',
        id: `${_state}-rpc-channel`,
        path: RPCServiceChannelPath,
        clientId: `${_state}-runtime-client`,
        traceId: `${_state}-rpc-trace`,
      });

      expect(connection.sentMessages).toEqual([
        {
          kind: 'error',
          id: `${_state}-rpc-channel`,
          code: 2,
          message: reason,
        },
      ]);
      expect(runtimeTopologyHandshake.admitRPC).toHaveBeenCalledTimes(1);
      expect(serviceCenterConstruction.constructed).not.toHaveBeenCalled();
      expect(createChild).not.toHaveBeenCalled();
      expect(serviceConstructed).not.toHaveBeenCalled();
      expect(injector.get(IServerConnectionRegistry).activeConnectionCount).toBe(0);
      expect(logger.error).toHaveBeenCalledWith(`Reject RPC connection ${_state}-runtime-client: ${reason}`);
    } finally {
      wireHandler.dispose();
      await injector.get(IServerConnectionRegistry).dispose();
      serviceCenterConstruction.restore();
      await injector.disposeAll();
    }
  });
});

describe('ServerConnectionRegistry', () => {
  test('fails fast when an injected registry does not implement the transport admission contract', async () => {
    expect.hasAssertions();
    const logger = {
      error: jest.fn(),
      log: jest.fn(),
    } as unknown as INodeLogger;
    const injector = new Injector([
      { token: INodeLogger, useValue: logger },
      { token: CommonChannelPathHandler, useValue: new CommonChannelPathHandler() },
      {
        token: IServerConnectionRegistry,
        useValue: {
          activeConnectionCount: 0,
          beginDrain: () => undefined,
          waitForIdle: () => Promise.resolve(),
          dispose: () => undefined,
        },
      },
    ]);
    const server = http.createServer();

    expect(() => createServerConnection2(server, injector, [], [], {})).toThrow(
      'IServerConnectionRegistry is missing required runtime members: acceptsConnections, registerTransportDisposer, trackConnection',
    );

    await injector.disposeAll();
  });

  test('drains admitted RPC work before disposing the connection child injector', async () => {
    expect.hasAssertions();

    const connectionScopeDisposal = createDeferred();
    const requestCompletion = createDeferred();
    const requestStarted = createDeferred();
    const notificationCompletion = createDeferred();
    const notificationStarted = createDeferred();
    const scopeDisposeStarted = createDeferred();
    const responseSent = createDeferred<ReturnType<MessageIO['parse']>>();
    const disposeStarted = jest.fn();
    const lateRequest = jest.fn();
    const messageIO = new MessageIO();

    @Injectable()
    class ConnectionScopedService {
      deferredRpc(): Promise<void> {
        requestStarted.resolve();
        return requestCompletion.promise;
      }

      onDeferredNotification(): Promise<void> {
        notificationStarted.resolve();
        return notificationCompletion.promise;
      }

      lateRpc(): void {
        lateRequest();
      }

      dispose(): Promise<void> {
        disposeStarted();
        scopeDisposeStarted.resolve();
        return connectionScopeDisposal.promise;
      }
    }

    const logger = {
      debug: jest.fn(),
      error: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
    } as unknown as INodeLogger;
    const channelPathHandler = new CommonChannelPathHandler();
    const injector = new Injector([
      ConnectionScopedService,
      { token: INodeLogger, useValue: logger },
      { token: CommonChannelPathHandler, useValue: channelPathHandler },
    ]);
    const module = {
      backServices: [{ servicePath: 'test.connection-scope', token: ConnectionScopedService }],
    } as NodeModule;
    const server = http.createServer();

    createServerConnection2(server, injector, [module], [], {});

    const activeSend = jest.fn((message) => {
      if (message.kind === 'binary') {
        const rpcMessage = messageIO.parse(message.binary);
        if (rpcMessage.requestId === 1) {
          responseSent.resolve(rpcMessage);
        }
      }
    });
    const activeChannel = new WSChannel({ send: activeSend } as any, { id: 'active-channel' });
    const activeClose = jest.fn();
    activeChannel.onClose(activeClose);
    channelPathHandler.openChannel(RPCServiceChannelPath, activeChannel, 'active-client');

    const registry = injector.get(IServerConnectionRegistry);
    expect(registry.activeConnectionCount).toBe(1);

    activeChannel.dispatch({
      binary: messageIO.Request(1, 'test.connection-scope:deferredRpc', {}, []),
      id: activeChannel.id,
      kind: 'binary',
    });
    activeChannel.dispatch({
      binary: messageIO.Notification(2, 'on:test.connection-scope:onDeferredNotification', {}, []),
      id: activeChannel.id,
      kind: 'binary',
    });
    await Promise.all([requestStarted.promise, notificationStarted.promise]);

    // Exercise the narrow interval after inbound admission has stopped but
    // before the channel's listeners are disposed.
    activeChannel.onClose(() => {
      activeChannel.dispatch({
        binary: messageIO.Request(3, 'test.connection-scope:lateRpc', {}, []),
        id: activeChannel.id,
        kind: 'binary',
      });
    });

    registry.beginDrain();
    expect(disposeStarted).not.toHaveBeenCalled();
    expect(lateRequest).not.toHaveBeenCalled();
    expect(activeClose).not.toHaveBeenCalled();

    const rejectedChannel = new WSChannel({ send: jest.fn() } as any, { id: 'rejected-channel' });
    const rejectedClose = jest.fn();
    rejectedChannel.onClose(rejectedClose);
    const rejectedByDrain = channelPathHandler.openChannel(RPCServiceChannelPath, rejectedChannel, 'rejected-client');

    expect(rejectedByDrain).toBeUndefined();
    expect(rejectedClose).not.toHaveBeenCalled();
    expect(registry.activeConnectionCount).toBe(1);

    let disposed = false;
    const disposal = registry.dispose().then(() => {
      disposed = true;
    });
    await Promise.resolve();
    expect(disposeStarted).not.toHaveBeenCalled();
    expect(disposed).toBe(false);

    requestCompletion.resolve();
    await expect(responseSent.promise).resolves.toMatchObject({ requestId: 1 });
    expect(activeClose).not.toHaveBeenCalled();
    expect(disposeStarted).not.toHaveBeenCalled();
    expect(disposed).toBe(false);

    notificationCompletion.resolve();
    await scopeDisposeStarted.promise;
    expect(activeClose).toHaveBeenCalledWith(1001, 'server is draining');
    expect(lateRequest).not.toHaveBeenCalled();
    expect(disposeStarted).toHaveBeenCalledTimes(1);
    expect(disposed).toBe(false);

    connectionScopeDisposal.resolve();
    await disposal;

    expect(registry.activeConnectionCount).toBe(0);
    expect(logger.error).not.toHaveBeenCalled();

    await registry.dispose();
    await injector.disposeAll();
  });

  test('rejects an empty client id before constructing a connection child scope', async () => {
    expect.hasAssertions();

    const serviceConstructed = jest.fn();
    @Injectable()
    class GuardedConnectionService {
      constructor() {
        serviceConstructed();
      }
    }

    const logger = {
      debug: jest.fn(),
      error: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
    } as unknown as INodeLogger;
    const channelPathHandler = new CommonChannelPathHandler();
    const injector = new Injector([
      GuardedConnectionService,
      { token: INodeLogger, useValue: logger },
      { token: CommonChannelPathHandler, useValue: channelPathHandler },
    ]);
    const module = {
      backServices: [{ servicePath: 'test.empty-client-id', token: GuardedConnectionService }],
    } as NodeModule;
    const server = http.createServer();
    createServerConnection2(server, injector, [module], [], {});

    const channel = new WSChannel({ send: jest.fn() } as any, { id: 'empty-client-id-channel' });
    const channelClose = jest.fn();
    channel.onClose(channelClose);
    const channelDispose = jest.spyOn(channel, 'dispose');

    const result = channelPathHandler.openChannel(RPCServiceChannelPath, channel, '   ');

    expect(result).toBeUndefined();
    expect(serviceConstructed).not.toHaveBeenCalled();
    expect(channelClose).toHaveBeenCalledWith(1008, 'invalid client id');
    expect(channelDispose).toHaveBeenCalledTimes(1);
    expect(injector.get(IServerConnectionRegistry).activeConnectionCount).toBe(0);
    expect(logger.error).toHaveBeenCalledWith('Reject RPC connection with an empty client id');

    await injector.get(IServerConnectionRegistry).dispose();
    await injector.disposeAll();
  });

  test('atomically rolls back a child scope when a back service rejects its connection id', async () => {
    expect.hasAssertions();

    const initializationError = new Error('connection identity rejected');
    const serviceDisposed = jest.fn();
    @Injectable()
    class RejectingConnectionService {
      setConnectionClientId(): void {
        throw initializationError;
      }

      dispose(): void {
        serviceDisposed();
      }
    }

    const logger = {
      debug: jest.fn(),
      error: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
    } as unknown as INodeLogger;
    const channelPathHandler = new CommonChannelPathHandler();
    const injector = new Injector([
      RejectingConnectionService,
      { token: INodeLogger, useValue: logger },
      { token: CommonChannelPathHandler, useValue: channelPathHandler },
    ]);
    const module = {
      backServices: [{ servicePath: 'test.rejecting-client-id', token: RejectingConnectionService }],
    } as NodeModule;
    const server = http.createServer();
    createServerConnection2(server, injector, [module], [], {});
    const createChild = injector.createChild.bind(injector);
    let connectionChild: Injector | undefined;
    jest.spyOn(injector, 'createChild').mockImplementation(() => {
      connectionChild = createChild();
      return connectionChild;
    });
    const serviceCenterDispose = jest.spyOn(RPCServiceCenter.prototype, 'dispose');

    const channel = new WSChannel({ send: jest.fn() } as any, { id: 'rejecting-client-id-channel' });
    const channelClose = jest.fn();
    channel.onClose(channelClose);
    const channelDispose = jest.spyOn(channel, 'dispose');

    const result = channelPathHandler.openChannel(RPCServiceChannelPath, channel, 'valid-client');
    await Promise.resolve();
    await Promise.resolve();

    expect(result).toBeUndefined();
    expect(serviceDisposed).toHaveBeenCalledTimes(1);
    expect(connectionChild).toBeDefined();
    expect(connectionChild!.instanceRefMap.size).toBe(0);
    expect(serviceCenterDispose).toHaveBeenCalledTimes(1);
    expect(channelClose).toHaveBeenCalledWith(1011, 'connection initialization failed');
    expect(channelDispose).toHaveBeenCalledTimes(1);
    expect(injector.get(IServerConnectionRegistry).activeConnectionCount).toBe(0);
    expect(logger.error).toHaveBeenCalledWith('Could not initialize RPC connection valid-client', initializationError);
    expect(logger.error).not.toHaveBeenCalledWith('Could not roll back RPC connection valid-client', expect.anything());

    await injector.get(IServerConnectionRegistry).dispose();
    await injector.disposeAll();
    serviceCenterDispose.mockRestore();
  });

  test('reports connection disposal failures only after all scopes are reclaimed', async () => {
    expect.hasAssertions();

    const logger = {
      error: jest.fn(),
      log: jest.fn(),
    } as unknown as INodeLogger;
    const registry = new ServerConnectionRegistry(logger);
    const transportDispose = jest.fn();
    const transportDrain = jest.fn();
    registry.registerTransportDisposer(transportDispose, transportDrain);

    const failedChannel = new WSChannel({ send: jest.fn() } as any, { id: 'failed-channel' });
    const healthyChannel = new WSChannel({ send: jest.fn() } as any, { id: 'healthy-channel' });
    const healthyDisposal = createDeferred();
    registry.trackConnection(failedChannel, 'failed-client', async () => {
      throw new Error('scope cleanup failed');
    });
    registry.trackConnection(healthyChannel, 'healthy-client', () => healthyDisposal.promise);

    registry.beginDrain();

    expect(transportDrain).toHaveBeenCalledTimes(1);
    expect(transportDispose).not.toHaveBeenCalled();
    expect(registry.activeConnectionCount).toBe(2);

    const disposal = registry.dispose();
    healthyDisposal.resolve();

    await expect(disposal).rejects.toMatchObject({
      failures: [expect.objectContaining({ clientId: 'failed-client' })],
      message: expect.stringContaining('failed-client'),
      name: 'ServerConnectionDisposalError',
    });
    expect(registry.activeConnectionCount).toBe(0);
    expect(transportDispose).toHaveBeenCalledTimes(1);
    await expect(registry.dispose()).rejects.toThrow('failed-client');
    expect(logger.error).toHaveBeenCalledWith('Could not dispose RPC connection failed-client', expect.any(Error));
  });

  test('retires a disconnected epoch after its bounded grace without leaking the child scope timer', async () => {
    expect.hasAssertions();
    jest.useFakeTimers();

    const logger = {
      error: jest.fn(),
      log: jest.fn(),
    } as unknown as INodeLogger;
    const registry = new ServerConnectionRegistry(logger, { disconnectGraceMs: 50 });
    const inboundIdle = createDeferred();
    const retireDisconnectedInbound = jest.fn();
    const disposeScope = jest.fn(async () => undefined);
    const channel = new WSChannel({ send: jest.fn() } as any, { id: 'disconnected-lease-channel' });

    try {
      registry.trackConnection(channel, 'disconnected-lease-client', disposeScope, {
        whenInboundIdle: () => inboundIdle.promise,
        retireDisconnectedInbound,
      });

      channel.close(1006, 'transport lost');
      registry.beginDrain();
      const disposal = registry.dispose();
      await Promise.resolve();
      expect(registry.activeConnectionCount).toBe(1);
      expect(retireDisconnectedInbound).not.toHaveBeenCalled();
      expect(disposeScope).not.toHaveBeenCalled();

      jest.advanceTimersByTime(49);
      await Promise.resolve();
      expect(retireDisconnectedInbound).not.toHaveBeenCalled();

      jest.advanceTimersByTime(1);
      await disposal;
      expect(retireDisconnectedInbound).toHaveBeenCalledTimes(1);
      expect(disposeScope).toHaveBeenCalledTimes(1);
      expect(registry.activeConnectionCount).toBe(0);
      expect(jest.getTimerCount()).toBe(0);

      // A late user promise still has a reaction attached, but it no longer
      // owns the registry scope or recreates a timer when it settles.
      inboundIdle.resolve();
      await Promise.resolve();
      expect(disposeScope).toHaveBeenCalledTimes(1);
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  test('releases a naturally disconnected registry entry when child cleanup itself exceeds the shared lease', async () => {
    expect.hasAssertions();
    jest.useFakeTimers();

    const logger = {
      error: jest.fn(),
      log: jest.fn(),
    } as unknown as INodeLogger;
    const registry = new ServerConnectionRegistry(logger, { disconnectGraceMs: 25 });
    const childCleanup = createDeferred();
    const childCleanupStarted = createDeferred();
    const retireDisconnectedScope = jest.fn();
    const disposeScope = jest.fn(() => {
      childCleanupStarted.resolve();
      return childCleanup.promise;
    });
    const channel = new WSChannel({ send: jest.fn() } as any, { id: 'stuck-child-cleanup-channel' });

    try {
      registry.trackConnection(channel, 'stuck-child-cleanup-client', disposeScope, {
        whenInboundIdle: () => Promise.resolve(),
        retireDisconnectedScope,
      });

      channel.close(1006, 'transport lost');
      await childCleanupStarted.promise;
      expect(disposeScope).toHaveBeenCalledTimes(1);
      expect(registry.activeConnectionCount).toBe(1);

      jest.advanceTimersByTime(25);
      await registry.waitForIdle();

      expect(retireDisconnectedScope).toHaveBeenCalledTimes(1);
      expect(registry.activeConnectionCount).toBe(0);
      expect(jest.getTimerCount()).toBe(0);

      const lateCleanupError = new Error('late child cleanup failed');
      childCleanup.reject(lateCleanupError);
      await Promise.resolve();
      await Promise.resolve();
      expect(logger.error).toHaveBeenCalledWith(
        'Could not dispose retired RPC connection stuck-child-cleanup-client',
        lateCleanupError,
      );
    } finally {
      jest.useRealTimers();
    }
  });

  test('does not downgrade a graceful-shutdown-owned scope when its peer disconnects later', async () => {
    expect.hasAssertions();
    jest.useFakeTimers();

    const logger = {
      error: jest.fn(),
      log: jest.fn(),
    } as unknown as INodeLogger;
    const registry = new ServerConnectionRegistry(logger, { disconnectGraceMs: 10 });
    const inboundIdle = createDeferred();
    const retireDisconnectedInbound = jest.fn();
    const retireDisconnectedScope = jest.fn();
    const scopeCleanup = createDeferred();
    const scopeCleanupStarted = createDeferred();
    const disposeScope = jest.fn(() => {
      scopeCleanupStarted.resolve();
      return scopeCleanup.promise;
    });
    const channel = new WSChannel({ send: jest.fn() } as any, { id: 'live-graceful-channel' });

    try {
      registry.trackConnection(channel, 'live-graceful-client', disposeScope, {
        whenInboundIdle: () => inboundIdle.promise,
        retireDisconnectedInbound,
        retireDisconnectedScope,
      });
      registry.beginDrain();
      channel.close(1006, 'peer disconnected during shutdown');
      const disposal = registry.dispose();
      await Promise.resolve();

      jest.advanceTimersByTime(10_000);
      await Promise.resolve();
      expect(retireDisconnectedInbound).not.toHaveBeenCalled();
      expect(retireDisconnectedScope).not.toHaveBeenCalled();
      expect(disposeScope).not.toHaveBeenCalled();
      expect(registry.activeConnectionCount).toBe(1);
      expect(jest.getTimerCount()).toBe(0);

      inboundIdle.resolve();
      await scopeCleanupStarted.promise;
      expect(disposeScope).toHaveBeenCalledTimes(1);
      expect(registry.activeConnectionCount).toBe(1);

      jest.advanceTimersByTime(10_000);
      await Promise.resolve();
      expect(retireDisconnectedInbound).not.toHaveBeenCalled();
      expect(retireDisconnectedScope).not.toHaveBeenCalled();
      expect(registry.activeConnectionCount).toBe(1);

      scopeCleanup.resolve();
      await disposal;
      expect(retireDisconnectedInbound).not.toHaveBeenCalled();
      expect(retireDisconnectedScope).not.toHaveBeenCalled();
      expect(disposeScope).toHaveBeenCalledTimes(1);
      expect(registry.activeConnectionCount).toBe(0);
      expect(logger.error).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});
