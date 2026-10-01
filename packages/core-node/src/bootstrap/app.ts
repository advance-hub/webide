import http from 'http';
import https from 'https';
import net from 'net';
import os from 'os';
import path from 'path';

import Koa from 'koa';

import { Injector } from '@opensumi/di';
import { WebSocketHandler } from '@opensumi/ide-connection/node';
import { injectConnectionProviders } from '@opensumi/ide-connection/server';
import {
  ContributionProvider,
  ILogService,
  ILogServiceManager,
  StoragePaths,
  SupportLogNamespace,
  createContributionProvider,
  getDebugLogger,
  getModuleDependencies,
  injectGDataStores,
  isWindows,
} from '@opensumi/ide-core-common';
import { DEFAULT_OPENVSX_REGISTRY } from '@opensumi/ide-core-common/const';
import { suppressNodeJSEpipeError } from '@opensumi/ide-core-common/node';

import { RPCServiceCenter, createNetServerConnection, createServerConnection2 } from '../connection';
import { NodeModule } from '../node-module';
import {
  AppConfig,
  IServerAppOpts,
  IServerConnectionRegistry,
  IServerRuntimeApp,
  ModuleConstructor,
  ServerAppContribution,
  ServerRuntimeState,
  ServerRuntimeStopError,
  ServerRuntimeStopOptions,
  ServerRuntimeStopPhase,
  ServerRuntimeStopPhaseReport,
  ServerRuntimeStopReport,
} from '../types';

import { injectInnerProviders } from './inner-providers';

export class ServerApp implements IServerRuntimeApp {
  private static readonly DEFAULT_SHUTDOWN_DEADLINE_MS = 30_000;

  private _injector: Injector;

  private config: IServerAppOpts;

  private logger: Pick<ILogService, 'log' | 'error'> = getDebugLogger();

  private webSocketHandler: WebSocketHandler[];

  private modulesInstances: NodeModule[];

  private server?: http.Server | https.Server | net.Server;

  private runtimeState: ServerRuntimeState = 'created';

  private drainPromise?: Promise<void>;
  private serverCloseResult?: Promise<Error | undefined>;

  private startPromise?: Promise<void>;

  private stopPromise?: Promise<ServerRuntimeStopReport>;

  use: (middleware: Koa.Middleware<Koa.ParameterizedContext<any, any>>) => void;

  protected contributionsProvider: ContributionProvider<ServerAppContribution>;

  /**
   * 启动初始化
   * 1. 绑定 process 报错处理
   * 2. 初始化内置的 Provider
   * 3. 获取 Modules 的实例
   * 4. 设置默认的实例
   * @param opts
   */
  constructor(private opts: IServerAppOpts) {
    this._injector = opts.injector || new Injector();
    this.webSocketHandler = opts.webSocketHandler || [];
    // 使用外部传入的中间件
    this.use = opts.use || (() => null);
    this.config = {
      ...opts,
      injector: this.injector,
      marketplace: Object.assign(
        {
          endpoint: DEFAULT_OPENVSX_REGISTRY,
          extensionDir: path.join(
            os.homedir(),
            ...(isWindows ? [StoragePaths.WINDOWS_APP_DATA_DIR, StoragePaths.WINDOWS_ROAMING_DIR] : ['']),
            StoragePaths.DEFAULT_STORAGE_DIR_NAME,
            StoragePaths.MARKETPLACE_DIR,
          ),
          showBuiltinExtensions: false,
          ignoreId: [],
        },
        opts.marketplace,
      ),
      extHost: process.env.EXTENSION_HOST_ENTRY || opts.extHost,
      rpcMessageTimeout: opts.rpcMessageTimeout || -1,
    };
    // Unit tests create many ServerApp instances in one process. Process-global
    // signal and stream handlers are runtime concerns and would leak between suites.
    if (!process.env.IS_JEST_TEST) {
      this.bindProcessHandler();
      if (opts.processSignalHandling !== 'external') {
        this.bindShutdownSignalHandlers();
      }
    }
    this.initBaseProvider();
    this.createNodeModules(opts.modules, opts.modulesInstances);
    this.logger = this.injector.get(ILogServiceManager).getLogger(SupportLogNamespace.App);
    this.contributionsProvider = this.injector.get(ServerAppContribution);
  }

  get injector() {
    return this._injector;
  }

  get state(): ServerRuntimeState {
    return this.runtimeState;
  }

  /**
   * 将被依赖但未被加入modules的模块加入到待加载模块最后
   */
  public resolveModuleDeps(moduleConstructor: ModuleConstructor, modules: any[]) {
    const dependencies = getModuleDependencies(moduleConstructor);
    if (dependencies) {
      dependencies.forEach((dep) => {
        if (modules.indexOf(dep) === -1) {
          modules.push(dep);
        }
      });
    }
  }

