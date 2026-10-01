import { EventEmitter } from '@opensumi/events';
import { Barrier, Deferred, DisposableStore, IReporterService, MultiMap, REPORT_NAME } from '@opensumi/ide-core-common';

import { ChannelMessage } from '../common/channel/types';
import { IRuntimeSocketConnection } from '../common/connection';
import { IConnectionShape } from '../common/connection/types';
import { ISerializer, furySerializer, wrapSerializer } from '../common/serializer';
import { ConnectionInfo, ILogger, WSCloseInfo } from '../common/types';
import { WSChannel } from '../common/ws-channel';

export interface WSChannelHandlerOptions {
  logger?: ILogger;
  preflight?: WSChannelPreflight;
  serializer?: ISerializer<ChannelMessage, any>;
}

export interface WSChannelPreflight {
  channelPath: string;
  /**
   * Runs once per physical connection epoch before any normal logical channel.
   * Attach protocol listeners first, then call open() to start the handshake.
   */
  run(channel: WSChannel, open: () => Promise<void>, signal?: AbortSignal): Promise<void>;
  /**
   * Called only when a preflight that had succeeded on an earlier physical
   * epoch later fails. The handler has already made the transport terminal.
   */
  onFatalError?(error: unknown): void;
}

interface PhysicalConnectionEpoch {
  abortController: AbortController;
  id: number;
  invalidated: Deferred<void>;
}

interface PendingChannelOpen {
  deferred: Deferred<void>;
  epochId: number;
  promise: Promise<void>;
}

interface ManagedChannelState {
  channelPath: string;
  openCount: number;
  pendingOpen?: PendingChannelOpen;
}

class PhysicalConnectionEpochStaleError extends Error {
  constructor(readonly epochId: number) {
    super(`Physical connection epoch ${epochId} is no longer active`);
    this.name = 'PhysicalConnectionEpochStaleError';
  }
}

/**
 * Channel Handler in browser
 */
export class WSChannelHandler {
  private _disposables = new DisposableStore();

  private _onChannelCreatedEmitter = this._disposables.add(new EventEmitter<Record<string, [WSChannel]>>());

  wrappedConnection: IConnectionShape<ChannelMessage>;
  public onChannelCreated(path: string, listener: (channel: WSChannel) => void) {
    return this._onChannelCreatedEmitter.on(path, listener);
  }

  private channelMap: Map<string, WSChannel> = new Map();
  private channelStateMap = new WeakMap<WSChannel, ManagedChannelState>();
  private channelCloseEventMap = new MultiMap<string, WSCloseInfo>();
  private logger: ILogger = console;
  private readonly preflight?: WSChannelPreflight;
  public clientId: string;
  private heartbeatMessageTimer: NodeJS.Timeout | null;
  private reporterService: IReporterService;

  /**
   * 保证在连接建立后再执行后续操作
   */
  private openingBarrier = new Barrier();

  private epochSequence = 0;
  private activeEpoch?: PhysicalConnectionEpoch;
  private nextPhysicalEpoch = new Deferred<PhysicalConnectionEpoch>();
  private preflightTask?: { epochId: number; promise: Promise<void> };
  private reconnectTask?: { epochId: number; promise: Promise<void> };
  private hasCompletedPreflight = false;
  private fatalPreflightFailure = false;
  private disposed = false;

  LOG_TAG: string;

  constructor(
    public connection: IRuntimeSocketConnection<Uint8Array>,
    clientId: string,
    options: WSChannelHandlerOptions = {},
  ) {
    this.logger = options.logger || this.logger;
    this.preflight = options.preflight;
    this.clientId = clientId;
    this.LOG_TAG = `[WSChannelHandler] [client-id:${this.clientId}]`;
    const serializer = options.serializer || furySerializer;
    this.wrappedConnection = wrapSerializer(this.connection, serializer);
  }
  // 为解决建立连接之后，替换成可落盘的 logger
  replaceLogger(logger: any) {
    if (logger) {
      this.logger = logger;
    }
  }
  setReporter(reporterService: IReporterService) {
    this.reporterService = reporterService;
  }
  private heartbeatMessage() {
    if (this.heartbeatMessageTimer) {
      clearTimeout(this.heartbeatMessageTimer);
    }
    this.heartbeatMessageTimer = setTimeout(() => {
      this.channelMap.forEach((channel) => {
        channel.ping();
      });

      this.heartbeatMessage();
    }, 10 * 1000);
    (this.heartbeatMessageTimer as any).unref?.();
  }

