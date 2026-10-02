import { timingSafeEqual } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

import KoaRouter from '@koa/router';
import Koa from 'koa';
import serveStatic from 'koa-static';

import { Injector } from '@opensumi/di';
import {
  ExtensionHostRuntimeStatus,
  ModuleConstructor,
  ServerApp,
  ServerRuntimeStopOptions,
  ServerRuntimeStopReport,
} from '@opensumi/ide-core-node';
import {
  IExternalFileArgs,
  IExternalUrlArgs,
  IRemoteOpenerClient,
  RemoteOpenerClientToken,
  RemoteOpenerServiceToken,
} from '@opensumi/ide-remote-opener';
import { RemoteOpenerServiceImpl } from '@opensumi/ide-remote-opener/node';

import { resolveMarketplaceExtensionDirectory } from './extension-directory';
import { resolveProductRuntimeMode } from './runtime-mode';
import { RuntimePlanHealthSummary } from './runtime-plan-summary';
import { createWorkspaceAIConfigMiddleware } from './workspace-ai-config';

import type { IServerAppOpts } from '@opensumi/ide-core-node';
import type { RuntimeTopologyServerHandshake } from '@opensumi/ide-startup';

export function createClientStaticMiddleware(directory: string) {
  return serveStatic(directory, {
    setHeaders(response, filename) {
      // HTML 和未带版本的历史入口在发布后必须重新验证缓存。
      const versioned = /\.[a-f0-9]{8}\.(?:js|css)$/.test(path.basename(filename));
      response.setHeader('Cache-Control', versioned ? 'public, max-age=2592000, immutable' : 'no-cache');
    },
  });
}

/* * 当前服务进程所服务的单一工作区标识。 */
export interface ServedWorkspaceIdentity {
  id?: string;
  directory: string;
}

/** 托管协同凭据使用专用应用头，兼容会过滤 Authorization 的沙箱代理。 */
export function authorizeManagedCollaboration(
  request: Pick<http.IncomingMessage, 'headers'>,
  workspace: ServedWorkspaceIdentity | undefined,
  expected: string,
): boolean {
  if (!workspace?.id) {
    return true;
  }
  const supplied =
    request.headers['x-opensumi-runtime-token'] ?? (request.headers.authorization || '').replace(/^Bearer /, '');
  return (
    typeof supplied === 'string' &&
    /^[a-f0-9]{64}$/.test(expected) &&
    /^[a-f0-9]{64}$/.test(supplied) &&
    request.headers['x-workspace-id'] === workspace.id &&
    supplied.length === expected.length &&
    timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
  );
}

/* * 只有 WORKSPACE_DIR 启用目录绑定。控制面会为每个驱动设置它，
 * MY_WORKSPACE 只是开发工具的构建默认值；若将其用于绑定，
 * 独立开发环境的查询参数会被意外覆盖。 */
export function resolveServedWorkspace(env: NodeJS.ProcessEnv = process.env): ServedWorkspaceIdentity | undefined {
  const directory = env.WORKSPACE_DIR;
  if (!directory) {
    return undefined;
  }
  return { id: env.WORKSPACE_ID || undefined, directory };
}

/* * 工作台为每个工作区运行独立 IDE，服务目录属于部署事实。
 * 将目录写入服务端页面，避免客户端从可伪造的查询参数读取目录。
 * 未配置服务端工作区的独立 OpenSumi 仍然使用查询参数。 */
export function createWorkspaceIdentityMiddleware(directory: string, workspace: ServedWorkspaceIdentity) {
  let document: string | undefined;
  return async (context: Koa.Context, next: Koa.Next) => {
    if (!['GET', 'HEAD'].includes(context.method) || !['/', '/index.html'].includes(context.path)) {
      return next();
    }
    document ??= await readFile(path.join(directory, 'index.html'), 'utf8');
    let user: { id: string; nickname: string } | undefined;
    try {
      const candidate = JSON.parse(Buffer.from(context.get('X-Opensumi-User'), 'base64url').toString());
      if (
        /^[a-f0-9]{64}$/.test(candidate.id) &&
        typeof candidate.nickname === 'string' &&
        candidate.nickname.length <= 256
      ) {
        user = candidate;
      }
    } catch {
      /* 独立开发入口没有控制面账户信息。 */
    }
    // 只缓存 HTML 模板，账户声明必须逐请求生成，防止串号与脚本注入。
    const payload = JSON.stringify({
      id: workspace.id,
      workspaceDir: workspace.directory,
      collaboration: process.env.ENABLE_COLLABORATION === '1',
      user,
    }).replace(/</g, '\\u003c');
    const declaration = `<script>window.__OPENSUMI_WORKSPACE__=${payload};</script>`;
    context.set('Cache-Control', 'no-store');
    context.type = 'html';
    context.body = document.includes('</head>')
      ? document.replace('</head>', () => `${declaration}</head>`)
      : declaration + document;
  };
}

