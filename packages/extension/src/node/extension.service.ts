import net from 'net';
import path from 'path';
import util from 'util';

import { Autowired, Injectable } from '@opensumi/di';
import { NetSocketConnection, WSServerChannel } from '@opensumi/ide-connection';
import { CommonChannelPathHandler } from '@opensumi/ide-connection/server';
import {
  Emitter,
  Event,
  ExtensionConnectModeOption,
  ExtensionConnectOption,
  IDisposable,
  IReporterTimer,
  SupportLogNamespace,
  getDebugLogger,
  timeout,
} from '@opensumi/ide-core-common';
import { normalizedIpcHandlerPathAsync } from '@opensumi/ide-core-common/node/ipc';
import { findFreePort } from '@opensumi/ide-core-common/node/ports';
import {
  AppConfig,
  ExtensionHostRuntimePhase,
  ExtensionHostRuntimeStatus,
  INodeLogger,
  IReporter,
  IReporterService,
  PerformanceData,
  REPORT_NAME,
  REPORT_TYPE,
  ReporterProcessMessage,
  getShellPath,
  isDevelopment,
  isElectronNode,
  isWindows,
} from '@opensumi/ide-core-node';
import { process as processUtil } from '@opensumi/ide-utils';

import {
  CONNECTION_HANDLE_BETWEEN_EXTENSION_AND_MAIN_THREAD,
  ExtensionActivationDiagnosticMessage,
  ExtensionHostProcessLease,
  ICreateProcessOptions,
  IExtensionHostManager,
  IExtensionMetaData,
  IExtensionNodeClientService,
  IExtensionNodeService,
  IExtraMetaData,
  KT_APP_CONFIG_KEY,
  KT_PROCESS_SOCK_OPTION_KEY,
  Output,
  OutputType,
  ProcessMessageType,
} from '../common';

import {
  ExtensionHostProcessLeaseObserver,
  IExtensionHostProcessLeaseManager,
  createExtensionHostProcessLeaseManager,
} from './extension-host-process-manager';
import {
  EXTENSION_HOST_PROFILER_TARGET_READER,
  type ExtensionHostProfilerTarget,
  type ExtensionHostRuntimeProfilerTargetReader,
} from './extension-host-profiler-coordinator';
import { ExtensionHostRuntimeHandle, ExtensionHostRuntimeSnapshot } from './extension-host-runtime';
import {
  ExtensionHostSessionCreationToken,
  ExtensionHostSessionMainThreadToken,
  ExtensionHostSessionSlot,
  ExtensionHostSessionSlotRegistry,
} from './extension-host-session-slot';
import { ExtensionScanner } from './extension.scanner';

import type cp from 'child_process';

type ExtensionHostServicePhase = 'running' | 'draining' | 'disposed';

@Injectable()
export class ExtensionNodeServiceImpl implements IExtensionNodeService, ExtensionHostRuntimeProfilerTargetReader {
  private LOG_TAG = 'ExtensionNodeServiceImpl:' + Date.now();
  static MaxExtProcessCount = 3;
  static MaxActivationDiagnosticsPerHost = 64;
  static MaxReportedActivationDiagnostics = 10;
  static ExtensionHostStartupTimeout = 15_000;
  // ws 断开 5 分钟后杀掉插件进程
  static ProcessCloseExitThreshold: number = 5 * 60 * 1000;

  @Autowired(INodeLogger)
  private readonly logger: INodeLogger;

  private readonly extHostLogger = getDebugLogger(SupportLogNamespace.ExtensionHost);

  @Autowired(AppConfig)
  private appConfig: AppConfig;

  @Autowired(IReporterService)
  reporterService: IReporterService;

  @Autowired(IReporter)
  reporter: IReporter;

  @Autowired(IExtensionHostManager)
  private extensionHostManager: IExtensionHostManager;

  private extensionHostProcessManager: IExtensionHostProcessLeaseManager | undefined;

  @Autowired(CommonChannelPathHandler)
  private commonChannelPathHandler: CommonChannelPathHandler;

  /** The session registry is the sole owner of client-scoped mutable state. */
  private nextRuntimeGeneration = 1;
  private extensionHostCreationQueue: Promise<void> = Promise.resolve();
  private sessionSlots: ExtensionHostSessionSlotRegistry | undefined = new ExtensionHostSessionSlotRegistry();
  private servicePhase: ExtensionHostServicePhase = 'running';
  private disposeAllPromise: Promise<void> | undefined;
  private managerEpochLossDisposable: IDisposable | undefined;
  private extensionHostCounters: ExtensionHostRuntimeStatus['counters'] = {
    created: 0,
    crashed: 0,
    disposed: 0,
    reclaimed: 0,
    rejected: 0,
    startupTimeouts: 0,
  };

  private inspectPort = 9889;

  private extensionScanner: ExtensionScanner;

  private readonly onDidSetInspectPort = new Emitter<void>();

  public setConnectionServiceClient(clientId: string, serviceClient: IExtensionNodeClientService): void {
    this.getSessionSlotRegistry().getOrCreate(clientId).attachFacade(serviceClient);
    this.reportExtensionHostStatus();
  }

  public registerConnectionServiceClient(clientId: string, serviceClient: IExtensionNodeClientService): () => void {
    // Dispatch through the legacy method so existing subclasses keep their
    // registration behavior while the built-in lifecycle gains a disposer.
    this.setConnectionServiceClient(clientId, serviceClient);
    return () => {
      const slot = this.getSessionSlotRegistry().get(clientId);
      if (!slot?.releaseFacade(serviceClient)) {
        return;
      }
      if (slot.currentRuntime || slot.creationPromise) {
        slot.markDisconnected();
        this.closeExtProcessWhenConnectionClose(clientId);
      }
      this.getSessionSlotRegistry().deleteIfCollectible(slot);
      this.reportExtensionHostStatus();
    };
  }

  public async initialize() {
    const processManager = this.getExtensionHostProcessManager();
    await processManager.init();
    this.managerEpochLossDisposable?.dispose();
    this.managerEpochLossDisposable = processManager.onDidLoseProcessEpoch?.((loss) => {
      void this.handleManagerProcessEpochLoss(loss.epoch, loss.reason);
    });
    this.setExtProcessConnectionForward();
    this.reportExtensionHostStatus();
    this.scheduleExtensionScanPrewarm();
  }

  /**
   * Scanning a 100+ extension directory takes seconds on the first request.
   * Doing it at server startup — before any browser connects — means the
   * first user's `metadata-rpc` phase is a cache hit instead of a cold scan.
   */
  private scheduleExtensionScanPrewarm() {
    const extensionDir = this.appConfig?.marketplace?.extensionDir || process.env.OPENSUMI_EXTENSION_DIR;
    if (!extensionDir) {
      return;
    }
    const localization = 'en-US';
    const extraMetaData = {};
    // Defer past the immediate boot path; the scan itself is all-IO and safe
    // to run alongside the WebSocket handshake setup.
    setTimeout(() => {
      void this.prewarmExtensionScan([extensionDir], localization, extraMetaData);
    }, 200);
    // Warm the extension host module cache: fork() pays a V8 compile cost on
    // first load that every subsequent fork reuses; paying it during server
    // boot makes the first client's ext host spawn noticeably faster.
    setTimeout(() => {
      try {
        const extHostEntry = process.env.EXTENSION_HOST_ENTRY;
        if (extHostEntry) {
          require.resolve(extHostEntry);
        }
      } catch {
        // The entry may not be resolvable in the server process context;
        // this is a best-effort optimization.
      }
    }, 100);
  }