  private stopHeartbeat() {
    if (this.heartbeatMessageTimer) {
      clearTimeout(this.heartbeatMessageTimer);
      this.heartbeatMessageTimer = null;
    }
  }

  public async initHandler() {
    this._disposables.add(
      this.wrappedConnection.onMessage((msg) => {
        // 一个心跳周期内如果有收到消息，则不需要再发送心跳
        this.heartbeatMessage();

        switch (msg.kind) {
          case 'pong':
            // pong 不需要分发, 不处理
            break;

          default: {
            const channel = this.channelMap.get(msg.id);
            if (channel) {
              channel.dispatch(msg);
            } else {
              this.logger.warn(this.LOG_TAG, `channel ${msg.id} not found`);
            }
          }
        }
      }),
    );

    this._disposables.add(
      this.connection.onClose((code, reason) => {
        this.stopHeartbeat();
        this.invalidatePhysicalEpoch();
        this.channelMap.forEach((channel) => {
          channel.close(code, reason);
        });
      }),
    );

    const handlePhysicalOpen = () => {
      this.heartbeatMessage();
      const isReconnect = this.openingBarrier.isOpen();
      const epoch = this.beginPhysicalEpoch();
      if (!isReconnect) {
        this.openingBarrier.open();
        return;
      }

      // Publish the epoch task before user preflight code can run. A transport
      // open listener may synchronously ask for another logical channel.
      const promise = Promise.resolve().then(() => this.reopenExistingChannels(epoch));
      this.reconnectTask = { epochId: epoch.id, promise };
      void promise
        .catch((error) => {
          if (!(error instanceof PhysicalConnectionEpochStaleError)) {
            this.logger.error(this.LOG_TAG, 'failed to restore logical channels', error);
          }
        })
        .finally(() => {
          if (this.reconnectTask?.promise === promise) {
            this.reconnectTask = undefined;
          }
        });
    };

    this._disposables.add(this.connection.onOpen(handlePhysicalOpen));

    // Register the callback first so a connection opening between isOpen()
    // and listener installation cannot strand initHandler forever.
    if (this.connection.isOpen() && !this.activeEpoch) {
      handlePhysicalOpen();
    }

    await this.openingBarrier.wait();
  }

  private beginPhysicalEpoch(): PhysicalConnectionEpoch {
    if (this.activeEpoch) {
      this.retirePhysicalEpoch(this.activeEpoch);
    }
    const epoch = {
      abortController: new AbortController(),
      id: ++this.epochSequence,
      invalidated: new Deferred<void>(),
    };
    this.activeEpoch = epoch;
    const waitingForEpoch = this.nextPhysicalEpoch;
    this.nextPhysicalEpoch = new Deferred<PhysicalConnectionEpoch>();
    waitingForEpoch.resolve(epoch);
    return epoch;
  }

  private invalidatePhysicalEpoch(): void {
    const epoch = this.activeEpoch;
    if (!epoch) {
      return;
    }
    this.activeEpoch = undefined;
    this.retirePhysicalEpoch(epoch);
  }

  private retirePhysicalEpoch(epoch: PhysicalConnectionEpoch): void {
    epoch.abortController.abort(new PhysicalConnectionEpochStaleError(epoch.id));
    epoch.invalidated.resolve();
  }

  private async waitForPhysicalEpoch(): Promise<PhysicalConnectionEpoch> {
    if (this.disposed) {
      throw new Error('WSChannelHandler is disposed');
    }
    return this.activeEpoch ?? this.nextPhysicalEpoch.promise;
  }

  private assertCurrentEpoch(epoch: PhysicalConnectionEpoch): void {
    if (this.disposed || this.activeEpoch !== epoch) {
      throw new PhysicalConnectionEpochStaleError(epoch.id);
    }
  }

  private waitWithinEpoch<T>(epoch: PhysicalConnectionEpoch, work: Promise<T>): Promise<T> {
    return Promise.race([
      work,
      epoch.invalidated.promise.then(() => {
        throw new PhysicalConnectionEpochStaleError(epoch.id);
      }),
    ]);
  }

  private async reopenExistingChannels(epoch: PhysicalConnectionEpoch): Promise<void> {
    const preflightPath = this.preflight?.channelPath;
    const channels = Array.from(this.channelMap.values()).filter(
      (channel) => this.channelStateMap.get(channel)?.channelPath !== preflightPath,
    );
    if (channels.length === 0) {
      return;
    }

    await this.ensurePreflight(epoch);
    for (const channel of channels) {
      this.assertCurrentEpoch(epoch);
      const state = this.channelStateMap.get(channel);
      if (!state || this.channelMap.get(this.fillKey(state.channelPath)) !== channel) {
        continue;
      }
      // Reopen in Map insertion order and wait for server-ready before the
      // next logical channel. RPC epochs must never race the preflight owner.
      await this.openManagedChannel(channel, epoch);
    }
  }

