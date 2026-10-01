import { ChannelMessage, ErrorMessageCode } from './channel/types';
import { IConnectionShape } from './connection/types';
import { furySerializer, wrapSerializer } from './serializer';
import { ISerializer } from './serializer/types';
import { ILogger } from './types';
import { WSChannel, WSServerChannel } from './ws-channel';

import type { Injector } from '@opensumi/di';

export interface IPathHandler {
  dispose: (channel: WSChannel, connectionId: string) => void;
  /**
   * Legacy handlers may return arbitrary values; they are ignored unless they
   * use the explicit drain sentinel or rejectLogicalChannel() below.
   */
  handler: (channel: WSChannel, connectionId: string, params?: Record<string, string>) => void;
  reconnect?: (channel: WSChannel, connectionId: string) => void;
}

/** Unforgeable result used only by an admission handler that lost a drain race. */
export const LOGICAL_CHANNEL_OPEN_DRAINING = Symbol('LOGICAL_CHANNEL_OPEN_DRAINING');

const logicalChannelOpenRejection = Symbol('logicalChannelOpenRejection');

export interface LogicalChannelOpenRejection {
  readonly reason: string;
  readonly [logicalChannelOpenRejection]: true;
}

/** Reject one logical open with a stable reason without changing the legacy void handler API. */
export function rejectLogicalChannel(reason: string): LogicalChannelOpenRejection {
  return { [logicalChannelOpenRejection]: true, reason };
}

interface LogicalChannelAdmission {
  admitted: boolean;
  reason?: string;
}

const logicalChannelAdmissionObservers = new WeakMap<
  CommonChannelPathHandler,
  Array<(admission: LogicalChannelAdmission) => void>
>();

function isLogicalChannelOpenRejection(result: unknown): result is LogicalChannelOpenRejection {
  return (
    typeof result === 'object' &&
    result !== null &&
    (result as Partial<LogicalChannelOpenRejection>)[logicalChannelOpenRejection] === true
  );
}

function openChannelWithAdmission(
  pathHandler: CommonChannelPathHandler,
  path: string,
  channel: WSChannel,
  clientId: string,
): LogicalChannelAdmission {
  let admission: LogicalChannelAdmission = { admitted: true };
  const observeAdmission = (result: LogicalChannelAdmission) => {
    if (!result.admitted) {
      admission = result;
    }
  };
  const observers = logicalChannelAdmissionObservers.get(pathHandler) ?? [];
  if (observers.length === 0) {
    logicalChannelAdmissionObservers.set(pathHandler, observers);
  }
  observers.push(observeAdmission);
  try {
    pathHandler.openChannel(path, channel, clientId);
    return admission;
  } finally {
    observers.pop();
    if (observers.length === 0) {
      logicalChannelAdmissionObservers.delete(pathHandler);
    }
  }
}

export class CommonChannelPathHandler {
  private handlerMap: Map<string, IPathHandler[]> = new Map();
  private paramsKey: Map<string, string> = new Map();

  register(channelPath: string, handler: IPathHandler) {
    const paramsIndex = channelPath.indexOf('/:');
    const hasParams = paramsIndex >= 0;
    let channelToken = channelPath;
    if (hasParams) {
      channelToken = channelPath.slice(0, paramsIndex);
      this.paramsKey.set(channelToken, channelPath.slice(paramsIndex + 2));
    }
    if (!this.handlerMap.has(channelToken)) {
      this.handlerMap.set(channelToken, []);
    }
    const handlerArr = this.handlerMap.get(channelToken) as IPathHandler[];
    const handlerFn = handler.handler.bind(handler);
    const setHandler = (channel: WSChannel, clientId: string, params: any) => handlerFn(channel, clientId, params);
    handler.handler = setHandler;
    handlerArr.push(handler);
    this.handlerMap.set(channelToken, handlerArr);
  }
  getParams(channelPath: string, value: string): Record<string, string> {
    const params = {} as Record<string, string>;
    if (this.paramsKey.has(channelPath)) {
      const key = this.paramsKey.get(channelPath);
      if (key) {
        params[key] = value;
      }
    }
    return params;
  }
  removeHandler(channelPath: string, handler: IPathHandler) {
    const paramsIndex = channelPath.indexOf('/:');
    const hasParams = paramsIndex >= 0;
    const channelToken = hasParams ? channelPath.slice(0, paramsIndex) : channelPath;
    const handlerArr = this.handlerMap.get(channelToken) || [];
    const removeIndex = handlerArr.indexOf(handler);
    if (removeIndex !== -1) {
      handlerArr.splice(removeIndex, 1);
    }
    if (handlerArr.length === 0) {
      this.handlerMap.delete(channelToken);
      this.paramsKey.delete(channelToken);
    } else {
      this.handlerMap.set(channelToken, handlerArr);
    }
  }
  get(channelPath: string) {
    return this.handlerMap.get(channelPath);
  }
  disposeConnectionClientId(channel: any, clientId: string) {
    this.handlerMap.forEach((handlerArr: IPathHandler[]) => {
      handlerArr.forEach((handler: IPathHandler) => {
        handler.dispose(channel, clientId);
      });
    });
  }
  openChannel(path: string, channel: WSChannel, clientId: string): void {
    const admission = this.dispatchOpenChannel(path, channel, clientId);
    if (!admission.admitted) {
      const observers = logicalChannelAdmissionObservers.get(this);
      observers?.[observers.length - 1]?.(admission);
    }
  }

