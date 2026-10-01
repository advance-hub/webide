import { ChannelMessage, ErrorMessageCode } from '../../src/common/channel/types';
import { IConnectionShape } from '../../src/common/connection/types';
import { furySerializer } from '../../src/common/serializer';
import {
  BaseCommonChannelHandler,
  CommonChannelPathHandler,
  LOGICAL_CHANNEL_OPEN_DRAINING,
  rejectLogicalChannel,
} from '../../src/common/server-handler';

import type { WSChannel, WSServerChannel } from '../../src/common/ws-channel';

type AssertTrue<T extends true> = T;
type IsExactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;

class LegacyCommonChannelPathHandler extends CommonChannelPathHandler {
  override openChannel(path: string, channel: WSChannel, clientId: string): void {
    super.openChannel(path, channel, clientId);
  }
}

const legacyOpenChannelReturnRemainsVoid: AssertTrue<
  IsExactly<ReturnType<CommonChannelPathHandler['openChannel']>, void>
> = true;

class TestConnection implements IConnectionShape<Uint8Array> {
  private closeListeners: Array<() => void> = [];

  private messageListeners: Array<(message: Uint8Array) => void> = [];

  sentMessages: ChannelMessage[] = [];

  send(message: Uint8Array) {
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

  close() {
    this.closeListeners.forEach((listener) => listener());
  }

  message(message: ChannelMessage) {
    const serialized = furySerializer.serialize(message);
    this.messageListeners.forEach((listener) => listener(serialized));
  }
}

class TestChannelHandler extends BaseCommonChannelHandler {
  heartbeats: IConnectionShape<Uint8Array>[] = [];

  constructor(pathHandler: CommonChannelPathHandler) {
    super('test-channel-handler', pathHandler, { log() {}, warn() {}, error() {} }, { heartbeatInterval: 1_000 });
  }

  doHeartbeat(connection: IConnectionShape<Uint8Array>): void {
    this.heartbeats.push(connection);
  }