export interface StartServerOptions {
  webSocketHandler?: IServerAppOpts['webSocketHandler'];
  modules: ModuleConstructor[];
  injector: Injector;
  mountStaticPath?: string;
  runtimePlanSummary?: RuntimePlanHealthSummary;
  runtimeTopologyHandshake?: RuntimeTopologyServerHandshake;
  exitAfterShutdown?: boolean;
}

interface MemoryStatus {
  ready: boolean;
  limits: {
    heapUsedBytes: number;
    rssBytes: number;
  };
  memory: NodeJS.MemoryUsage;
}

function readPositiveInteger(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

function getMemoryStatus(): MemoryStatus {
  const memory = process.memoryUsage();
  const limits = {
    heapUsedBytes: readPositiveInteger('SERVER_MAX_HEAP_USED_MB', 448) * 1024 * 1024,
    rssBytes: readPositiveInteger('SERVER_MAX_RSS_MB', 768) * 1024 * 1024,
  };
  return {
    ready: memory.heapUsed < limits.heapUsedBytes && memory.rss < limits.rssBytes,
    limits,
    memory,
  };
}

function listenHTTPServer(server: http.Server, options: number | { host: string; port: number }): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    if (typeof options === 'number') {
      server.listen(options);
    } else {
      server.listen(options.port, options.host);
    }
  });
}

interface HTTPServerLifecycle {
  closed: boolean;
  closePromise?: Promise<void>;
  sawListening: boolean;
  whenClosed: Promise<void>;
}

const httpServerLifecycles = new WeakMap<http.Server, HTTPServerLifecycle>();

function observeHTTPServerLifecycle(server: http.Server): HTTPServerLifecycle {
  const existing = httpServerLifecycles.get(server);
  if (existing && !(existing.closed && server.listening)) {
    return existing;
  }

  let resolveClosed!: () => void;
  const lifecycle: HTTPServerLifecycle = {
    closed: false,
    sawListening: server.listening,
    whenClosed: new Promise<void>((resolve) => {
      resolveClosed = resolve;
    }),
  };
  if (!lifecycle.sawListening) {
    server.once('listening', () => {
      lifecycle.sawListening = true;
    });
  }
  server.once('close', () => {
    lifecycle.closed = true;
    resolveClosed();
  });
  httpServerLifecycles.set(server, lifecycle);
  return lifecycle;
}

function closeHTTPServer(server: http.Server, lifecycle = observeHTTPServerLifecycle(server)): Promise<void> {
  // Node HTTP 服务可以反复监听和关闭，因此每次开始监听
  // 都创建新的生命周期，不能复用已经结束的实例。
  if (lifecycle.closed && server.listening) {
    lifecycle = observeHTTPServerLifecycle(server);
  }
  if (lifecycle.closed) {
    return Promise.resolve();
  }
  if (lifecycle.closePromise) {
    return lifecycle.closePromise;
  }
  if (!server.listening) {
    // server.close() 会在活跃请求结束前将 listening 设为 false。
    // 曾经开始监听的服务必须等待 close 事件，才能确认连接已排空。
    return lifecycle.sawListening ? lifecycle.whenClosed : Promise.resolve();
  }

  lifecycle.closePromise = new Promise<void>((resolve, reject) => {
    server.close((error?: Error & { code?: string }) => {
      if (error && error.code !== 'ERR_SERVER_NOT_RUNNING') {
        reject(error);
        return;
      }
      void lifecycle.whenClosed.then(resolve, reject);
    });
  });
  return lifecycle.closePromise;
}

