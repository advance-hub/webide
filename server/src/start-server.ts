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

import type { RuntimeTopologyServerHandshake } from '@opensumi/ide-startup';

export function createClientStaticMiddleware(directory: string) {
  return serveStatic(directory, {
    setHeaders(response, filename) {
      // HTML and legacy unversioned entrypoints must revalidate after releases.
      const versioned = /\.[a-f0-9]{8}\.(?:js|css)$/.test(path.basename(filename));
      response.setHeader('Cache-Control', versioned ? 'public, max-age=2592000, immutable' : 'no-cache');
    },
  });
}

/** Identity of the single workspace this server process serves, if any. */
export interface ServedWorkspaceIdentity {
  id?: string;
  directory: string;
}

/**
 * Only WORKSPACE_DIR activates the binding. The control plane sets it for every
 * driver, while MY_WORKSPACE is a developer convention that dev-tool already
 * uses as a build-time default, so honouring it here would silently take the
 * query parameter away from a standalone checkout.
 */
export function resolveServedWorkspace(env: NodeJS.ProcessEnv = process.env): ServedWorkspaceIdentity | undefined {
  const directory = env.WORKSPACE_DIR;
  if (!directory) {
    return undefined;
  }
  return { id: env.WORKSPACE_ID || undefined, directory };
}

/**
 * A workbench deployment runs one IDE per workspace and the directory it serves
 * is a deployment fact, not a user input. Declaring it in the served document
 * means the client does not have to take it from the query string, where anyone
 * could point the runtime at another directory. Standalone OpenSumi keeps the
 * query parameter because no server-side workspace is configured there.
 */
export function createWorkspaceIdentityMiddleware(directory: string, workspace: ServedWorkspaceIdentity) {
  const payload = JSON.stringify({ id: workspace.id, workspaceDir: workspace.directory })
    // Prevent the literal from terminating the inline script element.
    .replace(/</g, '\\u003c');
  const inlineDeclaration = `<script>window.__OPENSUMI_WORKSPACE__=${payload};</script>`;
  let document: string | undefined;

  return async (context: Koa.Context, next: Koa.Next) => {
    const wantsDocument =
      (context.method === 'GET' || context.method === 'HEAD') &&
      (context.path === '/' || context.path === '/index.html');
    if (!wantsDocument) {
      return next();
    }
    if (document === undefined) {
      const source = await readFile(path.join(directory, 'index.html'), 'utf8');
      document = source.includes('</head>')
        ? source.replace('</head>', `${inlineDeclaration}</head>`)
        : inlineDeclaration + source;
    }
    context.set('Cache-Control', 'no-cache');
    context.type = 'html';
    context.body = document;
  };
}

export interface StartServerOptions {
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
  // A Node HTTP server can be listened, closed, and listened again, so a
  // completed lifecycle cannot be reused for the next listen epoch.
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
    // `server.close()` flips listening to false before active requests finish.
    // If this owner was ever listening, the close event is the idle barrier.
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

  // A signal can arrive while listen() is still completing. ServerApp may
  // already have finished a shutdown that observed no active listener, so
  // the product must close the late listener before surfacing cancellation.
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

/**
 * Coordinates product owners without installing process-global handlers.
 * Admission barriers execute synchronously on the first call; the returned
 * promise then waits for ServerApp's admitted work before final transport
 * shutdown. Later calls receive the exact same promise and report object.
 */
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
    // Publish the promise before calling owners, including synchronous callbacks.
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
    // Fence new HTTP requests immediately; upgraded sockets retire in ServerApp.
    const ingressClosed = closeHTTPServer(httpServer, httpLifecycle).catch((error) => {
      try {
        onOwnerError?.('http-server', error);
      } catch {
        /* diagnostics only */
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
  /** Arm unexpected-listener-close ownership after startup/fallback selection. */
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

    // The product owns process termination. ServerApp never calls process.exit;
    // if a phase cannot settle, this hard deadline is what prevents a hung
    // contribution or transport from keeping the process alive forever.
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
        // A timed-out ServerApp phase is un-cancellable, and a failed final
        // owner may still hold the process open. In both cases retain the hard
        // deadline instead of clearing the only forced-termination guard.
        if (forceExitTimer && shutdownReport && shouldClearRuntimeHardDeadline(shutdownReport, ownerCleanupFailed)) {
          clearTimeout(forceExitTimer);
        }
        removeSignalHandlers();
        if (exitAfterShutdown && shutdownReport && shouldClearRuntimeHardDeadline(shutdownReport, ownerCleanupFailed)) {
          // Native PTY descriptors may survive completed owner cleanup. The
          // executable owns its process lifetime after all phases acknowledge.
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
      // An unexpected close after startup owns runtime shutdown.
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
  // A fresh clone has no downloaded extensions yet. Keep the directory
  // present so the extension scanner starts quietly before the first install.
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
    // A misrouted proxy must not be served as if it addressed this workspace.
    // The control plane forwards the workspace it resolved; only an explicit
    // mismatch is rejected, so a plain OpenSumi client keeps working.
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
    webSocketHandler: [],
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
    // Node 24 can load erasable TypeScript directly during `tsx` development;
    // production continues to use the JavaScript emitted into server/dist.
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
      // Preserve the construction failure while retaining cleanup evidence.
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
    // Startup failures use the same owned teardown as process signals.
    try {
      await requestRuntimeShutdown('startup-failure');
    } catch (shutdownError) {
      // Keep the startup error as the primary failure while retaining cleanup evidence.
      // eslint-disable-next-line no-console
      console.error('Failed to clean up OpenSumi after startup failure', shutdownError);
    }
    throw startupError;
  }
}
