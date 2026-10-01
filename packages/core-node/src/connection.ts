import http from 'http';
import net from 'net';

import { ClassCreator, FactoryCreator, Injector, InstanceCreator } from '@opensumi/di';
import { RPCServiceCenter, WSChannel, initRPCService } from '@opensumi/ide-connection';
import { ElectronChannelHandler, MultiplexElectronChannelHandler } from '@opensumi/ide-connection/electron';
import { CommonChannelHandler, WebSocketHandler, WebSocketServerRoute } from '@opensumi/ide-connection/node';
import {
  CommonChannelPathHandler,
  LOGICAL_CHANNEL_OPEN_DRAINING,
  RPCServiceChannelPath,
  rejectLogicalChannel,
} from '@opensumi/ide-connection/server';
import {
  CLIENT_ID_TOKEN,
  RemoteService,
  getRemoteServiceData,
  injectSessionDataStores,
  runInRemoteServiceContext,
} from '@opensumi/ide-core-common';

import { INodeLogger } from './logger/node-logger';
import { NodeModule } from './node-module';
import {
  IConnectionScopeRetirement,
  IRuntimeTopologyHandshakeServer,
  IServerAppOpts,
  IServerConnectionRegistry,
  ServerConnectionDrainHooks,
} from './types';

export { RPCServiceCenter };

interface TrackedConnectionScope {
  channel: WSChannel;
  clientId: string;
  beginDrain: () => void;
  whenInboundIdle: () => Promise<void>;
  retireDisconnectedInbound: () => void;
  retireDisconnectedScope: () => void;
  disconnectedAt?: number;
  naturallyDisconnected: boolean;
  disconnectedEpochRetired: boolean;
  disconnectInitiatedByRegistry: boolean;
  drainStarted: boolean;
  channelClosed: boolean;
  dispose: () => Promise<void>;
  disposalStarted: boolean;
  releaseOwner?: 'natural-disconnect' | 'registry';
}

interface TrackedConnectionTransport {
  beginDrain: () => void;
  dispose: () => void;
  drainStarted: boolean;
}

interface ConnectionDisposalFailure {
  clientId: string;
  error: unknown;
}

export class ConnectionScopeRetirement implements IConnectionScopeRetirement {
  private resolveRetired!: () => void;
  private _retired = false;
  readonly whenRetired = new Promise<void>((resolve) => {
    this.resolveRetired = resolve;
  });

  get retired(): boolean {
    return this._retired;
  }

  retire(): void {
    if (this._retired) {
      return;
    }
    this._retired = true;
    this.resolveRetired();
  }
}

export class ServerConnectionDisposalError extends Error {
  constructor(readonly failures: readonly ConnectionDisposalFailure[]) {
    super(
      `Failed to dispose ${failures.length} server connection resource${failures.length === 1 ? '' : 's'}: ${failures
        .map(({ clientId }) => clientId)
        .join(', ')}`,
    );
    this.name = 'ServerConnectionDisposalError';
  }
}

export class ServerConnectionRegistry implements IServerConnectionRegistry {
  static readonly DEFAULT_DISCONNECT_GRACE_MS = 1_000;

  private readonly scopes = new Map<WSChannel, TrackedConnectionScope>();
  private readonly idleWaiters = new Set<{ reject: (error: Error) => void; resolve: () => void }>();
  private readonly transports = new Set<TrackedConnectionTransport>();
  private readonly disposalFailures: ConnectionDisposalFailure[] = [];
  private draining = false;
  private releasingConnections = false;
  private disposePromise?: Promise<void>;

  private readonly disconnectGraceMs: number;

  constructor(
    private readonly logger: INodeLogger,
    options: { disconnectGraceMs?: number } = {},
  ) {
    const configuredGrace = options.disconnectGraceMs ?? ServerConnectionRegistry.DEFAULT_DISCONNECT_GRACE_MS;
    this.disconnectGraceMs = Number.isFinite(configuredGrace) ? Math.max(0, configuredGrace) : 0;
  }