  private get contributions(): ServerAppContribution[] {
    return this.contributionsProvider.getContributions();
  }

  private initBaseProvider() {
    // 创建 contributionsProvider
    createContributionProvider(this.injector, ServerAppContribution);

    this.injector.addProviders({
      token: AppConfig,
      useValue: this.config,
    });
    injectInnerProviders(this.injector);
    injectConnectionProviders(this.injector);
  }

  private async initializeContribution() {
    for (const contribution of this.contributions) {
      this.assertStartupActive();
      if (contribution.initialize) {
        try {
          await contribution.initialize(this);
        } catch (error) {
          this.logger.error('Could not initialize contribution', error);
          if (contribution.startupRequired) {
            throw error;
          }
        }
      }
    }
  }

  private async startContribution() {
    for (const contrib of this.contributions) {
      this.assertStartupActive();
      if (contrib.onStart) {
        try {
          await contrib.onStart(this);
        } catch (error) {
          this.logger.error('Could not start contribution', error);
          if (contrib.startupRequired) {
            throw error;
          }
        }
      }
    }
  }

  async start(
    server: http.Server | https.Server | net.Server,
    serviceHandler?: (serviceCenter: RPCServiceCenter) => void,
  ): Promise<void> {
    if (this.runtimeState !== 'created') {
      throw new Error(`ServerApp cannot start from ${this.runtimeState} state`);
    }
    this.runtimeState = 'starting';
    this.server = server;
    this.startPromise = this.startRuntime(server, serviceHandler);
    return this.startPromise;
  }

  private async startRuntime(
    server: http.Server | https.Server | net.Server,
    serviceHandler?: (serviceCenter: RPCServiceCenter) => void,
  ): Promise<void> {
    try {
      await this.initializeContribution();
      this.assertStartupActive();

      if (serviceHandler) {
        serviceHandler(new RPCServiceCenter());
      } else {
        if (server instanceof http.Server || server instanceof https.Server) {
          // 创建 websocket 通道
          createServerConnection2(server, this.injector, this.modulesInstances, this.webSocketHandler, this.opts);
        } else if (server instanceof net.Server) {
          createNetServerConnection(server, this.injector, this.modulesInstances, this.opts);
        }
      }

      await this.startContribution();
      this.assertStartupActive();
      this.runtimeState = 'running';
    } catch (error) {
      if (!this.stopPromise) {
        this.runtimeState = 'failed';
      }
      throw error;
    }
  }

  private assertStartupActive(): void {
    if (
      this.stopPromise ||
      this.runtimeState === 'draining' ||
      this.runtimeState === 'stopping' ||
      this.runtimeState === 'stopped'
    ) {
      const error = new Error('ServerApp startup was cancelled because runtime drain or shutdown began');
      error.name = 'ServerRuntimeStartupCancelledError';
      throw error;
    }
  }

  private async waitForStartupToSettle(): Promise<void> {
    if (!this.startPromise) {
      return;
    }
    try {
      await this.startPromise;
    } catch {
      // The start caller retains the original error. Shutdown still owns all
      // cleanup and must continue after startup has stopped mutating state.
    }
  }

  private async onStop(): Promise<void> {
    const errors: unknown[] = [];
    for (const contrib of this.contributions) {
      if (contrib.onStop) {
        try {
          await contrib.onStop(this);
        } catch (error) {
          errors.push(error);
          this.logger.error('Could not stop contribution', error);
        }
      }
    }
    if (errors.length > 0) {
      throw errors[0];
    }
  }

  /** Stop accepting work and close the listening server. Safe to call repeatedly. */
  drain(): Promise<void> {
    return this.beginDrainBarrier();
  }

  /**
   * Stop the runtime in ownership order: listener, connection child scopes,
   * shared contributions, then the root injector. The first caller owns the total deadline;
   * every later caller receives the same report object.
   */
  stop(options: ServerRuntimeStopOptions = {}): Promise<ServerRuntimeStopReport> {
    if (!this.stopPromise) {
      let resolveStop!: (report: ServerRuntimeStopReport) => void;
      let rejectStop!: (error: unknown) => void;
      // Publish the owner promise before invoking admission hooks so even a
      // synchronously re-entrant stop receives this exact shutdown operation.
      this.stopPromise = new Promise<ServerRuntimeStopReport>((resolve, reject) => {
        resolveStop = resolve;
        rejectStop = reject;
      });
      // Admission is a synchronous safety barrier, not deadline-budgeted work.
      // Even a zero-budget stop must make the runtime visibly stopping, reject
      // new connection scopes and initiate listener close before it returns.
      this.runtimeState = 'stopping';
      try {
        const drainPromise = this.beginDrainBarrier();
        // A zero deadline may skip the phase which awaits this promise. Keep a
        // rejected asynchronous drain from becoming an unhandled rejection; a
        // budgeted server phase still observes and reports the same rejection.
        void drainPromise.catch(() => undefined);
        void this.stopRuntime(options, drainPromise).then(resolveStop, rejectStop);
      } catch (error) {
        rejectStop(error);
      }
    }
    return this.stopPromise;
  }