function createRuntimeStartupCancelledError(state: ServerApp['state']): Error {
  const error = new Error(`OpenSumi server startup was cancelled while the runtime was ${state}`);
  error.name = 'ServerRuntimeStartupCancelledError';
  return error;
}

export async function listenHTTPServerForRuntime(
  server: http.Server,
  options: number | { host: string; port: number },
  getRuntimeState: () => ServerApp['state'],
): Promise<void> {
  await listenHTTPServer(server, options);
  if (getRuntimeState() === 'running') {
    return;
  }

  // 信号可能在 listen() 完成前到达。ServerApp 的关闭流程
  // 可能已结束，而且当时未发现监听器，因此产品需要
  // 在报告取消前关闭随后启动的监听器。
  await closeHTTPServer(server);
  throw createRuntimeStartupCancelledError(getRuntimeState());
}

export interface RuntimeShutdownServerApp {
  drain(): Promise<void>;
  stop(options: ServerRuntimeStopOptions): Promise<ServerRuntimeStopReport>;
}

export type RuntimeShutdownOwner = 'http-server';

export interface RuntimeShutdownCoordinatorOptions {
  serverApp: RuntimeShutdownServerApp;
  httpServer: http.Server;
  deadlineMs: number;
  now?: () => number;
  onOwnerError?: (owner: RuntimeShutdownOwner, error: unknown) => void;
}

/* * 协调产品所属资源，不安装进程级全局处理器。
 * 首次调用同步阻止新请求，返回的 Promise 等待已接纳任务结束，
 * 再关闭最终传输资源。后续调用获得同一 Promise 和报告对象。 */
export function createRuntimeShutdownCoordinator({
  serverApp,
  httpServer,
  deadlineMs,
  now = Date.now,
  onOwnerError,
}: RuntimeShutdownCoordinatorOptions): (reason: string) => Promise<ServerRuntimeStopReport> {
  let shutdownPromise: Promise<ServerRuntimeStopReport> | undefined;
  const httpLifecycle = observeHTTPServerLifecycle(httpServer);
  return (reason) => {
    if (shutdownPromise) {
      return shutdownPromise;
    }
    let resolve!: (report: ServerRuntimeStopReport) => void;
    let reject!: (error: unknown) => void;
    // 调用资源所有者之前先保存 Promise，包含同步回调的情况。
    shutdownPromise = new Promise((done, fail) => {
      resolve = done;
      reject = fail;
    });
    const startedAt = now();
    let drain: Promise<void>;
    try {
      drain = serverApp.drain();
    } catch (error) {
      drain = Promise.reject(error);
    }
    void drain.catch(() => undefined);
    // 立即拒绝新 HTTP 请求，升级后的连接由 ServerApp 回收。
    const ingressClosed = closeHTTPServer(httpServer, httpLifecycle).catch((error) => {
      try {
        onOwnerError?.('http-server', error);
      } catch {
        /* 仅用于诊断。 */
      }
      throw error;
    });
    void ingressClosed.catch(() => undefined);
    try {
      void serverApp
        .stop({
          deadlineMs: Math.max(0, deadlineMs - (now() - startedAt)),
          reason,
          beforeSharedOwners: () => ingressClosed,
        })
        .then(resolve, reject);
    } catch (error) {
      reject(error);
    }
    return shutdownPromise;
  };
}

interface RuntimeSignalController {
  requestShutdown(reason: string): Promise<ServerRuntimeStopReport>;
  /* * 启动和回退选择完成后，启用监听器异常关闭的处理。 */
  armServerClose(): void;
}