  private getExtensionHostProcessManager(): IExtensionHostProcessLeaseManager {
    return (this.extensionHostProcessManager ??= createExtensionHostProcessLeaseManager(this.extensionHostManager));
  }

  private isExtensionActivationDiagnosticsEnabled(): boolean {
    return (
      Boolean(this.appConfig.extensionHostActivationDiagnostics) ||
      ['1', 'enabled'].includes(process.env.EXTENSION_HOST_ACTIVATION_DIAGNOSTICS || '')
    );
  }

  private reportExtensionHostStatus() {
    const listener = this.appConfig.onDidChangeExtensionHostStatus;
    if (!listener) {
      return;
    }
    const limit = this.appConfig.maxExtProcessCount || ExtensionNodeServiceImpl.MaxExtProcessCount;
    const slots = this.getSessionSlotRegistry().values();
    const runtimes = this.getRuntimeHandles();
    const disconnected = slots.filter(
      (slot) => slot.currentRuntime && (slot.disconnected || slot.disconnectLease),
    ).length;
    const phaseCounts: Record<ExtensionHostRuntimePhase, number> = {
      created: 0,
      listening: 0,
      starting: 0,
      ready: 0,
      stopping: 0,
      stopped: 0,
      failed: 0,
      crashed: 0,
    };
    let mainThreadBridges = 0;
    for (const handle of runtimes) {
      const snapshot = handle.snapshot();
      phaseCounts[snapshot.phase] += 1;
      mainThreadBridges += snapshot.hasMainThreadBridge ? 1 : 0;
    }
    try {
      const activationDiagnostics = this.summarizeExtensionActivationDiagnostics();
      listener({
        servicePhase: this.servicePhase,
        active: runtimes.length,
        pendingCreations: slots.filter((slot) => slot.creationPromise).length,
        disconnected,
        clientServiceProxies: slots.filter((slot) => slot.facade).length,
        mainThreadConnections: slots.filter((slot) => slot.mainThreadChannel).length,
        mainThreadBridges,
        limit,
        saturated: runtimes.length >= limit,
        phaseCounts,
        counters: { ...this.extensionHostCounters },
        ...(activationDiagnostics ? { activationDiagnostics } : {}),
      });
    } catch (error) {
      this.logger.warn('Report extension host status failed', error);
    }
  }

  private summarizeExtensionActivationDiagnostics():
    NonNullable<ExtensionHostRuntimeStatus['activationDiagnostics']> | undefined {
    if (!this.isExtensionActivationDiagnosticsEnabled() || this.getRuntimeHandles().length === 0) {
      return undefined;
    }

    const summaries = new Map<
      string,
      NonNullable<ExtensionHostRuntimeStatus['activationDiagnostics']>['topExtensions'][number]
    >();
    let reportedHosts = 0;
    for (const handle of this.getRuntimeHandles()) {
      const hostDiagnostics = handle.activationDiagnostics;
      if (hostDiagnostics.size === 0) {
        continue;
      }
      reportedHosts += 1;
      for (const diagnostic of hostDiagnostics.values()) {
        const summary = summaries.get(diagnostic.extensionId) || {
          extensionId: diagnostic.extensionId,
          reportingHosts: 0,
          activationCount: 0,
          failureCount: 0,
          maxActivationDurationMs: 0,
          maxModuleCount: 0,
          maxSubscriptionCount: 0,
          maxObservedHeapUsedBytes: 0,
          maxObservedRssBytes: 0,
          maxPositiveHeapUsedDeltaBytes: 0,
          maxPositiveRssDeltaBytes: 0,
        };
        summary.reportingHosts += 1;
        summary.activationCount += diagnostic.activationCount;
        summary.failureCount += diagnostic.failureCount;
        summary.maxActivationDurationMs = Math.max(summary.maxActivationDurationMs, diagnostic.maxActivationDurationMs);
        summary.maxModuleCount = Math.max(summary.maxModuleCount, diagnostic.maxModuleCount);
        summary.maxSubscriptionCount = Math.max(summary.maxSubscriptionCount, diagnostic.maxSubscriptionCount);
        summary.maxObservedHeapUsedBytes = Math.max(
          summary.maxObservedHeapUsedBytes,
          diagnostic.maxObservedHeapUsedBytes,
        );
        summary.maxObservedRssBytes = Math.max(summary.maxObservedRssBytes, diagnostic.maxObservedRssBytes);
        summary.maxPositiveHeapUsedDeltaBytes = Math.max(
          summary.maxPositiveHeapUsedDeltaBytes,
          diagnostic.maxPositiveHeapUsedDeltaBytes,
        );
        summary.maxPositiveRssDeltaBytes = Math.max(
          summary.maxPositiveRssDeltaBytes,
          diagnostic.maxPositiveRssDeltaBytes,
        );
        summaries.set(diagnostic.extensionId, summary);
      }
    }

    if (reportedHosts === 0) {
      return undefined;
    }

    return {
      reportedHosts,
      topExtensions: Array.from(summaries.values())
        .sort(
          (left, right) =>
            right.maxPositiveHeapUsedDeltaBytes - left.maxPositiveHeapUsedDeltaBytes ||
            right.maxModuleCount - left.maxModuleCount ||
            left.extensionId.localeCompare(right.extensionId),
        )
        .slice(0, ExtensionNodeServiceImpl.MaxReportedActivationDiagnostics),
    };
  }