  dispose(options: ServerRuntimeStopOptions = {}): Promise<ServerRuntimeStopReport> {
    return this.stop(options);
  }

  private beginDrainBarrier(): Promise<void> {
    if (this.drainPromise) {
      return this.drainPromise;
    }

    let resolveDrain!: () => void;
    let rejectDrain!: (error: unknown) => void;
    this.drainPromise = new Promise<void>((resolve, reject) => {
      resolveDrain = resolve;
      rejectDrain = reject;
    });

    if (this.runtimeState !== 'stopped' && this.runtimeState !== 'stopping') {
      this.runtimeState = 'draining';
    }

    let beginConnectionDrain: Promise<void>;
    try {
      const registry = this.getConnectionRegistry();
      beginConnectionDrain = registry ? Promise.resolve(registry.beginDrain()) : Promise.resolve();
    } catch (error) {
      beginConnectionDrain = Promise.reject(error);
    }

    // Attempt both halves of the barrier even when a registry implementation
    // throws synchronously. Closing the listener is independently necessary to
    // stop new ingress.
    let beginListenerClose = Promise.resolve();
    try {
      this.beginServerClose();
    } catch (error) {
      beginListenerClose = Promise.reject(error);
    }
    void Promise.all([beginConnectionDrain, beginListenerClose]).then(() => resolveDrain(), rejectDrain);
    return this.drainPromise;
  }