function installRuntimeSignalHandlers(
  serverApp: ServerApp,
  httpServer: http.Server,
  exitAfterShutdown = false,
): RuntimeSignalController {
  let shutdownPromise: Promise<ServerRuntimeStopReport> | undefined;
  let forceExitTimer: NodeJS.Timeout | undefined;
  let shutdownReport: ServerRuntimeStopReport | undefined;
  let ownerCleanupFailed = false;
  let serverCloseArmed = false;
  const deadlineMs = readPositiveInteger('SERVER_SHUTDOWN_TIMEOUT', 30_000);

  const stopRuntimeOwners = createRuntimeShutdownCoordinator({
    serverApp,
    httpServer,
    deadlineMs,
    onOwnerError: (owner, error) => {
      ownerCleanupFailed = true;
      // eslint-disable-next-line no-console
      console.error(`Failed to stop OpenSumi runtime owner ${owner}`, error);
      process.exitCode = 1;
    },
  });

  const removeSignalHandlers = () => {
    process.off('SIGINT', onSIGINT);
    process.off('SIGTERM', onSIGTERM);
    httpServer.off('close', onServerClose);
  };

  const shutdown = (reason: string): Promise<ServerRuntimeStopReport> => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    // 产品入口负责终止进程，ServerApp 不调用 process.exit；
    // 最长关闭时限用于防止未完成的贡献或传输资源
    // 让进程永久驻留。
    forceExitTimer = setTimeout(() => {
      // eslint-disable-next-line no-console
      console.error(`OpenSumi server shutdown exceeded ${deadlineMs}ms (${reason})`);
      process.exit(1);
    }, deadlineMs);
    forceExitTimer.unref();

    shutdownPromise = stopRuntimeOwners(reason);
    void shutdownPromise
      .then((report) => {
        shutdownReport = report;
        // eslint-disable-next-line no-console
        console.log(`OpenSumi server shutdown: ${JSON.stringify(report)}`);
        if (report.phases.some(({ status }) => status !== 'completed')) {
          process.exitCode = 1;
        }
      })
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error('Failed to stop OpenSumi Node server', error);
        process.exitCode = 1;
      })
      .finally(() => {
        // ServerApp 超时后无法取消任务，最终资源关闭失败也可能
        // 继续持有进程。两种情况均保留强制退出时限，
        // 不提前清除唯一的强制终止保护。
        if (forceExitTimer && shutdownReport && shouldClearRuntimeHardDeadline(shutdownReport, ownerCleanupFailed)) {
          clearTimeout(forceExitTimer);
        }
        removeSignalHandlers();
        if (exitAfterShutdown && shutdownReport && shouldClearRuntimeHardDeadline(shutdownReport, ownerCleanupFailed)) {
          // 原生 PTY 描述符可能在所属资源清理结束后仍未释放。
          // 所有阶段确认完成后，由可执行入口结束进程生命周期。
          process.stdout.write('', () => setImmediate(() => process.exit(process.exitCode || 0)));
        }
      });
    return shutdownPromise;
  };

  const onSIGINT = () => void shutdown('SIGINT');
  const onSIGTERM = () => void shutdown('SIGTERM');
  const onServerClose = () => void shutdown('server-close');
  process.once('SIGINT', onSIGINT);
  process.once('SIGTERM', onSIGTERM);
  return {
    requestShutdown: shutdown,
    armServerClose: () => {
      // 启动后的意外关闭会触发运行时整体关闭。
      if (serverCloseArmed || shutdownPromise) {
        return;
      }
      serverCloseArmed = true;
      httpServer.once('close', onServerClose);
    },
  };
}

export function shouldClearRuntimeHardDeadline(report: ServerRuntimeStopReport, ownerCleanupFailed: boolean): boolean {
  return !ownerCleanupFailed && !report.timedOut && report.phases.every(({ status }) => status === 'completed');
}