  private fillKey(channelPath: string) {
    return `${this.clientId}:${channelPath}`;
  }

  public getChannel(channelPath: string) {
    return this.channelMap.get(this.fillKey(channelPath));
  }

  public async openChannel(channelPath: string): Promise<WSChannel> {
    await this.openingBarrier.wait();
    const epoch = await this.waitForPhysicalEpoch();

    if (this.preflight?.channelPath === channelPath) {
      throw new Error(`Logical channel ${channelPath} is reserved for connection preflight`);
    }

    const reconnectTask = this.reconnectTask;
    if (reconnectTask?.epochId === epoch.id) {
      await this.waitWithinEpoch(epoch, reconnectTask.promise);
    }
    // A reconnect with no existing normal channels completes immediately;
    // the first new normal channel in that epoch still owns the preflight.
    await this.ensurePreflight(epoch);
    this.assertCurrentEpoch(epoch);

    const channel = this.createManagedChannel(channelPath);
    await this.openManagedChannel(channel, epoch);
    return channel;
  }

  private createManagedChannel(channelPath: string): WSChannel {
    const key = this.fillKey(channelPath);
    const existingChannel = this.channelMap.get(key);
    if (existingChannel) {
      const existingState = this.channelStateMap.get(existingChannel);
      existingState?.pendingOpen?.deferred.reject(new Error(`Logical channel ${key} was replaced`));
      existingChannel.dispose();
      this.logger.log(this.LOG_TAG, `channel ${key} already exists, dispose it`);
    }

    const channel = new WSChannel(this.wrappedConnection, {
      id: key,
      logger: this.logger,
      ensureServerReady: true,
    });
    const state: ManagedChannelState = { channelPath, openCount: 0 };
    this.channelStateMap.set(channel, state);
    this.channelMap.set(channel.id, channel);
    this._onChannelCreatedEmitter.emit(channelPath, channel);

    channel.onOpen(() => {
      const pendingOpen = state.pendingOpen;
      if (pendingOpen) {
        state.pendingOpen = undefined;
        pendingOpen.deferred.resolve();
      }

      state.openCount++;
      if (state.openCount > 1) {
        channel.fireReopen();
        this.logger.log(
          this.LOG_TAG,
          `channel reconnect ${this.clientId}:${state.channelPath}, count: ${state.openCount}`,
        );
      } else {
        this.logger.log(this.LOG_TAG, `channel open ${this.clientId}:${state.channelPath}`);
      }

      const closeInfo = this.channelCloseEventMap.get(channel.id);
      if (closeInfo) {
        closeInfo.forEach((info) => {
          this.reporterService &&
            this.reporterService.point(REPORT_NAME.CHANNEL_RECONNECT, REPORT_NAME.CHANNEL_RECONNECT, info);
        });

        this.channelCloseEventMap.delete(channel.id);
      }
    });

    channel.onClose((code: number, reason: string) => {
      const pendingOpen = state.pendingOpen;
      if (pendingOpen) {
        state.pendingOpen = undefined;
        pendingOpen.deferred.reject(new Error(reason || `Logical channel ${channel.id} closed before server-ready`));
      }
      this.channelCloseEventMap.set(channel.id, {
        channelPath,
        closeEvent: { code, reason },
        connectInfo: (navigator as any).connection as ConnectionInfo,
      });
      this.logger.log(this.LOG_TAG, `channel ${channelPath} closed, code: ${code}, reason: ${reason}`);
    });

    // Keep this listener for the channel's full lifetime. A channel can be
    // accepted initially and rejected only when a later physical reconnect
    // tries to reopen it after the server has entered drain.
    channel.onError((_code, message) => {
      const pendingOpen = state.pendingOpen;
      if (pendingOpen) {
        state.pendingOpen = undefined;
        pendingOpen.deferred.reject(new Error(message));
      }
      if (this.channelMap.get(channel.id) === channel) {
        this.channelMap.delete(channel.id);
      }
      channel.dispose();
    });

    return channel;
  }