  private beginServerClose(): void {
    if (this.serverCloseResult) {
      return;
    }
    const server = this.server;
    if (!server || !server.listening) {
      this.serverCloseResult = Promise.resolve(undefined);
      return;
    }

    this.serverCloseResult = new Promise<Error | undefined>((resolve) => {
      try {
        server.close((error?: Error) => resolve(error));
      } catch (error) {
        resolve(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private async waitForServerClose(): Promise<void> {
    this.beginServerClose();
    const error = await this.serverCloseResult;
    if (error) {
      throw error;
    }
  }

  private getConnectionRegistry(): IServerConnectionRegistry | undefined {
    if (!this.injector.creatorMap.has(IServerConnectionRegistry)) {
      return undefined;
    }
    return this.injector.get(IServerConnectionRegistry);
  }

  private async stopRuntime(
    options: ServerRuntimeStopOptions,
    drainPromise: Promise<void>,
  ): Promise<ServerRuntimeStopReport> {
    const startedAt = Date.now();
    const deadlineMs = this.normalizeDeadline(options.deadlineMs);
    const deadlineAt = startedAt + deadlineMs;
    const phases: ServerRuntimeStopPhaseReport[] = [];
    let registry: IServerConnectionRegistry | undefined;
    try {
      registry = this.getConnectionRegistry();
    } catch {
      // The admission barrier already captured provider-resolution failure in
      // drainPromise. Keep later owner phases available for best-effort cleanup.
    }

    const phaseActions: Array<[ServerRuntimeStopPhase, () => void | Promise<void>]> = [
      [
        'server',
        async () => {
          await drainPromise;
          await this.waitForStartupToSettle();
        },
      ],
      [
        'connections',
        async () => {
          const results = await Promise.allSettled([
            registry ? Promise.resolve(registry.dispose()) : Promise.resolve(),
            this.waitForServerClose(),
            options.beforeSharedOwners ? Promise.resolve().then(options.beforeSharedOwners) : Promise.resolve(),
          ]);
          const rejection = results.find((result): result is PromiseRejectedResult => result.status === 'rejected');
          if (rejection) {
            throw rejection.reason;
          }
        },
      ],
      ['contributions', () => this.onStop()],
      ['injector', () => this.injector.disposeAll()],
    ];

    let timedOut = false;
    for (const [phase, action] of phaseActions) {
      if (timedOut) {
        phases.push(this.createSkippedPhase(phase));
        continue;
      }

      const report = await this.runStopPhase(phase, deadlineAt, action);
      phases.push(report);
      // Promise.race cannot cancel phase work. Continuing into a child-owner
      // phase after a timeout would let it overlap with disposal of that child.
      // Preserve ownership ordering and let the product-level hard deadline
      // terminate a runtime whose in-flight phase cannot settle.
      timedOut = report.status === 'timed_out';
    }
    const activeConnections = registry?.activeConnectionCount || 0;

    const failed = phases.some(({ status }) => status === 'failed' || status === 'timed_out');
    this.runtimeState = failed ? 'failed' : 'stopped';
    const finishedAt = Date.now();
    return {
      reason: options.reason,
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      deadlineMs,
      timedOut,
      activeConnections,
      phases,
    };
  }

  private async runStopPhase(
    phase: ServerRuntimeStopPhase,
    deadlineAt: number,
    action: () => void | Promise<void>,
  ): Promise<ServerRuntimeStopPhaseReport> {
    const startedAt = Date.now();
    const remainingMs = Math.max(0, deadlineAt - startedAt);

    if (remainingMs === 0) {
      return {
        phase,
        status: 'timed_out',
        startedAt,
        finishedAt: startedAt,
        durationMs: 0,
      };
    }

    const work = Promise.resolve().then(action);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timed_out'>((resolve) => {
      timer = setTimeout(() => resolve('timed_out'), remainingMs);
    });
    const result = await Promise.race([
      work.then(
        () => 'completed' as const,
        (error) => ({ error }) as const,
      ),
      timeout,
    ]);
    if (timer) {
      clearTimeout(timer);
    }

    const finishedAt = Date.now();
    if (result === 'completed' || result === 'timed_out') {
      return {
        phase,
        status: result,
        startedAt,
        finishedAt,
        durationMs: finishedAt - startedAt,
      };
    }

    return {
      phase,
      status: 'failed',
      startedAt,
      finishedAt,
      durationMs: finishedAt - startedAt,
      error: this.toStopError(result.error),
    };
  }

  private createSkippedPhase(phase: ServerRuntimeStopPhase): ServerRuntimeStopPhaseReport {
    const timestamp = Date.now();
    return {
      phase,
      status: 'skipped',
      startedAt: timestamp,
      finishedAt: timestamp,
      durationMs: 0,
    };
  }

  private normalizeDeadline(deadlineMs: number | undefined): number {
    if (deadlineMs === undefined) {
      return ServerApp.DEFAULT_SHUTDOWN_DEADLINE_MS;
    }
    return Number.isFinite(deadlineMs) && deadlineMs >= 0 ? deadlineMs : ServerApp.DEFAULT_SHUTDOWN_DEADLINE_MS;
  }

  private toStopError(error: unknown): ServerRuntimeStopError {
    if (error instanceof Error) {
      return { name: error.name, message: error.message };
    }
    return { name: 'Error', message: String(error) };
  }

  /**
   * 绑定 process 退出逻辑
   */
  private bindProcessHandler() {
    suppressNodeJSEpipeError(process, (msg) => {
      this.logger.error(msg);
    });

    process.on('uncaughtException', (error) => {
      if (error) {
        this.logger.error('Uncaught Exception: ', error.toString());
        if (error.stack) {
          this.logger.error(error.stack);
        }
      }
    });
    // Handles normal process termination.
    process.on('exit', () => {
      this.logger.log('process exit');
    });
  }

  private bindShutdownSignalHandlers() {
    const shutdown = (signal: 'SIGINT' | 'SIGTERM') => {
      this.logger.log(`process ${signal}`);
      void this.stop({ reason: signal }).then(
        (report) => {
          this.logger.log(`process ${signal} DONE`);
          const failed = report.phases.some(({ status }) => status !== 'completed');
          process.exit(failed ? 1 : 0);
        },
        (error) => {
          this.logger.error(`Could not stop runtime after ${signal}`, error);
          process.exit(1);
        },
      );
    };

    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  }

  /**
   * 收集 module 实例
   * @param Constructors
   * @param modules
   */
  private createNodeModules(Constructors: ModuleConstructor[] = [], modules: NodeModule[] = []) {
    injectGDataStores(this.injector);

    const allModules = [...modules];
    Constructors.forEach((c) => {
      this.resolveModuleDeps(c, Constructors);
    });
    for (const Constructor of Constructors) {
      allModules.push(this.injector.get(Constructor));
    }
    for (const instance of allModules) {
      if (instance.providers) {
        this.injector.addProviders(...instance.providers);
      }

      if (instance.contributionProvider) {
        if (Array.isArray(instance.contributionProvider)) {
          for (const contributionProvider of instance.contributionProvider) {
            createContributionProvider(this.injector, contributionProvider);
          }
        } else {
          createContributionProvider(this.injector, instance.contributionProvider);
        }
      }
    }
    this.modulesInstances = allModules;
  }
}