export async function startServer({
  modules,
  injector,
  mountStaticPath,
  runtimePlanSummary,
  runtimeTopologyHandshake,
  exitAfterShutdown,
  webSocketHandler,
}: StartServerOptions): Promise<http.Server> {
  const app = new Koa();
  const router = new KoaRouter();
  const rootDirectory = path.resolve(__dirname, '../..');
  const extensionDirectory = path.join(rootDirectory, 'tools/extensions');
  const marketplaceExtensionDirectory = resolveMarketplaceExtensionDirectory(rootDirectory);
  const extensionLogService = path.join(
    __dirname,
    path.extname(__filename) === '.ts' ? 'mock-log-service.ts' : 'mock-log-service.js',
  );
  const extensionHostConfig = {
    activationDiagnosticsEnabled: ['1', 'enabled'].includes(process.env.EXTENSION_HOST_ACTIVATION_DIAGNOSTICS || ''),
    idleTimeoutMs: readPositiveInteger('EXTENSION_HOST_IDLE_TIMEOUT', 60_000),
    limit: readPositiveInteger('MAX_EXTENSION_HOSTS', 3),
    maxOldSpaceSizeMiB: readPositiveInteger('EXTENSION_HOST_MAX_OLD_SPACE_SIZE', 256),
    shutdownTimeoutMs: readPositiveInteger('EXTENSION_HOST_SHUTDOWN_TIMEOUT', 2_000),
    startupTimeoutMs: readPositiveInteger('EXTENSION_HOST_STARTUP_TIMEOUT', 15_000),
  };
  let extensionHostStatus: ExtensionHostRuntimeStatus = {
    servicePhase: 'running',
    active: 0,
    pendingCreations: 0,
    disconnected: 0,
    clientServiceProxies: 0,
    mainThreadConnections: 0,
    mainThreadBridges: 0,
    limit: extensionHostConfig.limit,
    saturated: false,
    phaseCounts: {
      created: 0,
      listening: 0,
      starting: 0,
      ready: 0,
      stopping: 0,
      stopped: 0,
      failed: 0,
      crashed: 0,
    },
    counters: {
      created: 0,
      crashed: 0,
      disposed: 0,
      reclaimed: 0,
      rejected: 0,
      startupTimeouts: 0,
    },
  };
  let serverApp: ServerApp;
  let stopProduct: ((reason: string) => Promise<ServerRuntimeStopReport>) | undefined;
  const identity = () => ({
    workspace: resolveServedWorkspace(),
    pid: process.pid,
    fingerprint: process.env.OPENSUMI_RUNTIME_FINGERPRINT || '',
    node: process.version,
    architecture: process.arch,
  });
  const runtimeAuthorized = (context: Koa.Context) => {
    const expected = process.env.OPENSUMI_RUNTIME_TOKEN || '';
    const supplied = context.get('Authorization').replace(/^Bearer /, '');
    return (
      /^[a-f0-9]{64}$/.test(expected) &&
      /^[a-f0-9]{64}$/.test(supplied) &&
      supplied.length === expected.length &&
      timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))
    );
  };
  router.get('/runtime/identity', (context) => {
    context.set('Cache-Control', 'no-store');
    if (!runtimeAuthorized(context)) {
      context.status = 401;
      context.body = { error: 'runtime-authorization-required' };
      return;
    }
    context.body = identity();
  });
  router.post('/runtime/shutdown', (context) => {
    if (!runtimeAuthorized(context) || !stopProduct) {
      context.status = 401;
      context.body = { error: 'runtime-authorization-required' };
      return;
    }
    context.status = 202;
    context.body = { stopping: true };
    context.res.once('finish', () => void stopProduct!('control-plane'));
  });
  // 新克隆的仓库尚未下载扩展，先创建目录，
  // 让扩展扫描器在首次安装前安静启动。
  await mkdir(extensionDirectory, { recursive: true });
  if (marketplaceExtensionDirectory) {
    await mkdir(marketplaceExtensionDirectory, { recursive: true });
  }

  injector.addProviders({
    token: RemoteOpenerServiceToken,
    useClass: RemoteOpenerServiceImpl,
  });

  router.get('/open', (context) => {
    const openerService: IRemoteOpenerClient = injector.get(RemoteOpenerClientToken);
    try {
      openerService.openExternal(
        context.query as unknown as IExternalFileArgs | IExternalUrlArgs,
        context.query.clientId as unknown as string,
      );
      context.body = 'successful';
    } catch (error) {
      context.status = 500;
      context.body = `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  });

  router.get('/', (context) => {
    context.body = 'OpenSumi';
  });

  router.get(['/health', '/healthz'], (context) => {
    context.body = {
      status: 'ok',
      uptimeSeconds: process.uptime(),
      ...getMemoryStatus(),
      runtimeMode: resolveProductRuntimeMode(process.env),
      runtime: identity(),
      extensionHost: {
        ...extensionHostStatus,
        configured: extensionHostConfig,
        affectsReadiness: false,
      },
      runtimePlan: runtimePlanSummary,
      runtimeTopology: runtimeTopologyHandshake?.getStatus(),
    };
  });

  router.get('/readyz', (context) => {
    const status = getMemoryStatus();
    const ready = status.ready;
    context.status = ready ? 200 : 503;
    context.body = {
      status: ready ? 'ready' : 'memory-pressure',
      ...status,
      ready,
      runtimeMode: resolveProductRuntimeMode(process.env),
      runtime: identity(),
      extensionHost: {
        ...extensionHostStatus,
        configured: extensionHostConfig,
        affectsReadiness: false,
      },
      runtimePlan: runtimePlanSummary,
      runtimeTopology: runtimeTopologyHandshake?.getStatus(),
    };
  });

  const clientDirectory = mountStaticPath || path.join(rootDirectory, 'client/dist');
  const servedWorkspace = resolveServedWorkspace();
  if (servedWorkspace) {
    // 代理发往错误工作区时，不得按当前工作区处理。
    // 控制面转发已经解析的工作区标识；仅拒绝明确的
    // 标识不匹配，保持普通 OpenSumi 客户端兼容。
    app.use(async (context, next) => {
      const requested = context.get('x-workspace-id');
      if (servedWorkspace.id && requested && requested !== servedWorkspace.id) {
        context.status = 421;
        context.body = { error: 'workspace-mismatch' };
        return;
      }
      return next();
    });
    app.use(createWorkspaceIdentityMiddleware(clientDirectory, servedWorkspace));
    if (servedWorkspace.id && process.env.ENABLE_AI === '1') {
      app.use(createWorkspaceAIConfigMiddleware({ home: process.env.HOME || '', workspaceId: servedWorkspace.id }));
    }
  }
  app.use(createClientStaticMiddleware(clientDirectory));
  app.use(router.routes());

  const buildServerAppOptions = () => ({
    injector,
    modules,
    processSignalHandling: 'external' as const,
    use: app.use.bind(app),
    webSocketHandler: webSocketHandler || [],
    marketplace: {
      showBuiltinExtensions: true,
      ...(marketplaceExtensionDirectory ? { extensionDir: marketplaceExtensionDirectory } : {}),
    },
    processCloseExitThreshold: extensionHostConfig.idleTimeoutMs,
    terminalPtyCloseThreshold: readPositiveInteger('TERMINAL_IDLE_TIMEOUT', 30_000),
    terminalPersistentSessionTimeout: readPositiveInteger('TERMINAL_PERSISTENT_SESSION_TIMEOUT', 30 * 60_000),
    maxExtProcessCount: extensionHostConfig.limit,
    extensionHostActivationDiagnostics: extensionHostConfig.activationDiagnosticsEnabled,
    extensionHostStartupTimeout: extensionHostConfig.startupTimeoutMs,
    extensionHostShutdownTimeout: extensionHostConfig.shutdownTimeoutMs,
    extHostForkOptions: {
      execArgv: [`--max-old-space-size=${extensionHostConfig.maxOldSpaceSizeMiB}`],
    },
    watcherHostForkOptions: {
      execArgv: [`--max-old-space-size=${readPositiveInteger('WATCHER_HOST_MAX_OLD_SPACE_SIZE', 256)}`],
    },
    wsHeartbeatInterval: readPositiveInteger('WS_HEARTBEAT_INTERVAL', 30_000),
    wsMaxConnections: readPositiveInteger('WS_MAX_CONNECTIONS', 512),
    wsMaxBufferedAmount: readPositiveInteger('WS_MAX_BUFFERED_AMOUNT', 16 * 1024 * 1024),
    wsShouldAcceptConnection: () => getMemoryStatus().ready,
    runtimeTopologyHandshake,
    netChannelMode: 'direct' as const,
    wsServerOptions: {
      maxPayload: readPositiveInteger('WS_MAX_PAYLOAD', 32 * 1024 * 1024),
      perMessageDeflate: false,
    },
    collaborationOptions: {
      transport: process.env.COLLABORATION_TRANSPORT === 'shared' ? ('shared' as const) : ('standalone' as const),
      authorizeConnection: (request: http.IncomingMessage) =>
        authorizeManagedCollaboration(request, resolveServedWorkspace(), process.env.OPENSUMI_RUNTIME_TOKEN || ''),
      port: readPositiveInteger('COLLABORATION_PORT', 12_345),
      maxPayload: readPositiveInteger('COLLABORATION_MAX_PAYLOAD', 2 * 1024 * 1024),
      maxConnections: readPositiveInteger('COLLABORATION_MAX_CONNECTIONS', 64),
      maxBufferedAmount: readPositiveInteger('COLLABORATION_MAX_BUFFERED_AMOUNT', 2 * 1024 * 1024),
      maxDocuments: readPositiveInteger('COLLABORATION_MAX_DOCUMENTS', 128),
      maxDocumentBytes: readPositiveInteger('COLLABORATION_MAX_DOCUMENT_BYTES', 2 * 1024 * 1024),
      maxStateBytes: readPositiveInteger('COLLABORATION_MAX_STATE_BYTES', 32 * 1024 * 1024),
      maxPendingDocuments: readPositiveInteger('COLLABORATION_MAX_PENDING_DOCUMENTS', 32),
      idleTimeout: readPositiveInteger('COLLABORATION_IDLE_TIMEOUT', 60_000),
      shouldAcceptConnection: () => getMemoryStatus().ready,
    },
    staticAllowOrigin: '*',
    staticAllowPath: [
      path.join(rootDirectory, 'packages/extension'),
      extensionDirectory,
      ...(marketplaceExtensionDirectory && marketplaceExtensionDirectory !== extensionDirectory
        ? [marketplaceExtensionDirectory]
        : []),
      '/',
    ],
    // 使用 tsx 开发时，Node 24 可以直接加载可擦除类型的 TypeScript。
    // 生产环境继续使用 server/dist 中生成的 JavaScript。
    extLogServiceClassPath: extensionLogService,
    extHost:
      process.env.EXTENSION_HOST_ENTRY || path.join(rootDirectory, 'packages/extension/lib/hosted/ext.process.js'),
    watcherHost:
      process.env.WATCHER_HOST_ENTRY ||
      path.join(rootDirectory, 'packages/file-service/lib/node/hosted/watcher.process.js'),
    onDidCreateExtensionHostProcess: (extensionHostProcess) => {
      // eslint-disable-next-line no-console
      console.log(`Extension host process ${extensionHostProcess.pid} created`);
    },
    onDidChangeExtensionHostStatus: (status) => {
      extensionHostStatus = status;
    },
  });

  const server = http.createServer(
    {
      headersTimeout: readPositiveInteger('HTTP_HEADERS_TIMEOUT', 15_000),
      keepAliveTimeout: readPositiveInteger('HTTP_KEEP_ALIVE_TIMEOUT', 5_000),
      maxHeaderSize: readPositiveInteger('HTTP_MAX_HEADER_SIZE', 16 * 1024),
      requestTimeout: readPositiveInteger('HTTP_REQUEST_TIMEOUT', 30_000),
    },
    app.callback(),
  );
  server.maxConnections = readPositiveInteger('HTTP_MAX_CONNECTIONS', 512);
  server.maxHeadersCount = readPositiveInteger('HTTP_MAX_HEADERS_COUNT', 100);
  server.maxRequestsPerSocket = readPositiveInteger('HTTP_MAX_REQUESTS_PER_SOCKET', 1_000);
  const port = Number(process.env.PORT || process.env.IDE_SERVER_PORT || 4317);

  try {
    serverApp = new ServerApp(buildServerAppOptions());
  } catch (constructionError) {
    try {
      await injector.disposeAll();
    } catch (cleanupError) {
      // 保留构造错误，同时保存清理过程的证据。
      // eslint-disable-next-line no-console
      console.error('Failed to clean up OpenSumi after ServerApp construction failure', cleanupError);
    }
    throw constructionError;
  }

  const runtimeSignalController = installRuntimeSignalHandlers(serverApp, server, exitAfterShutdown);
  const requestRuntimeShutdown = runtimeSignalController.requestShutdown;
  stopProduct = requestRuntimeShutdown;

  runtimeSignalController.armServerClose();
  try {
    await serverApp.start(server);
    if (serverApp.state !== 'running') {
      throw createRuntimeStartupCancelledError(serverApp.state);
    }
    await listenHTTPServerForRuntime(server, port, () => serverApp.state);
    // eslint-disable-next-line no-console
    console.log(`server listen on http://localhost:${port}`);
    return server;
  } catch (startupError) {
    // 启动失败与进程信号共用同一套资源清理。
    try {
      await requestRuntimeShutdown('startup-failure');
    } catch (shutdownError) {
      // 启动错误作为主要失败，同时保留清理证据。
      // eslint-disable-next-line no-console
      console.error('Failed to clean up OpenSumi after startup failure', shutdownError);
    }
    throw startupError;
  }
}