  get activeConnectionCount(): number {
    return this.scopes.size;
  }

  get acceptsConnections(): boolean {
    return !this.draining && !this.disposePromise;
  }

  registerTransportDisposer(dispose: () => void, beginDrain: () => void = () => undefined): void {
    const transport = { beginDrain, dispose, drainStarted: false };
    if (this.draining) {
      this.beginTransportDrain(transport);
    }
    if (this.releasingConnections || this.disposePromise) {
      this.disposeTransport(transport.dispose);
      return;
    }
    this.transports.add(transport);
  }

  trackConnection(
    channel: WSChannel,
    clientId: string,
    dispose: () => Promise<void>,
    drainHooks: ServerConnectionDrainHooks = {},
  ): boolean {
    const scope: TrackedConnectionScope = {
      channel,
      clientId,
      beginDrain: drainHooks.beginDrain ?? (() => undefined),
      whenInboundIdle: drainHooks.whenInboundIdle ?? (() => Promise.resolve()),
      retireDisconnectedInbound: drainHooks.retireDisconnectedInbound ?? (() => undefined),
      retireDisconnectedScope: drainHooks.retireDisconnectedScope ?? (() => undefined),
      naturallyDisconnected: false,
      disconnectedEpochRetired: false,
      disconnectInitiatedByRegistry: false,
      drainStarted: false,
      channelClosed: false,
      dispose,
      disposalStarted: false,
    };

    if (!this.acceptsConnections) {
      // A synchronously re-entrant drain can race with scope construction. Keep
      // that rejected scope visible until its resources have actually settled.
      this.scopes.set(channel, scope);
      this.closeChannel(scope);
      void this.releaseConnection(scope);
      return false;
    }

    this.scopes.set(channel, scope);
    channel.onceClose(() => {
      this.markScopeDisconnected(scope, !scope.disconnectInitiatedByRegistry);
      this.beginScopeDrain(scope);
      void this.releaseConnection(scope);
    });
    return true;
  }

  beginDrain(): void {
    if (this.draining) {
      return;
    }
    this.draining = true;
    for (const scope of Array.from(this.scopes.values())) {
      // Graceful shutdown owns every scope that is still live when draining
      // begins. Freeze that ownership before drain hooks can re-enter or a
      // later peer close can start release.
      scope.releaseOwner ??= 'registry';
      this.beginScopeDrain(scope);
    }
    for (const transport of Array.from(this.transports)) {
      this.beginTransportDrain(transport);
    }
  }

  waitForIdle(): Promise<void> {
    if (this.scopes.size === 0) {
      const disposalError = this.getDisposalError();
      return disposalError ? Promise.reject(disposalError) : Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => this.idleWaiters.add({ reject, resolve }));
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.beginDrain();
    this.releasingConnections = true;
    for (const scope of Array.from(this.scopes.values())) {
      void this.releaseConnection(scope);
    }
    if (this.scopes.size === 0) {
      this.disposeTransports();
    }
    this.disposePromise = this.waitForIdle();
    return this.disposePromise;
  }

  private async releaseConnection(scope: TrackedConnectionScope): Promise<void> {
    if (scope.disposalStarted) {
      return;
    }
    scope.disposalStarted = true;
    // The first release trigger owns this scope for its entire lifetime. A
    // peer disconnect receives the bounded lease only if it claimed release
    // before graceful shutdown began.
    scope.releaseOwner ??=
      !this.draining && scope.naturallyDisconnected && scope.disconnectedAt !== undefined
        ? 'natural-disconnect'
        : 'registry';
    this.beginScopeDrain(scope);
    try {
      await this.waitForScopeInboundIdle(scope);
    } catch (error) {
      this.disposalFailures.push({ clientId: `${scope.clientId}:inbound-idle`, error });
      this.logger.error(`Could not wait for inbound RPC connection ${scope.clientId}`, error);
    }
    this.closeChannel(scope);
    try {
      await this.disposeScope(scope);
    } finally {
      if (this.scopes.get(scope.channel) === scope) {
        this.scopes.delete(scope.channel);
      }
      if (this.scopes.size === 0) {
        if (this.releasingConnections) {
          this.disposeTransports();
        }
        this.settleIdleWaiters();
      }
    }
  }