  private dispatchOpenChannel(path: string, channel: WSChannel, clientId: string): LogicalChannelAdmission {
    // 根据 path 拿到注册的 handler
    let handlerArr = this.get(path);
    let params: Record<string, string> | undefined;
    // 尝试通过父路径查找处理函数，如server/:id方式注册的handler
    if (!handlerArr) {
      const slashIndex = path.indexOf('/');
      const hasSlash = slashIndex >= 0;
      if (hasSlash) {
        handlerArr = this.get(path.slice(0, slashIndex));
        params = this.getParams(path.slice(0, slashIndex), path.slice(slashIndex + 1));
      }
    }

    if (handlerArr) {
      for (let i = 0, len = handlerArr.length; i < len; i++) {
        const handler = handlerArr[i];
        // Keep the public legacy signature as `void`, but observe the runtime
        // value so the internal admission handler can return its sentinel.
        const result = handler.handler(channel, clientId, params) as unknown;
        if (result === LOGICAL_CHANNEL_OPEN_DRAINING) {
          return { admitted: false, reason: 'server is draining' };
        }
        if (isLogicalChannelOpenRejection(result)) {
          return { admitted: false, reason: result.reason };
        }
      }
    }
    return { admitted: true };
  }

  getAll() {
    return Array.from(this.handlerMap.values());
  }
}

export interface ChannelHandlerOptions {
  serializer?: ISerializer<ChannelMessage, any>;
  heartbeatInterval?: number;
}

enum ServerChannelCloseCode {
  ConnectionClosed = 1,
  NewChannelOpened = 2,
}

export abstract class BaseCommonChannelHandler {
  protected channelMap: Map<string, WSServerChannel> = new Map();

  private acceptingLogicalChannels = true;

  private readonly connections = new Set<IConnectionShape<Uint8Array>>();

  private heartbeatTimer: NodeJS.Timeout | null = null;

  private readonly heartbeatInterval: number;

  serializer: ISerializer<ChannelMessage, any> = furySerializer;
  constructor(
    public handlerId: string,
    protected commonChannelPathHandler: CommonChannelPathHandler,
    protected logger: ILogger = console,
    options: ChannelHandlerOptions = {},
  ) {
    if (options.serializer) {
      this.serializer = options.serializer;
    }
    this.heartbeatInterval = options.heartbeatInterval ?? 30_000;
  }

  abstract doHeartbeat(connection: any): void;

  /** Reject every subsequent logical open before a path handler can run. */
  beginDrain(): void {
    this.acceptingLogicalChannels = false;
  }