  get channels(): WSServerChannel[] {
    return Array.from(this.channelMap.values());
  }
}

describe('CommonChannelPathHandler', () => {
  it('keeps the legacy void openChannel override source compatible', () => {
    expect.assertions(2);
    expect(legacyOpenChannelReturnRemainsVoid).toBe(true);
    expect(new LegacyCommonChannelPathHandler()).toBeInstanceOf(CommonChannelPathHandler);
  });

  it('basic', () => {
    expect.hasAssertions();
    const handler = new CommonChannelPathHandler();

    let channelOpened = false;
    let channelOpenParams = {} as any;
    let channelDisposed = false;
    handler.register('test/:id', {
      handler(channel, connectionId, params) {
        channelOpened = true;
        channelOpenParams = params;
      },
      dispose() {
        channelDisposed = true;
      },
    });

    const result = handler.getAll();
    expect(result.length).toBe(1);
    expect(result[0].length).toBe(1);

    const params = handler.getParams('test', 'a');
    expect(params).toEqual({
      id: 'a',
    });

    handler.openChannel('test/artin', {} as any, 'test_client_id');
    expect(channelOpened).toBeTruthy();
    expect(channelOpenParams).toEqual({
      id: 'artin',
    });

    handler.disposeConnectionClientId({} as any, 'test_client_id');
    expect(channelDisposed).toBeTruthy();
  });

  it('heartbeats every active connection without replacing earlier connections', () => {
    expect.hasAssertions();
    jest.useFakeTimers();
    const handler = new TestChannelHandler(new CommonChannelPathHandler());
    const first = new TestConnection();
    const second = new TestConnection();

    try {
      handler.receiveConnection(first);
      handler.receiveConnection(second);
      jest.advanceTimersByTime(1_000);

      expect(handler.heartbeats).toEqual([first, second]);

      first.close();
      jest.advanceTimersByTime(1_000);
      expect(handler.heartbeats).toEqual([first, second, second]);

      second.close();
      jest.advanceTimersByTime(2_000);
      expect(handler.heartbeats).toHaveLength(3);
    } finally {
      handler.dispose();
      jest.useRealTimers();
    }
  });

  it('rejects only the explicit drain sentinel and preserves legacy handler return values', () => {
    expect.hasAssertions();
    const pathHandler = new CommonChannelPathHandler();
    const handler = new TestChannelHandler(pathHandler);
    const connection = new TestConnection();
    let disposeSpy: jest.SpyInstance | undefined;

    pathHandler.register('legacy-boolean', {
      handler: (channel) => {
        disposeSpy = jest.spyOn(channel, 'dispose');
        return false;
      },
      dispose() {},
    });

    try {
      handler.receiveConnection(connection);
      connection.message({
        kind: 'open',
        id: 'rejected-channel',
        path: 'legacy-boolean',
        clientId: 'rejected-client',
        traceId: 'rejected-trace',
      });

      expect(disposeSpy).not.toHaveBeenCalled();
      expect(handler.channels).toHaveLength(1);
      expect(connection.sentMessages).toContainEqual(
        expect.objectContaining({ kind: 'server-ready', id: 'rejected-channel' }),
      );

      pathHandler.register('draining', {
        handler: () => LOGICAL_CHANNEL_OPEN_DRAINING,
        dispose() {},
      });
      connection.message({
        kind: 'open',
        id: 'draining-sentinel-channel',
        path: 'draining',
        clientId: 'rejected-client',
        traceId: 'draining-trace',
      });
      expect(handler.channels).toHaveLength(1);
      expect(connection.sentMessages).toContainEqual({
        kind: 'error',
        id: 'draining-sentinel-channel',
        code: ErrorMessageCode.ChannelDraining,
        message: 'server is draining',
      });
    } finally {
      handler.dispose();
    }
  });

  it('preserves the precise reason from an explicit logical channel rejection', () => {
    expect.hasAssertions();
    const pathHandler = new CommonChannelPathHandler();
    const handler = new TestChannelHandler(pathHandler);
    const connection = new TestConnection();
    const rejectionReason = 'workspace preflight rejected this connection';

    pathHandler.register('preflight', {
      handler: () => rejectLogicalChannel(rejectionReason),
      dispose() {},
    });

    try {
      handler.receiveConnection(connection);
      connection.message({
        kind: 'open',
        id: 'preflight-channel',
        path: 'preflight',
        clientId: 'preflight-client',
        traceId: 'preflight-trace',
      });

      expect(handler.channels).toHaveLength(0);
      expect(connection.sentMessages).toEqual([
        {
          kind: 'error',
          id: 'preflight-channel',
          code: ErrorMessageCode.ChannelDraining,
          message: rejectionReason,
        },
      ]);
    } finally {
      handler.dispose();
    }
  });

  it('acknowledges legacy handlers and paths without a registered handler', () => {
    expect.hasAssertions();
    const pathHandler = new CommonChannelPathHandler();
    const handler = new TestChannelHandler(pathHandler);
    const connection = new TestConnection();

    pathHandler.register('legacy', {
      handler() {},
      dispose() {},
    });

    try {
      handler.receiveConnection(connection);
      connection.message({
        kind: 'open',
        id: 'legacy-channel',
        path: 'legacy',
        clientId: 'legacy-client',
        traceId: 'legacy-trace',
      });
      connection.message({
        kind: 'open',
        id: 'unregistered-channel',
        path: 'unregistered',
        clientId: 'legacy-client',
        traceId: 'unregistered-trace',
      });

      expect(connection.sentMessages).toEqual([
        {
          kind: 'server-ready',
          id: 'legacy-channel',
          traceId: 'legacy-trace',
        },
        {
          kind: 'server-ready',
          id: 'unregistered-channel',
          traceId: 'unregistered-trace',
        },
      ]);
      expect(handler.channels).toHaveLength(2);
    } finally {
      handler.dispose();
    }
  });

  it('rejects logical opens during drain before invoking the path handler', () => {
    expect.hasAssertions();
    const pathHandler = new CommonChannelPathHandler();
    const handler = new TestChannelHandler(pathHandler);
    const connection = new TestConnection();
    const extMainThreadHandler = jest.fn();
    pathHandler.register('ExtMainThreadConnection', {
      handler: extMainThreadHandler,
      dispose() {},
    });

    try {
      handler.receiveConnection(connection);
      handler.beginDrain();
      handler.beginDrain();
      connection.message({
        kind: 'open',
        id: 'draining-channel',
        path: 'ExtMainThreadConnection',
        clientId: 'draining-client',
        traceId: 'draining-trace',
      });

      expect(extMainThreadHandler).not.toHaveBeenCalled();
      expect(handler.channels).toHaveLength(0);
      expect(connection.sentMessages).toEqual([
        {
          kind: 'error',
          id: 'draining-channel',
          code: ErrorMessageCode.ChannelDraining,
          message: 'server is draining',
        },
      ]);
      expect(connection.sentMessages).not.toContainEqual(expect.objectContaining({ kind: 'server-ready' }));
    } finally {
      handler.dispose();
    }
  });

  it('rejects an empty client id before invoking a path handler or allocating a logical channel', () => {
    expect.hasAssertions();
    const pathHandler = new CommonChannelPathHandler();
    const handler = new TestChannelHandler(pathHandler);
    const connection = new TestConnection();
    const rpcHandler = jest.fn();
    const rpcDispose = jest.fn();
    pathHandler.register('RPCService', {
      handler: rpcHandler,
      dispose: rpcDispose,
    });

    try {
      handler.receiveConnection(connection);
      connection.message({
        kind: 'open',
        id: 'empty-client-id-channel',
        path: 'RPCService',
        clientId: '   ',
        traceId: 'empty-client-id-trace',
      });

      expect(rpcHandler).not.toHaveBeenCalled();
      expect(handler.channels).toHaveLength(0);
      expect(connection.sentMessages).toEqual([
        {
          kind: 'error',
          id: 'empty-client-id-channel',
          code: ErrorMessageCode.ChannelDraining,
          message: 'invalid client id',
        },
      ]);
      expect(connection.sentMessages).not.toContainEqual(expect.objectContaining({ kind: 'server-ready' }));
      connection.close();
      expect(rpcDispose).not.toHaveBeenCalled();
    } finally {
      handler.dispose();
    }
  });

  it('binds one client identity to a physical connection and rejects logical channels for another client', () => {
    expect.hasAssertions();
    const pathHandler = new CommonChannelPathHandler();
    const handler = new TestChannelHandler(pathHandler);
    const connection = new TestConnection();
    const rpcHandler = jest.fn();
    const rpcDispose = jest.fn();
    pathHandler.register('RPCService', {
      handler: rpcHandler,
      dispose: rpcDispose,
    });

    try {
      handler.receiveConnection(connection);
      connection.message({
        kind: 'open',
        id: 'client-a-first-channel',
        path: 'RPCService',
        clientId: 'client-a',
        traceId: 'client-a-first-trace',
      });

      expect(rpcHandler).toHaveBeenCalledTimes(1);
      expect(handler.channels).toHaveLength(1);

      connection.message({
        kind: 'open',
        id: 'client-b-channel',
        path: 'RPCService',
        clientId: 'client-b',
        traceId: 'client-b-trace',
      });

      expect(rpcHandler).toHaveBeenCalledTimes(1);
      expect(handler.channels).toHaveLength(1);
      expect(connection.sentMessages).toContainEqual({
        kind: 'error',
        id: 'client-b-channel',
        code: ErrorMessageCode.ChannelDraining,
        message: 'physical connection client id mismatch',
      });
      expect(connection.sentMessages).not.toContainEqual(
        expect.objectContaining({ kind: 'server-ready', id: 'client-b-channel' }),
      );

      connection.message({
        kind: 'open',
        id: 'client-a-second-channel',
        path: 'RPCService',
        clientId: 'client-a',
        traceId: 'client-a-second-trace',
      });

      expect(rpcHandler).toHaveBeenCalledTimes(2);
      expect(rpcHandler.mock.calls.map(([, clientId]) => clientId)).toEqual(['client-a', 'client-a']);
      expect(handler.channels).toHaveLength(2);
      expect(connection.sentMessages).toContainEqual({
        kind: 'server-ready',
        id: 'client-a-second-channel',
        traceId: 'client-a-second-trace',
      });

      connection.close();
      expect(handler.channels).toHaveLength(0);
      expect(rpcDispose).toHaveBeenCalledTimes(1);
      expect(rpcDispose.mock.calls.map(([, clientId]) => clientId)).toEqual(['client-a']);
    } finally {
      handler.dispose();
    }
  });

  it('keeps a replacement channel when the old physical connection closes later', () => {
    expect.hasAssertions();
    const pathHandler = new CommonChannelPathHandler();
    const handler = new TestChannelHandler(pathHandler);
    const first = new TestConnection();
    const replacement = new TestConnection();
    const openedChannels: WSServerChannel[] = [];
    const disposedClientIds: string[] = [];

    pathHandler.register('RPCService', {
      handler: (channel) => {
        openedChannels.push(channel as WSServerChannel);
      },
      dispose: (_channel, clientId) => disposedClientIds.push(clientId),
    });

    try {
      handler.receiveConnection(first);
      first.message({
        kind: 'open',
        id: 'same-client:RPCService',
        path: 'RPCService',
        clientId: 'same-client',
        traceId: 'first',
      });

      handler.receiveConnection(replacement);
      replacement.message({
        kind: 'open',
        id: 'same-client:RPCService',
        path: 'RPCService',
        clientId: 'same-client',
        traceId: 'replacement',
      });

      expect(handler.channels).toEqual([openedChannels[1]]);
      first.close();
      expect(handler.channels).toEqual([openedChannels[1]]);
      expect(disposedClientIds).toEqual([]);

      replacement.close();
      expect(handler.channels).toHaveLength(0);
      expect(disposedClientIds).toEqual(['same-client']);
    } finally {
      handler.dispose();
    }
  });

  it('removes parameterized handlers without leaving a stale route entry', () => {
    expect.hasAssertions();
    const pathHandler = new CommonChannelPathHandler();
    const routeHandler = {
      handler() {},
      dispose() {},
    };
    pathHandler.register('test/:id', routeHandler);

    pathHandler.removeHandler('test/:id', routeHandler);

    expect(pathHandler.get('test')).toBeUndefined();
    expect(pathHandler.getAll()).toEqual([]);
  });
});