  private recordExtensionActivationDiagnostic(handle: ExtensionHostRuntimeHandle, value: unknown): void {
    if (!this.isExtensionActivationDiagnosticsEnabled()) {
      return;
    }
    if (!this.isCurrentRuntime(handle) || !handle.canPublish) {
      return;
    }
    const diagnostic = this.normalizeExtensionActivationDiagnostic(value);
    if (!diagnostic) {
      return;
    }

    const hostDiagnostics = handle.activationDiagnostics;
    const existing = hostDiagnostics.get(diagnostic.extensionId);
    if (existing) {
      existing.activationCount += 1;
      existing.failureCount += diagnostic.failed ? 1 : 0;
      existing.maxActivationDurationMs = Math.max(existing.maxActivationDurationMs, diagnostic.durationMs);
      existing.maxModuleCount = Math.max(existing.maxModuleCount, diagnostic.moduleCount);
      existing.maxSubscriptionCount = Math.max(existing.maxSubscriptionCount, diagnostic.subscriptionCount);
      existing.maxObservedHeapUsedBytes = Math.max(existing.maxObservedHeapUsedBytes, diagnostic.heapUsedBytes);
      existing.maxObservedRssBytes = Math.max(existing.maxObservedRssBytes, diagnostic.rssBytes);
      existing.maxPositiveHeapUsedDeltaBytes = Math.max(
        existing.maxPositiveHeapUsedDeltaBytes,
        diagnostic.heapUsedDeltaBytes,
      );
      existing.maxPositiveRssDeltaBytes = Math.max(existing.maxPositiveRssDeltaBytes, diagnostic.rssDeltaBytes);
    } else {
      if (hostDiagnostics.size >= ExtensionNodeServiceImpl.MaxActivationDiagnosticsPerHost) {
        const oldestExtensionId = hostDiagnostics.keys().next().value;
        if (oldestExtensionId) {
          hostDiagnostics.delete(oldestExtensionId);
        }
      }
      hostDiagnostics.set(diagnostic.extensionId, {
        extensionId: diagnostic.extensionId,
        activationCount: 1,
        failureCount: diagnostic.failed ? 1 : 0,
        maxActivationDurationMs: diagnostic.durationMs,
        maxModuleCount: diagnostic.moduleCount,
        maxSubscriptionCount: diagnostic.subscriptionCount,
        maxObservedHeapUsedBytes: diagnostic.heapUsedBytes,
        maxObservedRssBytes: diagnostic.rssBytes,
        maxPositiveHeapUsedDeltaBytes: Math.max(0, diagnostic.heapUsedDeltaBytes),
        maxPositiveRssDeltaBytes: Math.max(0, diagnostic.rssDeltaBytes),
      });
    }
    this.reportExtensionHostStatus();
  }

  private normalizeExtensionActivationDiagnostic(value: unknown): ExtensionActivationDiagnosticMessage | undefined {
    if (!value || typeof value !== 'object') {
      return undefined;
    }
    const candidate = value as Partial<ExtensionActivationDiagnosticMessage>;
    const extensionId = typeof candidate.extensionId === 'string' ? candidate.extensionId.trim() : '';
    if (!/^[a-z0-9][a-z0-9._-]{0,255}$/i.test(extensionId) || typeof candidate.failed !== 'boolean') {
      return undefined;
    }

    const nonNegativeFields = ['durationMs', 'moduleCount', 'subscriptionCount', 'heapUsedBytes', 'rssBytes'] as const;
    const deltaFields = ['heapUsedDeltaBytes', 'rssDeltaBytes'] as const;
    if (
      nonNegativeFields.some((field) => !Number.isSafeInteger(candidate[field]) || (candidate[field] as number) < 0) ||
      deltaFields.some((field) => !Number.isSafeInteger(candidate[field]))
    ) {
      return undefined;
    }
    return candidate as ExtensionActivationDiagnosticMessage;
  }

  private cachedScanKey: string | undefined;
  private cachedScanResult: Promise<IExtensionMetaData[]> | undefined;

  public async getAllExtensions(
    scan: string[],
    extensionCandidate: string[],
    localization: string,
    extraMetaData: IExtraMetaData = {},
  ): Promise<IExtensionMetaData[]> {
    // The extension directory is static for the lifetime of a workspace;
    // re-creating a scanner on every connection re-reads 100+ package.json
    // files each time. Cache by scan inputs so only the first request pays.
    const cacheKey = JSON.stringify([scan, extensionCandidate, localization, extraMetaData]);
    if (this.cachedScanKey === cacheKey && this.cachedScanResult) {
      return this.cachedScanResult;
    }
    // 扫描内置插件和插件市场的插件目录
    this.extensionScanner = new ExtensionScanner(
      [...scan, this.appConfig.marketplace.extensionDir],
      localization,
      extensionCandidate,
      extraMetaData,
      {
        builtinDirectory: process.env.OPENSUMI_BUILTIN_EXTENSION_DIR,
        manifestPath: process.env.OPENSUMI_BUILTIN_EXTENSION_MANIFEST,
        cacheMutable: true,
      },
    );
    const scanPromise = this.extensionScanner.run();
    this.cachedScanKey = cacheKey;
    this.cachedScanResult = scanPromise;
    // A failed scan must not poison the cache for the process lifetime.
    void scanPromise.catch(() => {
      if (this.cachedScanKey === cacheKey) {
        this.cachedScanKey = undefined;
        this.cachedScanResult = undefined;
      }
    });
    return scanPromise;
  }

  public async prewarmExtensionScan(
    scan: string[],
    localization: string,
    extraMetaData: IExtraMetaData = {},
  ): Promise<void> {
    try {
      await this.getAllExtensions(scan, [], localization, extraMetaData);
      this.logger.log('[extension-perf] prewarmed extension scan');
    } catch (error) {
      this.logger.warn?.(`[extension-perf] prewarm failed: ${error}`);
    }
  }

  async getExtension(
    extensionPath: string,
    localization: string,
    extraMetaData?: IExtraMetaData,
  ): Promise<IExtensionMetaData | undefined> {
    return await ExtensionScanner.getExtension(extensionPath, localization, extraMetaData);
  }

  private async getIPCHandlerPath(name: string) {
    return await normalizedIpcHandlerPathAsync(name, true, this.appConfig.extHostIPCSockPath);
  }

  public async getExtServerListenOption(
    clientId: string,
    extensionConnectOption?: ExtensionConnectOption,
  ): Promise<net.ListenOptions> {
    const current = this.getSessionSlotRegistry().get(clientId)?.currentRuntime;
    if (current?.listenOptions) {
      return current.listenOptions;
    }
    return this.createExtServerListenOption(extensionConnectOption);
  }

  private async getRuntimeListenOption(
    handle: ExtensionHostRuntimeHandle,
    extensionConnectOption?: ExtensionConnectOption,
  ): Promise<net.ListenOptions> {
    if (handle.listenOptions) {
      return handle.listenOptions;
    }
    const options = await this.createExtServerListenOption(extensionConnectOption);
    if (!this.isCurrentRuntime(handle) || !handle.canPublish) {
      throw this.createStaleRuntimeError(handle);
    }
    handle.setListenOptions(options);
    return options;
  }

  private async createExtServerListenOption(
    extensionConnectOption?: ExtensionConnectOption,
  ): Promise<net.ListenOptions> {
    const { mode = ExtensionConnectModeOption.IPC, host } = extensionConnectOption || {};
    const options: net.ListenOptions = {};

    if (mode === ExtensionConnectModeOption.IPC) {
      options.path = await this.getIPCHandlerPath('ext_process');
    } else {
      options.port = await findFreePort(this.inspectPort, 10, 5000);
      options.host = host;
    }

    return options;
  }

  public async getElectronMainThreadListenPath(clientId: string): Promise<string> {
    return this.getSessionSlotRegistry()
      .getOrCreate(clientId)
      .getElectronMainThreadListenPath(() => this.getIPCHandlerPath('main_thread'));
  }