  private startHeartbeat() {
    if (this.heartbeatTimer || this.heartbeatInterval <= 0) {
      return;
    }

    this.heartbeatTimer = setInterval(() => {
      this.connections.forEach((connection) => {
        try {
          this.doHeartbeat(connection);
        } catch (error) {
          this.logger.error('connection heartbeat failed', error);
        }
      });
    }, this.heartbeatInterval);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeatIfIdle() {
    if (this.connections.size === 0 && this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  receiveConnection(connection: IConnectionShape<Uint8Array>) {
    // A physical transport owns exactly one immutable session identity. Every
    // logical channel, including topology preflight and Extension Main Thread,
    // must use that same id; otherwise a caller could attach a privileged
    // channel to another session after opening an ordinary RPC channel.
    let clientId: string | undefined;
    this.connections.add(connection);
    this.startHeartbeat();

    const wrappedConnection = wrapSerializer(connection, this.serializer);

    wrappedConnection.onMessage((msg: ChannelMessage) => {
      try {
        switch (msg.kind) {
          case 'open': {
            const { id, path, traceId } = msg;
            const requestedClientId = msg.clientId;

            if (typeof requestedClientId !== 'string' || requestedClientId.trim().length === 0) {
              wrappedConnection.send({
                kind: 'error',
                id,
                code: ErrorMessageCode.ChannelDraining,
                message: 'invalid client id',
              });
              break;
            }
            if (clientId !== undefined && requestedClientId !== clientId) {
              this.logger.error(
                `Reject logical channel ${path}: physical connection is bound to ${clientId}, got ${requestedClientId}`,
              );
              wrappedConnection.send({
                kind: 'error',
                id,
                code: ErrorMessageCode.ChannelDraining,
                message: 'physical connection client id mismatch',
              });
              break;
            }
            clientId ??= requestedClientId;

            if (!this.acceptingLogicalChannels) {
              wrappedConnection.send({
                kind: 'error',
                id,
                code: ErrorMessageCode.ChannelDraining,
                message: 'server is draining',
              });
              break;
            }

            this.logger.log(`open a new connection channel ${clientId} with path ${path}`);
            let channel = this.channelMap.get(id);
            if (channel) {
              channel.close(ServerChannelCloseCode.NewChannelOpened, 'new channel opened for the same channel id');
              channel.dispose();
            }

            channel = new WSServerChannel(wrappedConnection, { id, clientId, logger: this.logger });
            this.channelMap.set(id, channel);
            const admission = openChannelWithAdmission(this.commonChannelPathHandler, path, channel, clientId);
            if (!admission.admitted) {
              if (this.channelMap.get(id) === channel) {
                this.channelMap.delete(id);
              }
              channel.dispose();
              wrappedConnection.send({
                kind: 'error',
                id,
                code: ErrorMessageCode.ChannelDraining,
                message: admission.reason ?? 'server is draining',
              });
              break;
            }
            channel.serverReady(traceId);
            break;
          }
          default: {
            const { id } = msg;

            const channel = this.channelMap.get(id);
            if (channel) {
              channel.dispatch(msg);
            } else {
              wrappedConnection.send({
                kind: 'error',
                id,
                code: ErrorMessageCode.ChannelNotFound,
                message: `channel ${id} not found`,
              });

              this.logger.warn(`channel ${id} is not found`);
            }
          }
        }
      } catch (e) {
        this.logger.error('handle connection message error', e);
      }
    });

    connection.onceClose(() => {
      this.connections.delete(connection);
      this.stopHeartbeatIfIdle();
      this.logger.log(`connection ${clientId ?? '<unidentified>'} is closed, dispose its channels`);

      Array.from(this.channelMap.values())
        // A reconnect reuses the same client/channel id. The old socket may
        // close after the replacement channel has opened, so ownership must be
        // checked by physical connection rather than client id.
        .filter((channel) => channel.connection === wrappedConnection)
        .forEach((channel) => {
          channel.close(ServerChannelCloseCode.ConnectionClosed, 'connection closed');
          channel.dispose();
          this.channelMap.delete(channel.id);
          this.logger.log(`Remove connection channel ${channel.id}`);
        });

      const hasReplacementChannel =
        clientId !== undefined && Array.from(this.channelMap.values()).some((channel) => channel.clientId === clientId);
      if (clientId !== undefined && !hasReplacementChannel) {
        this.commonChannelPathHandler.disposeConnectionClientId(connection, clientId);
      }
    });
  }

  dispose() {
    this.beginDrain();
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    this.channelMap.forEach((channel) => {
      channel.close(ServerChannelCloseCode.ConnectionClosed, 'channel handler disposed');
      channel.dispose();
    });
    this.channelMap.clear();
    this.connections.clear();
  }
}

export const RPCServiceChannelPath = 'RPCService';

export function injectConnectionProviders(injector: Injector) {
  const commonChannelPathHandler = new CommonChannelPathHandler();
  injector.addProviders({
    token: CommonChannelPathHandler,
    useValue: commonChannelPathHandler,
  });
}