  private openManagedChannel(channel: WSChannel, epoch: PhysicalConnectionEpoch): Promise<void> {
    this.assertCurrentEpoch(epoch);
    const state = this.channelStateMap.get(channel);
    if (!state) {
      return Promise.reject(new Error(`Logical channel ${channel.id} is not managed by this handler`));
    }
    if (state.pendingOpen?.epochId === epoch.id) {
      return state.pendingOpen.promise;
    }

    const deferred = new Deferred<void>();
    const pendingOpen: PendingChannelOpen = {
      deferred,
      epochId: epoch.id,
      promise: Promise.resolve(),
    };
    pendingOpen.promise = this.waitWithinEpoch(epoch, deferred.promise).finally(() => {
      if (state.pendingOpen === pendingOpen) {
        state.pendingOpen = undefined;
      }
    });
    state.pendingOpen = pendingOpen;

    try {
      channel.open(state.channelPath, this.clientId);
    } catch (error) {
      deferred.reject(error);
    }

    return pendingOpen.promise;
  }

  private disposeManagedChannel(channel: WSChannel, reason: string): void {
    const state = this.channelStateMap.get(channel);
    const pendingOpen = state?.pendingOpen;
    if (pendingOpen) {
      state.pendingOpen = undefined;
      pendingOpen.deferred.reject(new Error(reason));
    }
    if (this.channelMap.get(channel.id) === channel) {
      this.channelMap.delete(channel.id);
    }
    channel.dispose();
  }

  private ensurePreflight(epoch: PhysicalConnectionEpoch): Promise<void> {
    const preflight = this.preflight;
    if (!preflight) {
      return Promise.resolve();
    }
    if (this.preflightTask?.epochId === epoch.id) {
      return this.preflightTask.promise;
    }

    this.assertCurrentEpoch(epoch);
    // A preflight channel belongs to one physical epoch. Replacing it keeps
    // listeners installed by run() from accumulating across reconnects.
    const channel = this.createManagedChannel(preflight.channelPath);
    const completion = new Deferred<void>();
    const promise = this.waitWithinEpoch(epoch, completion.promise).catch((error) => {
      if (
        this.hasCompletedPreflight &&
        !this.fatalPreflightFailure &&
        !(error instanceof PhysicalConnectionEpochStaleError) &&
        this.activeEpoch === epoch
      ) {
        this.fatalPreflightFailure = true;
        this.dispose();
        try {
          this.connection.dispose();
        } catch (disposeError) {
          this.logger.error(this.LOG_TAG, 'failed to terminate rejected preflight transport', disposeError);
        }
        try {
          preflight.onFatalError?.(error);
        } catch (callbackError) {
          this.logger.error(this.LOG_TAG, 'preflight fatal-error callback failed', callbackError);
        }
      }
      throw error;
    });
    this.preflightTask = { epochId: epoch.id, promise };
    let openPromise: Promise<void> | undefined;
    const open = () => {
      this.assertCurrentEpoch(epoch);
      if (!openPromise) {
        openPromise = this.openManagedChannel(channel, epoch);
        // run() may intentionally not await open(); keep its failure observed
        // until the orchestration awaits it after run settles.
        void openPromise.catch(() => undefined);
      }
      return openPromise;
    };

    void Promise.resolve()
      .then(async () => {
        try {
          await preflight.run(channel, open, epoch.abortController.signal);
          if (openPromise) {
            await openPromise;
          }
          this.assertCurrentEpoch(epoch);
          this.hasCompletedPreflight = true;
        } finally {
          // The reserved channel is terminal once the epoch handshake settles.
          // Removing it keeps heartbeat and reconnect bookkeeping limited to
          // application channels; a newer epoch is protected by identity.
          this.disposeManagedChannel(channel, `Preflight for physical connection epoch ${epoch.id} settled`);
        }
      })
      .then(
        () => completion.resolve(),
        (error) => completion.reject(error),
      );
    return promise;
  }

  public dispose() {
    this.disposed = true;
    this.invalidatePhysicalEpoch();
    this.stopHeartbeat();
    this.channelMap.forEach((channel) => channel.dispose());
    this.channelMap.clear();
    this.channelCloseEventMap.keys.forEach((key) => this.channelCloseEventMap.delete(key));
    this._disposables.dispose();
  }

  awaitChannelReady(channelPath: string) {
    const channel = this.getChannel(channelPath);
    const deferred = new Deferred<void>();
    if (channel) {
      channel.onServerReady(() => {
        deferred.resolve();
      });
    } else {
      const dispose = this.onChannelCreated(channelPath, (channel) => {
        channel.onServerReady(() => {
          deferred.resolve();
        });
        dispose.dispose();
      });
    }
    return deferred.promise;
  }
}