  private setExtProcessConnectionForward() {
    this.logger.log('setExtProcessConnectionForward', this.LOG_TAG);
    this._setMainThreadConnection(async ({ channel, clientId, slot, token }) => {
      this.reportExtensionHostStatus();

      const handle = this.getSessionSlotRegistry().get(clientId)?.currentRuntime;
      if (handle) {
        try {
          await handle.connectionReady.promise;
        } catch {
          // A stopped or superseded generation cannot accept a new bridge.
        }
      }

      if (!slot.isCurrentMainThread(token)) {
        this.logger.log(`Ignore stale Extension Main Thread connection setup for ${clientId}`);
        return;
      }

      const extProcessId = handle?.processId;
      const extProcessNotExist =
        extProcessId === undefined ||
        !this.isCurrentRuntime(handle) ||
        !(await handle.isProcessRunning()) ||
        !handle.connection;

      // Process inspection can yield while a new channel or generation takes over.
      if (!slot.isCurrentMainThread(token) || (slot.currentRuntime && slot.currentRuntime !== handle)) {
        return;
      }

      if (extProcessNotExist) {
        this.logger.error(`${clientId} clientId process connection not exists, try to notify client to restart`);
        /**
         * 如果前端与后端连接后发现没有对应的插件进程实例，那么通知前端重启插件进程
         * 已知如下场景会出现这种情况：
         * 1. 用户关闭电脑超过 ProcessCloseExitThreshold 设定的最大时间，插件进程被杀死后，前端再次建立连接时
         * 2. Node 进程被杀死，插件进程也会被杀死
         */
        await this.restartExtProcessByClient(clientId);
        this.reporterService.point(REPORT_NAME.EXTENSION_NOT_EXIST, clientId);
        return;
      }

      if (!handle.replaceMainThreadBridge(channel)) {
        await this.restartExtProcessByClient(clientId);
        return;
      }

      if (!slot.commitMainThreadConnection(token)) {
        handle.detachMainThreadBridge();
        return;
      }

      this.reportExtensionHostStatus();
      this.logger.log(`setExtProcessConnectionForward clientId ${clientId}`);
    });
  }

  public createProcess(clientId: string, options?: ICreateProcessOptions): Promise<void> {
    this.assertServiceRunning();
    const slot = this.getSessionSlotRegistry().getOrCreate(clientId);
    if (slot.creationPromise) {
      return slot.creationPromise;
    }
    const creation = slot.runCreation((token) =>
      this.runWithExtensionHostCreationLock(() => this.createProcessWithCapacity(slot, token, options)),
    );
    const settled = () => {
      this.getSessionSlotRegistry().deleteIfCollectible(slot);
      this.reportExtensionHostStatus();
    };
    void creation.then(settled, settled);
    return creation;
  }