  private closeChannel(scope: TrackedConnectionScope): void {
    this.beginScopeDrain(scope);
    if (!scope.channelClosed) {
      scope.channelClosed = true;
      scope.disconnectInitiatedByRegistry = true;
      try {
        scope.channel.close(1001, 'server is draining');
      } catch (error) {
        this.disposalFailures.push({ clientId: `${scope.clientId}:channel-close`, error });
        this.logger.error(`Could not close RPC connection ${scope.clientId} while draining`, error);
      }
      this.markScopeDisconnected(scope, false);
    }
    try {
      scope.channel.dispose();
    } catch (error) {
      this.disposalFailures.push({ clientId: `${scope.clientId}:channel`, error });
      this.logger.error(`Could not dispose RPC channel ${scope.clientId} while draining`, error);
    }
  }

  private markScopeDisconnected(scope: TrackedConnectionScope, natural: boolean): void {
    if (natural) {
      scope.naturallyDisconnected = true;
    }
    if (scope.disconnectedAt !== undefined) {
      return;
    }
    scope.channelClosed = true;
    scope.disconnectedAt = Date.now();
  }

  /**
   * A scope claimed by graceful shutdown keeps the strict contract even if its
   * peer disconnects later: every admitted operation is awaited. Only a
   * natural disconnect that claimed release first receives a bounded lease,
   * because no response can reach that epoch and user code may never settle.
   */
  private async waitForScopeInboundIdle(scope: TrackedConnectionScope): Promise<void> {
    const inboundIdle = Promise.resolve().then(() => scope.whenInboundIdle());

    if (scope.releaseOwner !== 'natural-disconnect' || scope.disconnectedAt === undefined) {
      await inboundIdle;
      return;
    }

    const disconnectedAt = scope.disconnectedAt;
    const remainingGraceMs = Math.max(0, this.disconnectGraceMs - (Date.now() - disconnectedAt));
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        inboundIdle.then(() => 'idle' as const),
        new Promise<'expired'>((resolve) => {
          timer = setTimeout(() => resolve('expired'), remainingGraceMs);
          timer.unref?.();
        }),
      ]);
      if (result === 'expired') {
        this.retireDisconnectedEpoch(scope);
      }
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * A naturally disconnected scope gets one absolute lease shared by inbound
   * work and child cleanup. The cleanup promise remains observed after expiry,
   * but it no longer owns a registry entry. Live graceful shutdown never takes
   * this branch because its release ownership was frozen before any later peer
   * disconnect.
   */
  private async disposeScope(scope: TrackedConnectionScope): Promise<void> {
    let disposal: Promise<void>;
    try {
      disposal = Promise.resolve(scope.dispose());
    } catch (error) {
      this.recordScopeDisposalFailure(scope.clientId, error);
      return;
    }

    if (scope.releaseOwner !== 'natural-disconnect' || scope.disconnectedAt === undefined) {
      try {
        await disposal;
      } catch (error) {
        this.recordScopeDisposalFailure(scope.clientId, error);
      }
      return;
    }

    const clientId = scope.clientId;
    // Attach the rejection observer before racing so a cleanup that settles
    // after retirement can never surface as an unhandled rejection.
    const observedDisposal = disposal.then(
      () => ({ state: 'disposed' as const }),
      (error) => {
        this.logger.error(`Could not dispose retired RPC connection ${clientId}`, error);
        return { state: 'failed' as const, error };
      },
    );
    const remainingGraceMs = Math.max(0, this.disconnectGraceMs - (Date.now() - scope.disconnectedAt));
    let timer: NodeJS.Timeout | undefined;
    try {
      const result = await Promise.race([
        observedDisposal,
        new Promise<{ state: 'expired' }>((resolve) => {
          timer = setTimeout(() => resolve({ state: 'expired' }), remainingGraceMs);
          timer.unref?.();
        }),
      ]);
      if (result.state === 'expired') {
        this.retireDisconnectedEpoch(scope);
      } else if (result.state === 'failed') {
        this.disposalFailures.push({ clientId, error: result.error });
      }
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private retireDisconnectedEpoch(scope: TrackedConnectionScope): void {
    if (scope.disconnectedEpochRetired) {
      return;
    }
    scope.disconnectedEpochRetired = true;
    try {
      scope.retireDisconnectedInbound();
    } catch (error) {
      this.disposalFailures.push({ clientId: `${scope.clientId}:inbound-retire`, error });
      this.logger.error(`Could not retire inbound RPC connection ${scope.clientId}`, error);
    }
    try {
      scope.retireDisconnectedScope();
    } catch (error) {
      this.disposalFailures.push({ clientId: `${scope.clientId}:scope-retire`, error });
      this.logger.error(`Could not retire child scope ${scope.clientId}`, error);
    }
  }

  private recordScopeDisposalFailure(clientId: string, error: unknown): void {
    this.disposalFailures.push({ clientId, error });
    this.logger.error(`Could not dispose RPC connection ${clientId}`, error);
  }

  private beginTransportDrain(transport: TrackedConnectionTransport): void {
    if (transport.drainStarted) {
      return;
    }
    transport.drainStarted = true;
    try {
      transport.beginDrain();
    } catch (error) {
      this.disposalFailures.push({ clientId: '<transport-drain>', error });
      this.logger.error('Could not drain server connection transport', error);
    }
  }

  private disposeTransports(): void {
    for (const transport of Array.from(this.transports)) {
      this.beginTransportDrain(transport);
      this.disposeTransport(transport.dispose);
    }
    this.transports.clear();
  }

  private beginScopeDrain(scope: TrackedConnectionScope): void {
    if (scope.drainStarted) {
      return;
    }
    scope.drainStarted = true;
    try {
      scope.beginDrain();
    } catch (error) {
      this.disposalFailures.push({ clientId: `${scope.clientId}:inbound-drain`, error });
      this.logger.error(`Could not drain RPC connection ${scope.clientId}`, error);
    }
  }

  private disposeTransport(dispose: () => void): void {
    try {
      dispose();
    } catch (error) {
      this.disposalFailures.push({ clientId: '<transport>', error });
      this.logger.error('Could not dispose server connection transport', error);
    }
  }

  private getDisposalError(): ServerConnectionDisposalError | undefined {
    return this.disposalFailures.length > 0 ? new ServerConnectionDisposalError([...this.disposalFailures]) : undefined;
  }

  private settleIdleWaiters(): void {
    const waiters = Array.from(this.idleWaiters);
    this.idleWaiters.clear();
    const disposalError = this.getDisposalError();
    for (const waiter of waiters) {
      if (disposalError) {
        waiter.reject(disposalError);
      } else {
        waiter.resolve();
      }
    }
  }
}

function assertFullConnectionRegistry(registry: unknown): asserts registry is IServerConnectionRegistry {
  const candidate = registry as Partial<IServerConnectionRegistry> | null | undefined;
  const missingMembers = [
    typeof candidate?.acceptsConnections === 'boolean' ? undefined : 'acceptsConnections',
    typeof candidate?.registerTransportDisposer === 'function' ? undefined : 'registerTransportDisposer',
    typeof candidate?.trackConnection === 'function' ? undefined : 'trackConnection',
    typeof candidate?.beginDrain === 'function' ? undefined : 'beginDrain',
    typeof candidate?.waitForIdle === 'function' ? undefined : 'waitForIdle',
    typeof candidate?.dispose === 'function' ? undefined : 'dispose',
  ].filter((member): member is string => Boolean(member));
  if (missingMembers.length > 0) {
    throw new TypeError(`IServerConnectionRegistry is missing required runtime members: ${missingMembers.join(', ')}`);
  }
}

function getServerConnectionRegistry(
  injector: Injector,
  logger: INodeLogger,
  serverAppOpts: IServerAppOpts,
): IServerConnectionRegistry {
  if (injector.creatorMap.has(IServerConnectionRegistry)) {
    const registry: unknown = injector.get(IServerConnectionRegistry);
    assertFullConnectionRegistry(registry);
    return registry;
  }
  const registry = new ServerConnectionRegistry(logger, {
    disconnectGraceMs: serverAppOpts.rpcDisconnectGraceMs,
  });
  injector.addProviders({
    token: IServerConnectionRegistry,
    useValue: registry,
  });
  return registry;
}

function handleClientChannel(
  injector: Injector,
  modulesInstances: NodeModule[],
  channel: WSChannel,
  clientId: string,
  logger: INodeLogger,
  connectionRegistry: IServerConnectionRegistry,
  runtimeTopologyHandshake?: IRuntimeTopologyHandshakeServer,
): true | typeof LOGICAL_CHANNEL_OPEN_DRAINING | ReturnType<typeof rejectLogicalChannel> {
  const topologyAdmission = runtimeTopologyHandshake?.admitRPC(channel.connection);
  if (topologyAdmission && !topologyAdmission.accepted) {
    const reason = topologyAdmission.reason || 'runtime topology handshake rejected';
    logger.error(`Reject RPC connection ${clientId}: ${reason}`);
    return rejectLogicalChannel(reason);
  }
  if (!connectionRegistry.acceptsConnections) {
    channel.dispose();
    return LOGICAL_CHANNEL_OPEN_DRAINING;
  }
  if (typeof clientId !== 'string' || clientId.trim().length === 0) {
    logger.error('Reject RPC connection with an empty client id');
    try {
      channel.close(1008, 'invalid client id');
    } finally {
      channel.dispose();
    }
    return LOGICAL_CHANNEL_OPEN_DRAINING;
  }
  logger.log(`New RPC connection ${clientId}`);

  const serviceCenter = new RPCServiceCenter(undefined, logger);
  let serviceChildInjector: Injector | undefined;
  let scopeRetirement: IConnectionScopeRetirement;
  let sumiConnection: ReturnType<WSChannel['createSumiConnection']>;
  let remove: { dispose(): void };
  try {
    serviceChildInjector = bindModuleBackService(injector, modulesInstances, serviceCenter, clientId, logger);
    scopeRetirement = serviceChildInjector.get(IConnectionScopeRetirement);
    sumiConnection = channel.createSumiConnection();
    remove = serviceCenter.setSumiConnection(sumiConnection);
  } catch (error) {
    logger.error(`Could not initialize RPC connection ${clientId}`, error);
    if (serviceChildInjector) {
      const childToDispose = serviceChildInjector;
      try {
        serviceCenter.dispose();
      } catch (cleanupError) {
        logger.error(`Could not roll back RPC service center ${clientId}`, cleanupError);
      }
      void Promise.resolve()
        .then(() => childToDispose.disposeAll())
        .catch((cleanupError) => logger.error(`Could not roll back RPC connection ${clientId}`, cleanupError));
    }
    try {
      channel.close(1011, 'connection initialization failed');
    } finally {
      channel.dispose();
    }
    return LOGICAL_CHANNEL_OPEN_DRAINING;
  }
  const connectionChildInjector = serviceChildInjector as Injector;

  const disposeConnectionScope = async () => {
    try {
      remove.dispose();
    } finally {
      try {
        await connectionChildInjector.disposeAll();
      } finally {
        serviceCenter.dispose();
      }
    }
    logger.log(`Remove RPC connection ${clientId}`);
  };

  const accepted = connectionRegistry.trackConnection(channel, clientId, disposeConnectionScope, {
    beginDrain: () => sumiConnection.beginInboundDrain(),
    whenInboundIdle: () => sumiConnection.whenInboundIdle(),
    retireDisconnectedInbound: () => sumiConnection.retireDisconnectedInboundOperations(),
    retireDisconnectedScope: () => scopeRetirement.retire(),
  });
  return accepted ? true : LOGICAL_CHANNEL_OPEN_DRAINING;
}

export function createServerConnection2(
  server: http.Server,
  injector: Injector,
  modulesInstances: NodeModule[],
  handlerArr: WebSocketHandler[],
  serverAppOpts: IServerAppOpts,
) {
  const logger = injector.get(INodeLogger);
  const commonChannelPathHandler = injector.get(CommonChannelPathHandler);
  const connectionRegistry = getServerConnectionRegistry(injector, logger, serverAppOpts);
  const runtimeTopologyHandshake = serverAppOpts.runtimeTopologyHandshake;
  const socketRoute = new WebSocketServerRoute(server, logger);
  socketRoute.deferHandlerDisposalOnServerClose();
  const channelHandler = new CommonChannelHandler('/service', commonChannelPathHandler, logger, {
    heartbeatInterval: serverAppOpts.wsHeartbeatInterval,
    maxBufferedAmount: serverAppOpts.wsMaxBufferedAmount,
    maxConnections: serverAppOpts.wsMaxConnections,
    shouldAcceptConnection: () =>
      connectionRegistry.acceptsConnections && (serverAppOpts.wsShouldAcceptConnection?.() ?? true),
    pathMatchOptions: serverAppOpts.pathMatchOptions,
    wsServerOptions: serverAppOpts.wsServerOptions,
  });

  if (runtimeTopologyHandshake) {
    commonChannelPathHandler.register(runtimeTopologyHandshake.channelPath, {
      handler: (channel: WSChannel) => runtimeTopologyHandshake.handleChannel(channel),
      dispose: () => {},
    });
  }

  // 事件由 connection 的时机来触发
  commonChannelPathHandler.register(RPCServiceChannelPath, {
    handler: (channel: WSChannel, clientId: string) =>
      handleClientChannel(
        injector,
        modulesInstances,
        channel,
        clientId,
        logger,
        connectionRegistry,
        runtimeTopologyHandshake,
      ),
    dispose: () => {},
  });

  socketRoute.registerHandler(channelHandler);
  if (handlerArr) {
    for (const handler of handlerArr) {
      socketRoute.registerHandler(handler);
    }
  }
  socketRoute.init();
  connectionRegistry.registerTransportDisposer(
    () => socketRoute.dispose(),
    () => {
      channelHandler.beginDrain();
      socketRoute.stopAccepting();
    },
  );
}

export function createNetServerConnection(
  server: net.Server,
  injector: Injector,
  modulesInstances: NodeModule[],
  serverAppOpts: IServerAppOpts,
) {
  const logger = injector.get(INodeLogger) as INodeLogger;
  const commonChannelPathHandler = injector.get(CommonChannelPathHandler);
  const connectionRegistry = getServerConnectionRegistry(injector, logger, serverAppOpts);
  const runtimeTopologyHandshake = serverAppOpts.runtimeTopologyHandshake;

  const handler =
    serverAppOpts.netChannelMode === 'multiplex-v1'
      ? new MultiplexElectronChannelHandler(server, commonChannelPathHandler, logger, {
          maxPayload: serverAppOpts.wsServerOptions?.maxPayload,
          maxBufferedAmount: serverAppOpts.wsMaxBufferedAmount,
        })
      : new ElectronChannelHandler(server, commonChannelPathHandler, logger);
  if (runtimeTopologyHandshake) {
    commonChannelPathHandler.register(runtimeTopologyHandshake.channelPath, {
      handler: (channel: WSChannel) => runtimeTopologyHandshake.handleChannel(channel),
      dispose: () => {},
    });
  }

  // 事件由 connection 的时机来触发
  commonChannelPathHandler.register(RPCServiceChannelPath, {
    handler: (channel: WSChannel, clientId: string) =>
      handleClientChannel(
        injector,
        modulesInstances,
        channel,
        clientId,
        logger,
        connectionRegistry,
        runtimeTopologyHandshake,
      ),
    dispose: () => {},
  });

  handler.listen();
  connectionRegistry.registerTransportDisposer(
    () => handler.dispose(),
    () => handler.stopAccepting(),
  );
}

export function bindModuleBackService(
  injector: Injector,
  modules: NodeModule[],
  serviceCenter: RPCServiceCenter,
  clientId: string,
  logger: INodeLogger,
) {
  let childInjector: Injector | undefined;

  try {
    const createdChildInjector = injector.createChild();
    childInjector = createdChildInjector;
    const { createRPCService } = initRPCService(serviceCenter);
    createdChildInjector.addProviders({
      token: IConnectionScopeRetirement,
      useValue: new ConnectionScopeRetirement(),
    });
    runInRemoteServiceContext(createdChildInjector, () => {
      injectSessionDataStores(createdChildInjector);
      createdChildInjector.addProviders({
        token: CLIENT_ID_TOKEN,
        useValue: clientId,
      });

      for (const m of modules) {
        if (m.backServices) {
          for (const service of m.backServices) {
            if (!service.token) {
              continue;
            }

            if (service.protocol) {
              serviceCenter.loadProtocol(service.protocol);
            }

            const serviceToken = service.token;

            const creator = injector.creatorMap.get(serviceToken) as InstanceCreator;
            if (!creator) {
              continue;
            }

            if ((creator as FactoryCreator).useFactory) {
              const serviceFactory = (creator as FactoryCreator).useFactory;
              createdChildInjector.addProviders({
                token: serviceToken,
                useValue: serviceFactory(createdChildInjector),
              });
            } else {
              const serviceClass = (creator as ClassCreator).useClass;
              createdChildInjector.addProviders({
                token: serviceToken,
                useClass: serviceClass,
              });
            }

            const serviceInstance = createdChildInjector.get(serviceToken);

            if (serviceInstance.setConnectionClientId) {
              serviceInstance.setConnectionClientId(clientId);
            }
            const stub = createRPCService(service.servicePath, serviceInstance);
            if (!serviceInstance.rpcClient) {
              serviceInstance.rpcClient = [stub];
            }
          }
        }

        if (m.remoteServices) {
          for (const service of m.remoteServices) {
            const serviceInstance = createdChildInjector.get(service);
            const data = getRemoteServiceData(service);
            if (!data || !data.servicePath) {
              logger.error(`Remote service ${RemoteService.getName(service)} must have servicePath`);
              continue;
            }

            if (data.protocol) {
              serviceCenter.loadProtocol(data.protocol);
            }

            if (serviceInstance.setConnectionClientId) {
              serviceInstance.setConnectionClientId(clientId);
            }
            const stub = createRPCService(data.servicePath, serviceInstance);
            if (!serviceInstance.rpcClient) {
              serviceInstance.rpcClient = [stub];
            }
          }
        }
      }
    });
  } catch (error) {
    // Binding is a transaction: no child instance or partially registered RPC
    // stub may escape if any service rejects its connection identity.
    try {
      serviceCenter.dispose();
    } catch (cleanupError) {
      logger.error(`Could not roll back RPC service center ${clientId}`, cleanupError);
    }
    if (childInjector) {
      const childToDispose = childInjector;
      void Promise.resolve()
        .then(() => childToDispose.disposeAll())
        .catch((cleanupError) => logger.error(`Could not roll back RPC connection ${clientId}`, cleanupError));
    }
    throw error;
  }

  return childInjector as Injector;
}