  private async runWithExtensionHostCreationLock<T>(task: () => Promise<T>): Promise<T> {
    const previous = this.extensionHostCreationQueue;
    let release: () => void = () => undefined;
    this.extensionHostCreationQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      this.assertServiceRunning();
      return await task();
    } finally {
      release();
    }
  }

  private async createProcessWithCapacity(
    slot: ExtensionHostSessionSlot,
    token: ExtensionHostSessionCreationToken,
    options?: ICreateProcessOptions,
  ): Promise<void> {
    const { clientId } = slot;
    this.logger.log(this.LOG_TAG, 'create extension process for client:', clientId);
    this.logger.log('appconfig exthost', this.appConfig.extHost);

    const existing = this.getSessionSlotRegistry().get(clientId)?.currentRuntime;
    const existingProcessId = existing?.processId;
    if (existing) {
      if (existing.canPublish && existingProcessId !== undefined && (await existing.isProcessRunning())) {
        this.logger.log(
          `Reuse existing Extension Host ${existingProcessId} for client ${clientId} generation ${existing.generation}`,
        );
        return;
      }
      await this.retireRuntime(existing, false, false);
    }

    this.assertServiceRunning();
    await this.ensureExtensionHostCapacity(clientId);
    this.assertExtensionHostClientConnected(clientId);

    const handle = new ExtensionHostRuntimeHandle(
      clientId,
      this.nextRuntimeGeneration++,
      this.getExtensionHostProcessManager(),
      this.logger,
    );
    if (!slot.publishRuntime(token, handle)) {
      await handle.stop({ gracefulTimeoutMs: 0, killProcess: false });
      throw this.createStaleRuntimeError(handle);
    }
    this.reportExtensionHostStatus();
    try {
      await this._createExtServer(handle, options);
      this.assertRuntimeCanContinue(handle);
      await this._createExtHostProcess(handle, options);
      this.assertRuntimeCanContinue(handle);
    } catch (error) {
      handle.markFailed(error);
      await this.retireRuntime(handle, false, true);
      throw error;
    }
  }

  private assertExtensionHostClientConnected(clientId: string): void {
    if (!this.getSessionSlotRegistry().get(clientId)?.disconnected) {
      return;
    }
    const error = new Error(`Extension host client ${clientId} disconnected during startup`);
    error.name = 'ExtensionHostClientDisconnectedError';
    throw error;
  }

  private async ensureExtensionHostCapacity(clientId: string): Promise<void> {
    const maxExtProcessCount = this.appConfig.maxExtProcessCount || ExtensionNodeServiceImpl.MaxExtProcessCount;
    if (this.getRuntimeHandles().length < maxExtProcessCount) {
      return;
    }

    // Only reclaim disconnected or already-dead hosts. An active session must
    // never be evicted just because a new browser reached the server later.
    for (const handle of this.getRuntimeHandles()) {
      const trackedClientId = handle.clientId;
      const slot = this.getSessionSlotRegistry().get(trackedClientId)!;
      const processId = handle.processId;
      const disconnected = slot.disconnected || Boolean(slot.disconnectLease);
      const running = disconnected || processId === undefined ? true : await handle.isProcessRunning();
      if (disconnected || !running) {
        this.logger.warn(
          `Reclaim Extension Host ${processId ?? 'starting'} generation ${handle.generation} ` +
            `for ${trackedClientId} before admitting ${clientId}`,
        );
        this.extensionHostCounters.reclaimed += 1;
        await this.retireRuntime(handle, false, running);
        if (this.getRuntimeHandles().length < maxExtProcessCount) {
          return;
        }
      }
    }

    const error = new Error(
      `Extension host capacity reached (${this.getRuntimeHandles().length}/${maxExtProcessCount}); ` +
        `client ${clientId} was not admitted`,
    );
    error.name = 'ExtensionHostCapacityError';
    this.extensionHostCounters.rejected += 1;
    this.reportExtensionHostStatus();
    this.logger.error(error.message);
    throw error;
  }

  private async _createExtServer(handle: ExtensionHostRuntimeHandle, options?: ICreateProcessOptions) {
    // 创建插件进程监听的 socket
    const extServerListenOptions = await this.getRuntimeListenOption(handle, options?.extensionConnectOption);
    // 先使用单个 server，再尝试单个 server 与多个进程进行连接
    const extServer = net.createServer();
    if (!handle.attachServer(extServer)) {
      throw this.createStaleRuntimeError(handle);
    }

    extServer.on('connection', (socket) => {
      this.logger.log(`_setupExtHostConnection Extension Host connected for ${handle.clientId}#${handle.generation}`);
      if (!this.isCurrentRuntime(handle) || !handle.canPublish) {
        socket.destroy();
        return;
      }
      // A generation owns exactly one Extension Host socket. Rejecting a
      // second socket prevents a late generation from replacing the data plane.
      const accepted = handle.attachConnection(new NetSocketConnection(socket));
      if (!accepted) {
        this.logger.warn(`Reject duplicate Extension Host connection for ${handle.clientId}#${handle.generation}`);
      }
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        reject(error);
      };
      extServer.once('error', onError);
      extServer.listen(extServerListenOptions, () => {
        extServer.off('error', onError);
        extServer.on('error', (error) => {
          this.logger.error(`Extension Host IPC server failed for ${handle.clientId}#${handle.generation}`, error);
        });
        this.logger.log(
          `${handle.clientId}#${handle.generation} ext server listen on ${JSON.stringify(extServerListenOptions)}`,
        );
        resolve();
      });
    });
    this.assertRuntimeCanContinue(handle);
  }

  private async _createExtHostProcess(handle: ExtensionHostRuntimeHandle, options?: ICreateProcessOptions) {
    const { clientId } = handle;
    let preloadPath: string;
    let forkOptions: cp.ForkOptions = {
      // 防止 childProcess.stdout 为 null
      silent: true,
      env: {
        // 显式设置 env，因为需要和插件运行环境的 env merge
        ...process.env,
        ...options?.extHostSpawnOptions?.env,
      },
    };
    // 软链模式下的路径兼容性存在问题
    if (isElectronNode()) {
      this.logger.verbose('try get shell path for extension process');
      let shellPath: string | undefined;
      try {
        shellPath = (await getShellPath()) || '';
        // 在某些机型上，可能存在由于权限问题导致的获取的 shell path 比当前给的 path 还少的情况，这种情况下对 PATH 做一下 merge
        if (shellPath && process.env.PATH) {
          const paths = shellPath.split(':');
          process.env.PATH.split(':').forEach((path) => {
            if (paths.indexOf(path) === -1) {
              paths.push(path);
            }
          });
          shellPath = paths.join(':');
        }
        this.logger.verbose('shell path result: ' + shellPath);
      } catch (e) {
        this.logger.error('shell path error: ', e);
      }
      forkOptions = {
        ...forkOptions,
        env: {
          ...forkOptions.env,
          // 可能会有获取失败的情况
          PATH: shellPath ? shellPath : process.env.PATH,
        },
      };
    }
    const forkArgs: string[] = [];
    const extServerListenOption = await this.getRuntimeListenOption(handle, options?.extensionConnectOption);

    let extProcessPath: string;
    forkOptions.execArgv = [];
    // Node 21+ exposes navigator. Legacy VS Code extensions use its presence
    // to detect a browser host and would disable Node language services.
    if (!isElectronNode() && process.allowedNodeEnvironmentFlags.has('--no-experimental-global-navigator')) {
      forkOptions.execArgv.push('--no-experimental-global-navigator');
    }

    forkArgs.push(`--${KT_PROCESS_SOCK_OPTION_KEY}=${JSON.stringify(extServerListenOption)}`);

    if (isElectronNode()) {
      extProcessPath = this.appConfig.extHost || (process.env.EXTENSION_HOST_ENTRY as string);
    } else {
      preloadPath =
        process.env.EXT_MODE === 'js'
          ? path.join(__dirname, '../../lib/hosted/ext.host.js')
          : path.join(__dirname, '../hosted/ext.host.' + processUtil.extFileType);
      if (process.env.EXT_MODE !== 'js' && processUtil.extFileType === 'ts') {
        forkOptions.execArgv = forkOptions.execArgv.concat(['-r', 'ts-node/register', '-r', 'tsconfig-paths/register']);
      }

      forkArgs.push(`--kt-process-preload=${preloadPath}`);
      if (this.appConfig.extHost) {
        extProcessPath = this.appConfig.extHost;
      } else {
        extProcessPath =
          process.env.EXT_MODE === 'js'
            ? path.join(__dirname, '../../hosted/ext.process.js')
            : path.join(__dirname, '../hosted/ext.process.' + processUtil.extFileType);
      }
    }
    this.logger.log(`Extension host process path ${extProcessPath}`);

    // 注意只能传递可以序列化的数据
    forkArgs.push(
      `--${KT_APP_CONFIG_KEY}=${JSON.stringify({
        logDir: this.appConfig.logDir,
        logLevel: this.appConfig.logLevel,
        extLogServiceClassPath: this.appConfig.extLogServiceClassPath,
        extensionHostActivationDiagnostics: this.isExtensionActivationDiagnosticsEnabled(),
      })}`,
    );

    let configuredInspectPort: number | undefined;
    if (options?.enableDebugExtensionHost || isDevelopment()) {
      // 开发模式下指定调试端口时，尝试从指定的端口开始寻找可用的空闲端口
      // 避免打开多个窗口(多个插件进程)时端口被占用

      const port = await this.getExtensionHostProcessManager().findDebugPort(this.inspectPort, 10, 5000);
      forkOptions.execArgv.push('--nolazy');
      if (options?.inspectExtensionHost) {
        forkOptions.execArgv.push(`--inspect=${options.inspectExtensionHost}:${port}`);
      } else {
        forkOptions.execArgv.push(`--inspect=${port}`);
      }
      configuredInspectPort = port;
    }

    if (options?.extHostSpawnOptions?.execArgv) {
      forkOptions.execArgv = forkOptions.execArgv.concat(options.extHostSpawnOptions.execArgv);
    }

    const forkTimer = this.reporterService.time(`${clientId} fork ext process`);
    const configuredForkOptions = this.appConfig.extHostForkOptions;
    const combinedForkOptions: cp.ForkOptions = {
      ...forkOptions,
      ...configuredForkOptions,
      execArgv: [...forkOptions.execArgv, ...(configuredForkOptions?.execArgv || [])],
    };
    const observer: ExtensionHostProcessLeaseObserver = {
      onMessage: (processLease, message) => this.handleProcessMessage(handle, processLease, forkTimer, message),
      onOutput: (processLease, output) => this.handleProcessOutput(handle, processLease, output),
      onExit: (processLease, code, signal) => {
        void this.handleProcessExit(handle, processLease, code, signal);
      },
    };
    const processManager = this.getExtensionHostProcessManager();
    const registration = await processManager.forkWithLease(extProcessPath, forkArgs, combinedForkOptions, observer);
    const { lease } = registration;
    const extProcessId = lease.pid;
    if (!this.isCurrentRuntime(handle) || !handle.attachProcess(registration)) {
      registration.discard();
      try {
        if (await processManager.isRunningLease(lease)) {
          await processManager.treeKillLease(lease);
        }
      } finally {
        await processManager.disposeLease(lease);
      }
      throw this.createStaleRuntimeError(handle);
    }
    if (configuredInspectPort !== undefined) {
      handle.setInspectPort(lease, configuredInspectPort);
    }
    this.extensionHostCounters.created += 1;
    this.logger.log(
      `Fork Extension Host process with id ${extProcessId} generation ${handle.generation} ` +
        `(${this.getRuntimeHandles().length}/${this.appConfig.maxExtProcessCount || ExtensionNodeServiceImpl.MaxExtProcessCount})`,
    );
    this.reportExtensionHostStatus();

    if (!(await handle.isProcessRunning())) {
      throw new Error(`Extension host process ${extProcessId} exited before completing startup`);
    }
  }

  public ensureProcessReady(clientId: string): Promise<boolean> {
    const handle = this.getSessionSlotRegistry().get(clientId)?.currentRuntime;
    if (!handle) {
      return Promise.resolve(false);
    }

    return this.getSessionSlotRegistry()
      .get(clientId)!
      .runReadiness(handle, () => this.ensureRuntimeReady(handle));
  }

  private async ensureRuntimeReady(handle: ExtensionHostRuntimeHandle): Promise<boolean> {
    const { clientId } = handle;
    const startupTimeout =
      this.appConfig.extensionHostStartupTimeout ?? ExtensionNodeServiceImpl.ExtensionHostStartupTimeout;
    try {
      await handle.whenReady(startupTimeout);
      if (!this.isCurrentRuntime(handle)) {
        throw this.createStaleRuntimeError(handle);
      }
      return true;
    } catch (error) {
      if ((error as Error)?.name === 'ExtensionHostStartupTimeoutError') {
        this.logger.error(`Extension Host startup timed out for ${clientId} after ${startupTimeout} ms`);
        this.extensionHostCounters.startupTimeouts += 1;
        this.reportExtensionHostStatus();
      }
      handle.markFailed(error);
      await this.retireRuntime(handle, false, true);
      throw error;
    }
  }

  private handleProcessMessage(
    handle: ExtensionHostRuntimeHandle,
    processLease: ExtensionHostProcessLease,
    forkTimer: IReporterTimer,
    msg: unknown,
  ): void {
    if (!handle.matchesProcess(processLease)) {
      return;
    }
    if (msg === 'finish') {
      handle.markFinished(processLease);
      return;
    }
    if (!this.isCurrentRuntime(handle) || !handle.canPublish) {
      return;
    }
    if (msg === 'ready') {
      if (handle.markChildReady(processLease)) {
        const duration = forkTimer.timeEnd();
        this.logger.log(
          `Starting Extension Host with pid ${processLease.pid} generation ${handle.generation} ` +
            `(fork() took ${duration} ms).`,
        );
      }
    } else if (
      typeof msg === 'object' &&
      msg !== null &&
      'type' in msg &&
      msg.type === ProcessMessageType.EXTENSION_ACTIVATION_DIAGNOSTIC &&
      'data' in msg
    ) {
      this.recordExtensionActivationDiagnostic(handle, msg.data);
    } else if (
      typeof msg === 'object' &&
      msg !== null &&
      'type' in msg &&
      msg.type === ProcessMessageType.REPORTER &&
      'data' in msg
    ) {
      const reporterMessage = msg.data as ReporterProcessMessage;
      if (reporterMessage.reportType === REPORT_TYPE.PERFORMANCE) {
        this.reporter.performance(reporterMessage.name, reporterMessage.data as PerformanceData);
      } else if (reporterMessage.reportType === REPORT_TYPE.POINT) {
        this.reporter.point(reporterMessage.name, reporterMessage.data);
      }
    }
  }

  private handleProcessOutput(
    handle: ExtensionHostRuntimeHandle,
    processLease: ExtensionHostProcessLease,
    output: Output,
  ): void {
    const inspectorUrlMatch = output.data && output.data.match(/ws:\/\/([^\s]+:(\d+)\/[^\s]+)/);
    if (inspectorUrlMatch) {
      const port = Number(inspectorUrlMatch[2]);
      if (this.isCurrentRuntime(handle) && handle.setInspectPort(processLease, port)) {
        this.onDidSetInspectPort.fire();
      }
    } else if (output.type === OutputType.STDERR) {
      this.extHostLogger.error(util.format(output.data, ...output.format));
    } else {
      this.extHostLogger.log(util.format(output.data, ...output.format));
    }
  }

  private async handleProcessExit(
    handle: ExtensionHostRuntimeHandle,
    processLease: ExtensionHostProcessLease,
    code: number,
    signal: string,
  ): Promise<void> {
    this.logger.log(
      `Extension Host process ${processLease.pid} generation ${handle.generation} exit by code ${code} signal ${signal}`,
    );
    const wasCurrent = this.isCurrentRuntime(handle);
    if (handle.markCrashed(processLease, new Error(`Extension Host exited with code ${code} signal ${signal}`))) {
      this.extensionHostCounters.crashed += 1;
      await this.retireRuntime(handle, false, false);
      if (wasCurrent) {
        await this.infoProcessCrash(handle.clientId);
      }
      this.reporterService.point(REPORT_NAME.EXTENSION_CRASH, handle.clientId, {
        code,
        signal,
      });
    } else {
      this.logger.log(`Extension Host process ${processLease.pid} exit by dispose or stale generation`);
    }
  }

  async tryEnableInspectPort(clientId: string, delay?: number): Promise<boolean> {
    const handle = this.getSessionSlotRegistry().get(clientId)?.currentRuntime;
    if (!handle) {
      return false;
    }
    if (typeof handle.inspectPort === 'number') {
      return true;
    }
    const extHostProcessId = handle.processId;
    if (extHostProcessId === undefined) {
      return false;
    }
    if (!(await handle.isProcessRunning())) {
      return false;
    }

    interface ProcessExt {
      _debugProcess?(n: number): any;
    }

    const processManager = this.getExtensionHostProcessManager();
    if (!isWindows) {
      // SIGUSR1 is delivered by the manager that owns the exact lease. This is
      // safe for both local and remote process namespaces.
      await handle.killProcess('SIGUSR1');
      await Promise.race([Event.toPromise(this.onDidSetInspectPort.event), timeout(delay || 1000)]);
      return this.isCurrentRuntime(handle) && typeof handle.inspectPort === 'number';
    }

    if (
      processManager.processControlLocation === 'local' &&
      typeof (process as ProcessExt)._debugProcess === 'function'
    ) {
      // Windows exposes only Node's undocumented PID API. Restrict it to a
      // manager proven to share this process namespace; remote/unknown
      // managers fail closed instead of signaling an unrelated local PID.
      try {
        (process as ProcessExt)._debugProcess!(extHostProcessId);
      } catch (err) {
        this.logger.error(`Enable inspect port error \n ${err.message}`);
        return false;
      }

      await Promise.race([Event.toPromise(this.onDidSetInspectPort.event), timeout(delay || 1000)]);
      return this.isCurrentRuntime(handle) && typeof handle.inspectPort === 'number';
    }

    return false;
  }

  async getProcessInspectPort(clientId: string) {
    const handle = this.getSessionSlotRegistry().get(clientId)?.currentRuntime;
    if (!handle?.processId || !(await handle.isProcessRunning())) {
      return;
    }
    if (!handle || !this.isCurrentRuntime(handle)) {
      return;
    }
    return handle.inspectPort;
  }

  /** Internal atomic projection for profiler and diagnostics adapters. */
  getRuntimeHandleSnapshot(clientId: string): ExtensionHostRuntimeSnapshot | undefined {
    return this.getSessionSlotRegistry().get(clientId)?.currentRuntime?.snapshot();
  }

  /** Node-internal exact target; intentionally not part of IExtensionNodeService or RPC reflection. */
  async [EXTENSION_HOST_PROFILER_TARGET_READER](clientId: string): Promise<ExtensionHostProfilerTarget | undefined> {
    if (!(await this.tryEnableInspectPort(clientId))) {
      return;
    }
    const handle = this.getSessionSlotRegistry().get(clientId)?.currentRuntime;
    const snapshot = handle?.snapshot();
    if (
      !handle ||
      snapshot?.phase !== 'ready' ||
      typeof snapshot.processId !== 'number' ||
      typeof snapshot.inspectPort !== 'number'
    ) {
      return;
    }
    const targetIdentity = handle;
    const isCurrent = () => {
      const current = this.getSessionSlotRegistry().get(clientId)?.currentRuntime;
      const currentSnapshot = current?.snapshot();
      return (
        current === handle &&
        currentSnapshot?.phase === 'ready' &&
        currentSnapshot.processId === snapshot.processId &&
        currentSnapshot.inspectPort === snapshot.inspectPort
      );
    };
    return {
      clientId,
      generation: snapshot.generation,
      identity: targetIdentity,
      inspectPort: snapshot.inspectPort,
      processId: snapshot.processId,
      attach: (resource) => isCurrent() && handle.attachOwnedResource('profiler', resource),
      confirmCurrent: async () => isCurrent(),
      detach: (resource) => {
        handle.detachOwnedResource('profiler', resource);
      },
    };
  }

  private _setMainThreadConnection(
    handler: (connectionResult: {
      channel: WSServerChannel;
      clientId: string;
      slot: ExtensionHostSessionSlot;
      token: ExtensionHostSessionMainThreadToken;
    }) => void | Promise<void>,
  ) {
    this.commonChannelPathHandler.register(CONNECTION_HANDLE_BETWEEN_EXTENSION_AND_MAIN_THREAD, {
      handler: (channel: WSServerChannel, clientId: string) => {
        if (this.getSessionSlotRegistry().phase !== 'accepting') {
          channel.dispose();
          return;
        }
        const slot = this.getSessionSlotRegistry().getOrCreate(clientId);
        const token = slot.beginMainThreadConnection(channel);
        if (!token) {
          channel.dispose();
          return;
        }
        channel.onceClose(() => {
          channel.dispose();
          if (!slot.releaseMainThreadConnection(token)) {
            this.logger.log(`Ignore stale extension main-thread connection close for ${clientId}`);
            return;
          }
          slot.currentRuntime?.detachMainThreadBridge();
          this.logger.log(`The connection client ${clientId} closed`);
          slot.markDisconnected();
          this.reportExtensionHostStatus();
          this.closeExtProcessWhenConnectionClose(clientId);
        });
        void Promise.resolve(handler({ channel, clientId, slot, token })).catch((error) => {
          this.logger.error(`Extension main-thread setup failed for ${clientId}`, error);
          if (slot.releaseMainThreadConnection(token)) {
            slot.currentRuntime?.detachMainThreadBridge();
            slot.markDisconnected();
            channel.dispose();
            this.closeExtProcessWhenConnectionClose(clientId);
          }
        });
      },
      dispose: (channel: unknown, clientId: string) => {
        // The physical browser connection went away. The main-thread channel
        // may never have opened for this client (fast open/close before any
        // extension activation), in which case the channel.onceClose path
        // above never ran even though the forked extension host process is
        // still alive and would leak until the process count saturates. The
        // timer in closeExtProcessWhenConnectionClose is cancel-and-rearm, so
        // running after the channel path stays a single disposal.
        const slot = this.getSessionSlotRegistry().get(clientId);
        if (!slot || (!slot.currentRuntime && !slot.creationPromise && !slot.disconnected)) {
          return;
        }
        if (channel && slot.mainThreadChannel && slot.mainThreadChannel !== channel) {
          return;
        }
        this.logger.log(`The connection client ${clientId} disposed without an open main-thread channel`);
        if (slot.mainThreadToken) {
          slot.releaseMainThreadConnection(slot.mainThreadToken);
        }
        slot.currentRuntime?.detachMainThreadBridge();
        slot.markDisconnected();
        this.reportExtensionHostStatus();
        this.closeExtProcessWhenConnectionClose(clientId);
      },
    });
  }

  private closeExtProcessWhenConnectionClose(connectionClientId: string) {
    // The creator owns cleanup until the host has been registered in the
    // session slot. Scheduling the ordinary disconnect timer here can fire
    // before fork() resolves and leave a newly-created, ownerless host behind.
    const slot = this.getSessionSlotRegistry().get(connectionClientId);
    if (!slot || slot.creationPromise) {
      return;
    }

    if (isElectronNode()) {
      // Release all client-scoped references immediately even when the
      // extension host already exited before the browser connection closed.
      void this.disposeClientExtProcess(connectionClientId, false).catch((error) => this.logger.error(error));
      return;
    }

    const token = slot.markDisconnected();
    if (!token) {
      return;
    }
    const handle = slot.currentRuntime;
    const timer = setTimeout(() => {
      if (!slot.consumeDisconnectLease(token, timer)) {
        return;
      }
      if (handle && !this.isCurrentRuntime(handle)) {
        return;
      }
      this.logger.log(`Dispose client by connectionClientId ${connectionClientId}`);
      if (handle) {
        void this.retireRuntime(handle, false, true).catch((error) => this.logger.error(error));
      } else {
        this.getSessionSlotRegistry().deleteIfCollectible(slot);
      }
    }, this.appConfig.processCloseExitThreshold ?? ExtensionNodeServiceImpl.ProcessCloseExitThreshold);
    timer.unref?.();
    slot.armDisconnectLease(token, timer, handle);
  }

  private cancelExtProcessDisposal(clientId: string) {
    const slot = this.getSessionSlotRegistry().get(clientId);
    if (slot?.disconnectLease) {
      slot.cancelDisconnectLease(slot.disconnectLease.token);
    }
  }

  private async infoProcessNotExist(clientId: string): Promise<void> {
    const clientService = this.getSessionSlotRegistry().get(clientId)?.facade as
      IExtensionNodeClientService | undefined;
    if (!clientService) {
      return;
    }
    try {
      await Promise.resolve(clientService.infoProcessNotExist());
    } catch (error) {
      // The browser can disconnect between selecting the client service and
      // sending the restart notification. Cleanup must not turn that expected
      // race into an unhandled rejection in the server process.
      this.logger.warn(`Notify missing extension host failed for ${clientId}`, error);
    }
  }

  /**
   * 如果插件进程已被销毁，如 websocket 连接断开超过 `ExtensionNodeServiceImpl.ProcessCloseExitThreshold` 时
   * 那么当用户重新连接至服务时，需要通知重启整个插件进程
   */
  private async restartExtProcessByClient(clientId: string): Promise<void> {
    const clientService = this.getSessionSlotRegistry().get(clientId)?.facade as
      IExtensionNodeClientService | undefined;
    if (!clientService) {
      return;
    }
    try {
      await Promise.resolve(clientService.restartExtProcessByClient());
    } catch (error) {
      this.logger.warn(`Restart missing extension host notification failed for ${clientId}`, error);
    }
  }

  private async infoProcessCrash(clientId: string): Promise<void> {
    const clientService = this.getSessionSlotRegistry().get(clientId)?.facade as
      IExtensionNodeClientService | undefined;
    if (!clientService) {
      return;
    }
    try {
      await Promise.resolve(clientService.infoProcessCrash());
    } catch (error) {
      this.logger.warn(`Extension host crash notification failed for ${clientId}`, error);
    }
  }

  public async disposeClientExtProcess(clientId: string, info = true, killProcess = true) {
    this.cancelExtProcessDisposal(clientId);
    const handle = this.getSessionSlotRegistry().get(clientId)?.currentRuntime;
    if (!handle) {
      return;
    }
    await this.retireRuntime(handle, info, killProcess);
  }

  public async getExtProcessId(clientId: string): Promise<number | null> {
    return this.getSessionSlotRegistry().get(clientId)?.currentRuntime?.processId ?? null;
  }

  public async disposeAllClientExtProcess(): Promise<void> {
    if (this.disposeAllPromise) {
      return this.disposeAllPromise;
    }
    this.servicePhase = 'draining';
    this.reportExtensionHostStatus();
    this.disposeAllPromise = this.doDisposeAllClientExtProcess();
    return this.disposeAllPromise;
  }

  private async retireRuntime(handle: ExtensionHostRuntimeHandle, info: boolean, killProcess: boolean): Promise<void> {
    const slot = this.getSessionSlotRegistry().get(handle.clientId);
    if (!slot || handle.phase === 'stopped') {
      return;
    }
    try {
      await slot.runRetirement(handle, () => this.doRetireRuntime(handle, info, killProcess));
    } finally {
      this.getSessionSlotRegistry().deleteIfCollectible(slot);
    }
  }

  private async doRetireRuntime(
    handle: ExtensionHostRuntimeHandle,
    info: boolean,
    killProcess: boolean,
  ): Promise<void> {
    const wasCurrent = this.isCurrentRuntime(handle);
    if (wasCurrent) {
      this.cancelExtProcessDisposal(handle.clientId);
    }
    const report = await handle.stop({
      gracefulTimeoutMs: this.appConfig.extensionHostShutdownTimeout ?? 5_000,
      killProcess,
    });

    const slot = this.getSessionSlotRegistry().get(handle.clientId);
    const removedCurrent = slot?.clearRuntime(handle) ?? false;
    if (report.hadProcess) {
      this.extensionHostCounters.disposed += 1;
    }
    this.reportExtensionHostStatus();

    // Read connection state only after the exact generation has finished. A
    // replacement facade or Host may have arrived while graceful shutdown ran.
    const clientDisconnected = slot?.disconnected;
    if (info && removedCurrent && !clientDisconnected && report.hadProcess) {
      await this.infoProcessNotExist(handle.clientId);
    }
    if (report.hadProcess) {
      this.logger.log(`Extension Host ${handle.clientId}#${handle.generation} process ${report.processId} disposed`);
    }
  }

  private async doDisposeAllClientExtProcess(): Promise<void> {
    const sessionSlots = this.getSessionSlotRegistry();
    const slots = sessionSlots.beginDrain();

    // Closing admission above guarantees this snapshot cannot grow. Waiting
    // first lets an already-entered listen/fork either publish to its captured
    // handle or clean up its late process before we dispose the manager.
    await Promise.all(slots.map((slot) => slot.whenCreationSettled()));
    await this.extensionHostCreationQueue;
    await Promise.allSettled(Array.from(this.getRuntimeHandles(), (handle) => this.retireRuntime(handle, false, true)));

    await Promise.all(slots.map((slot) => slot.whenReadinessSettled()));
    await Promise.all(slots.map((slot) => slot.whenRetirementsSettled()));
    if (!sessionSlots.finishDrain()) {
      throw new Error('Extension Host sessions still own resources after drain');
    }
    this.managerEpochLossDisposable?.dispose();
    this.managerEpochLossDisposable = undefined;
    try {
      await this.getExtensionHostProcessManager().dispose();
    } finally {
      this.servicePhase = 'disposed';
      this.reportExtensionHostStatus();
    }
  }

  private async handleManagerProcessEpochLoss(epoch: number, reason: string): Promise<void> {
    const handles = Array.from(this.getRuntimeHandles());
    if (handles.length === 0) {
      return;
    }
    this.logger.error(
      `Extension Host manager process epoch ${epoch} was lost (${reason}); retiring ${handles.length} runtime(s)`,
    );
    await Promise.allSettled(
      handles.map(async (handle) => {
        const wasCurrent = this.isCurrentRuntime(handle);
        const processLease = handle.processLease;
        if (processLease) {
          if (!handle.markCrashed(processLease, new Error(`Extension Host manager epoch ${epoch} was lost`))) {
            return;
          }
          this.extensionHostCounters.crashed += 1;
        } else if (handle.canPublish) {
          handle.markFailed(new Error(`Extension Host manager epoch ${epoch} was lost during startup`));
        } else {
          return;
        }
        await this.retireRuntime(handle, false, false);
        if (wasCurrent && this.servicePhase === 'running') {
          await this.infoProcessCrash(handle.clientId);
        }
      }),
    );
    this.reportExtensionHostStatus();
  }

  private isCurrentRuntime(handle: ExtensionHostRuntimeHandle | undefined): handle is ExtensionHostRuntimeHandle {
    return Boolean(handle && this.getSessionSlotRegistry().get(handle.clientId)?.currentRuntime === handle);
  }

  private assertRuntimeCanContinue(handle: ExtensionHostRuntimeHandle): void {
    this.assertServiceRunning();
    if (!this.isCurrentRuntime(handle) || !handle.canPublish) {
      throw this.createStaleRuntimeError(handle);
    }
    this.assertExtensionHostClientConnected(handle.clientId);
  }

  private assertServiceRunning(): void {
    if (this.servicePhase === 'running') {
      return;
    }
    const error = new Error(`Extension Host service is ${this.servicePhase}`);
    error.name = 'ExtensionHostServiceDrainingError';
    throw error;
  }

  private createStaleRuntimeError(handle: ExtensionHostRuntimeHandle): Error {
    const error = new Error(`Extension Host ${handle.clientId}#${handle.generation} is no longer the current runtime`);
    error.name = 'StaleExtensionHostRuntimeError';
    return error;
  }

  private getSessionSlotRegistry(): ExtensionHostSessionSlotRegistry {
    return (this.sessionSlots ??= new ExtensionHostSessionSlotRegistry());
  }

  private getRuntimeHandles(): ExtensionHostRuntimeHandle[] {
    return this.getSessionSlotRegistry()
      .values()
      .flatMap((slot) => (slot.currentRuntime ? [slot.currentRuntime] : []));
  }
}
