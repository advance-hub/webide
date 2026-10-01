import { Autowired, Injectable } from '@opensumi/di';
import {
  ACP_SESSION_NOT_FOUND_ERROR_NAME,
  ACP_THREAD_POOL_SATURATED_ERROR_NAME,
  AcpDebugLogEntry,
  AgentProcessConfig,
  AvailableCommand,
  DEFAULT_ACP_THREAD_POOL_SIZE,
  Deferred,
  Disposable,
  Emitter,
  Event,
  IDisposable,
  ListSessionsRequest,
  ListSessionsResponse,
  McpServer,
  OpenSumiMcpServerConnectionInfo,
  SessionInfo,
  SessionNotification,
} from '@opensumi/ide-core-common';
import { AppConfig, INodeLogger } from '@opensumi/ide-core-node';
import { SumiReadableStream } from '@opensumi/ide-utils/stream';

import { toAgentUpdate } from './acp-agent-update-adapter';
import { acpDebugLogStore } from './acp-debug-log';
import { getAcpErrorMessage, normalizeAcpError } from './acp-error';
import {
  AcpThread,
  AcpThreadEvent,
  AcpThreadFactory,
  AcpThreadFactoryToken,
  AcpThreadRuntimeConfig,
  ThreadStatus,
} from './acp-thread';
import { AcpTerminalHandler, AcpTerminalHandlerToken } from './handlers/terminal.handler';
import { OpenSumiMcpHttpServer } from './opensumi-mcp-http-server';
import { PermissionRoutingService, PermissionRoutingServiceToken } from './permission-routing.service';

import type { AgentUpdate } from './acp-update-types';
export type { AgentUpdate, AgentUpdateType, SimpleToolCall } from './acp-update-types';

// ============================================================================
// DI Token
// ============================================================================

export const AcpAgentServiceToken = Symbol('AcpAgentServiceToken');

const WEBMCP_CAPABILITY_HINT = [
  '<opensumi_mcp_usage_hint priority="low">',
  'Use the opensumi-ide MCP catalog tools to discover and enable IDE capability groups before invoking non-default OpenSumi tools.',
  '</opensumi_mcp_usage_hint>',
].join('\n');

const PENDING_CREATE_SESSION_LOG_LABEL = 'pending-create-session';
const ACP_STOP_LEASE_MS = 8000;

type StopOperationKind = 'foreground' | 'thread' | 'warmup';

interface BoundedSettlement<T> {
  outcomes: Array<PromiseSettledResult<T> | undefined>;
  timedOut: boolean;
}

function createStopTimeoutError(scope: string): Error {
  const error = new Error(`ACP Agent service stop lease expired while waiting for ${scope}`);
  error.name = 'AcpAgentServiceStopTimeoutError';
  return error;
}

async function settleWithinDeadline<T>(operations: Promise<T>[], deadline: number): Promise<BoundedSettlement<T>> {
  if (operations.length === 0) {
    return { outcomes: [], timedOut: false };
  }

  const outcomes: Array<PromiseSettledResult<T> | undefined> = new Array(operations.length);
  const settlement = Promise.all(
    operations.map((operation, index) =>
      operation.then(
        (value) => {
          outcomes[index] = { status: 'fulfilled', value };
        },
        (reason) => {
          outcomes[index] = { status: 'rejected', reason };
        },
      ),
    ),
  ).then(() => false);
  const remaining = Math.max(0, deadline - Date.now());
  if (remaining === 0) {
    return { outcomes, timedOut: true };
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timedOut = await Promise.race([
    settlement,
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(true), remaining);
      timeout.unref?.();
    }),
  ]);
  if (timeout) {
    clearTimeout(timeout);
  }
  return { outcomes, timedOut };
}

function mapSessionLoadError(error: unknown): unknown {
  if (error && typeof error === 'object' && (error as { code?: unknown }).code === -32002) {
    const mappedError = new Error(getAcpErrorMessage(error));
    mappedError.name = ACP_SESSION_NOT_FOUND_ERROR_NAME;
    return mappedError;
  }

  return error;
}

interface AcpLoadSessionFallbackProvenance {
  createdByFallback: boolean;
}

function hasAcpLoadSessionFallbackProvenance(value: unknown): value is AcpLoadSessionFallbackProvenance {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { createdByFallback?: unknown }).createdByFallback === 'boolean'
  );
}

// ============================================================================
// Agent Session Types
// ============================================================================

export type AgentSessionStatus = 'initializing' | 'ready' | 'running' | 'stopping' | 'stopped' | 'error';

export interface SimpleMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
}

export interface AgentSessionInfo {
  sessionId: string;
  /** threadId of the AcpThread instance */
  processId: string;
  modes: Array<{ id: string; name: string }>;
  status: AgentSessionStatus;
}

/**
 * Agent request parameters
 */
export interface AgentRequest {
  prompt: string;
  /** ACP session/prompt sessionId */
  sessionId: string;
  images?: string[];
  history?: SimpleMessage[];
}

export interface SessionLoadResult {
  sessionId: string;
  processId: string;
  modes: Array<{ id: string; name: string; description?: string }>;
  currentModeId?: string;
  models?: Array<{ modelId: string; name: string; description?: string | null }>;
  currentModelId?: string;
  configOptions?: Record<string, any>[];
  status: AgentSessionStatus;
  threadStatus?: ThreadStatus;
  historyUpdates: SessionNotification[];
}

export interface AgentSessionSnapshot extends SessionLoadResult {
  threadStatus: ThreadStatus;
}

export type AgentSessionAttachmentUpdate =
  { type: 'snapshot'; snapshot: AgentSessionSnapshot } | { type: 'update'; update: AgentUpdate };

interface PendingSessionLoad {
  promise: Promise<SessionLoadResult>;
  refCount: number;
  thread: AcpThread;
  boundSessionId: string;
  closeRequested: boolean;
  terminalReleaseOwnedByStop: boolean;
  cleanup: SessionOperationCleanup;
}

type SessionOperationKind = 'create' | 'load' | 'load-or-new';
type SessionIdentityOrigin = 'requested' | 'created';
type SessionCleanupOwner = 'operation' | 'disposer' | 'stop';

interface SessionOperationIdentity {
  readonly sessionId: string;
  readonly origin: SessionIdentityOrigin;
  owner: SessionCleanupOwner;
  releaseGeneration?: number;
  releasePromise?: Promise<void>;
  terminalRetired: boolean;
}

interface SessionOperationCleanup {
  readonly kind: SessionOperationKind;
  readonly thread: AcpThread;
  readonly identities: SessionOperationIdentity[];
  owner: SessionCleanupOwner;
  closeRequested: boolean;
  readonly closeDeferred: Deferred<void>;
  readonly completionDeferred: Deferred<void>;
  forceDisposeRequested: boolean;
}

interface TerminalReleaseState {
  requestedGeneration: number;
  completedGeneration: number;
  inFlight?: {
    throughGeneration: number;
    promise: Promise<void>;
  };
}

type AgentThreadRuntimeConfigKey = Pick<
  AgentProcessConfig,
  'agentId' | 'command' | 'args' | 'cwd' | 'env' | 'nodePath'
>;

interface ThreadAllocationRequest {
  sessionId?: string;
  reason: string;
  config: AgentProcessConfig;
}

// ============================================================================
// SDK type aliases (SDK is ESM, can't use static imports in this CJS file)
// ============================================================================

/**
 * Minimal shape matching the SDK's SetSessionConfigOptionRequest:
 * ({ type: "boolean"; value: boolean } | { value: string }) & { sessionId, configId, _meta? }
 */
interface SetSessionConfigOptionRequest {
  sessionId: string;
  configId: string;
  value: boolean | string;
  type?: 'boolean';
  _meta?: { [key: string]: unknown } | null;
}

// ============================================================================
// IAcpAgentService Interface
// ============================================================================

export interface IAcpAgentService {
  /**
   * Initialize Agent process and create a new session
   */
  initializeAgent(config: AgentProcessConfig): Promise<AgentSessionInfo>;

  /**
   * Load an existing Agent Session
   */
  loadSession(sessionId: string, config: AgentProcessConfig): Promise<SessionLoadResult>;

  /**
   * Send message to Agent (streaming)
   */
  sendMessage(request: AgentRequest, config: AgentProcessConfig): SumiReadableStream<AgentUpdate>;

  /**
   * Observe an active Agent Session without sending another prompt.
   */
  attachSession(sessionId: string): SumiReadableStream<AgentSessionAttachmentUpdate>;

  /**
   * Cancel a request
   */
  cancelRequest(sessionId: string): Promise<void>;

  /**
   * Stop all Agent processes
   */
  stopAgent(): Promise<void>;

  /**
   * Clean up all resources
   */
  dispose(): Promise<void>;

  /**
   * Get current Agent Session info
   */
  getSessionInfo(sessionId?: string): AgentSessionInfo | null;

  /**
   * Create a new session
   */
  createSession(config: AgentProcessConfig): Promise<{
    sessionId: string;
    availableCommands: AvailableCommand[];
    modes?: Array<{ id: string; name: string; description?: string }>;
    currentModeId?: string;
    models?: Array<{ modelId: string; name: string; description?: string | null }>;
    currentModelId?: string;
    configOptions?: Record<string, any>[];
  }>;

  /**
   * Start and initialize the idle thread pool for one runtime configuration.
   * Does not create an ACP session.
   */
  warmUpAgentPool(config: AgentProcessConfig): Promise<void>;

  /**
   * List all ACP Agent sessions
   */
  listSessions(params?: ListSessionsRequest, config?: AgentProcessConfig): Promise<ListSessionsResponse>;

  /**
   * Switch Session mode
   */
  setSessionMode(params: { sessionId: string; modeId: string }): Promise<void>;

  /**
   * Load existing session, fallback to new session if load fails.
   */
  loadSessionOrNew(sessionId: string, config: AgentProcessConfig): Promise<SessionLoadResult>;

  /**
   * Set session configuration options (e.g. permission levels).
   */
  setSessionConfigOption(params: { sessionId: string; configId: string; value: boolean | string }): Promise<void>;

  /** Fork a session (create a copy based on existing session state) */
  forkSession(params: { sessionId: string; cwd?: string; mcpServers?: McpServer[] }): Promise<{ sessionId: string }>;

  /** Resume a closed session */
  resumeSession(params: { sessionId: string; cwd?: string }): Promise<void>;

  /** Close a session without disposing the thread */
  closeSession(params: { sessionId: string }): Promise<void>;

  /** Switch the AI model for the session */
  setSessionModel(params: { sessionId: string; model: string }): Promise<void>;

  /**
   * Release resources for a specific session (including terminals)
   * By default, the thread returns to the pool for reuse.
   * Pass force=true to fully dispose the thread.
   */
  disposeSession(sessionId: string, force?: boolean): Promise<void>;

  /**
   * Get available modes from initialize negotiation
   */
  getAvailableModes(): Promise<any | null>;

  getAcpDebugLog(): Promise<AcpDebugLogEntry[]>;

  clearAcpDebugLog(): Promise<void>;

  /**
   * Start and return the loopback HTTP MCP server connection for external MCP clients.
   */
  getOpenSumiMcpServerConnection(clientId?: string): Promise<OpenSumiMcpServerConnectionInfo>;

  /**
   * Event fired when any session's thread status changes.
   * Persists across sendMessage() calls — unlike onEvent listeners
   * that only exist during stream lifetime.
   */
  readonly onThreadStatusChange: Event<{ sessionId: string; status: ThreadStatus }>;
}

// ============================================================================
// AcpAgentService — Thread Pool Implementation
// ============================================================================

/**
 * ACP Agent Service with Thread Pool management.
 *
 * Design principles:
 * 1. Manages multiple AcpThread instances, each with its own Agent process
 * 2. Thread pool for reuse — threads are not disposed on session end by default
 * 3. Streaming responses via SumiReadableStream
 * 4. Deferred pattern for session creation (no setTimeout polling)
 */
@Injectable()
export class AcpAgentService extends Disposable implements IAcpAgentService {
  @Autowired(AcpThreadFactoryToken)
  private threadFactory: AcpThreadFactory;

  @Autowired(AcpTerminalHandlerToken)
  private terminalHandler: AcpTerminalHandler;

  @Autowired(PermissionRoutingServiceToken)
  private permissionRouting: PermissionRoutingService;

  @Autowired(AppConfig)
  private appConfig: AppConfig;

  @Autowired(INodeLogger)
  private readonly logger: INodeLogger;

  @Autowired(OpenSumiMcpHttpServer)
  private readonly opensumiMcpHttpServer: OpenSumiMcpHttpServer | undefined;

  // Session -> Thread mapping (active sessions)
  private sessions = new Map<string, AcpThread>();

  // Session -> in-flight load task. Prevents concurrent loadSession calls
  // from observing a pre-registered but not-yet-loaded thread.
  private pendingSessionLoads = new Map<string, PendingSessionLoad>();

  // Session -> number of UI/callers currently holding this loaded session.
  private sessionRefCounts = new Map<string, number>();

  // Sessions that actually received the built-in opensumi-ide MCP server.
  private builtInMcpSessionIds = new Set<string>();

  // Thread pool: all thread instances (active + idle/disconnected)
  private threadPool: AcpThread[] = [];

  // Thread -> agent process config key. Idle threads can only be reused when
  // they were created for the same agent process command and environment.
  private threadRuntimeConfigKeys = new WeakMap<AcpThread, string>();

  // Threads reserved by createSession() before the real ACP sessionId is known.
  private reservedThreads = new Set<AcpThread>();

  // Threads whose session identity is being retired. This reservation is
  // independent from acquisition reservations so one operation cannot release
  // another operation's reuse fence.
  private retiringThreads = new Map<AcpThread, number>();

  // Threads that have been added to the pool but are still completing ACP
  // initialize(). They cannot be used until a caller explicitly claims them.
  private warmingThreads = new Map<AcpThread, Promise<void>>();

  // One background warmup task per agent runtime configuration.
  private poolWarmups = new Map<string, Promise<void>>();

  // Service lifecycle gate. Foreground acquisition operations that started
  // before shutdown are drained before any pooled process is disposed.
  private stopping = false;
  private terminallyDisposed = false;
  private disposePromise: Promise<void> | undefined;
  private stopPromise: Promise<void> | undefined;
  private stopLeaseMs = ACP_STOP_LEASE_MS;
  private availableCommandsWaitMs = 5000;
  private stopTimedOut = false;
  private ownershipRetirementFailed = false;
  private foregroundOperations = new Set<Promise<unknown>>();
  private attachmentStreams = new Set<SumiReadableStream<AgentSessionAttachmentUpdate>>();
  private pendingRetirementOperations = new Map<Promise<unknown>, StopOperationKind>();
  private sessionCleanupOperations = new Set<SessionOperationCleanup>();
  private pendingTerminalReleaseIds = new Set<string>();
  private terminalReleaseOperations = new Map<string, Promise<void>>();
  private terminalReleaseStates = new Map<string, TerminalReleaseState>();
  private terminalReleaseGeneration = 0;
  private lateTerminalReleaseIds = new Set<string>();
  private lateTerminalCleanupOperations = new Map<string, Promise<void>>();
  private terminalCleanupSnapshotTaken = false;

  // Pool limit (configurable)
  private maxPoolSize = DEFAULT_ACP_THREAD_POOL_SIZE;

  // Cached session info for backward compat (getSessionInfo without sessionId)
  private lastSessionInfo: AgentSessionInfo | null = null;

  // Persistent thread status change listeners (survives across sendMessage streams)
  private threadStatusDisposables = new Map<string, IDisposable>();

  private _onThreadStatusChange = new Emitter<{ sessionId: string; status: ThreadStatus }>();
  readonly onThreadStatusChange: Event<{ sessionId: string; status: ThreadStatus }> = this._onThreadStatusChange.event;

  // -----------------------------------------------------------------------
  // Core: findOrCreateThread
  // -----------------------------------------------------------------------

  /**
   * Find or create a thread for the given sessionId.
   * 1. Active session mapping exists -> return it
   * 2. Pool has idle thread -> bind to session
   * 3. Pool not full -> create new thread
   * 4. Pool full, no idle -> throw
   */
  private async findOrCreateThread(sessionId: string, config: AgentProcessConfig): Promise<AcpThread> {
    this.syncMaxPoolSize(config);

    // 1. Active session mapping exists
    const existing = this.sessions.get(sessionId);
    if (existing && existing.getStatus() !== 'disconnected') {
      this.touchSession(sessionId);
      return existing;
    }

    // 2. Pool has idle thread (idle or awaiting_prompt, not bound to active session)
    const idleThread = this.findReusableIdleThread(config);
    if (idleThread) {
      this.bindSession(sessionId, idleThread);
      return idleThread;
    }

    const warmingThread = await this.reserveWarmingThread(config);

    if (warmingThread) {
      this.bindSession(sessionId, warmingThread);
      return warmingThread;
    }

    this.throwIfStopping();

    // 3. Pool not full, create new
    if (this.threadPool.length < this.maxPoolSize) {
      const thread = this.createThreadInstance(sessionId, config);
      this.threadPool.push(thread);
      this.bindSession(sessionId, thread);
      return thread;
    }

    // 4. Pool full, no idle — replace the least recently used reusable thread.
    const recycledThread = await this.allocateThreadAtCapacity({ sessionId, reason: 'load-or-new', config });
    this.bindSession(sessionId, recycledThread);
    return recycledThread;
  }

  /**
   * Check if a thread is bound to any active session.
   */
  private hasActiveSession(thread: AcpThread): boolean {
    for (const [, t] of this.sessions) {
      if (t === thread) {
        return true;
      }
    }
    return false;
  }

  private bindSession(sessionId: string, thread: AcpThread): void {
    this.sessions.delete(sessionId);
    this.sessions.set(sessionId, thread);
  }

  private touchSession(sessionId: string): void {
    const thread = this.sessions.get(sessionId);
    if (!thread) {
      return;
    }
    this.bindSession(sessionId, thread);
  }

  private syncMaxPoolSize(config: AgentProcessConfig): void {
    const { threadPoolSize } = config;
    if (typeof threadPoolSize !== 'number' || !Number.isFinite(threadPoolSize) || threadPoolSize < 1) {
      this.maxPoolSize = DEFAULT_ACP_THREAD_POOL_SIZE;
      return;
    }
    this.maxPoolSize = Math.floor(threadPoolSize);
  }

  private isThreadProcessReusable(thread: AcpThread): boolean {
    return ['idle', 'awaiting_prompt'].includes(thread.getStatus());
  }

  private isThreadCapacityReclaimable(thread: AcpThread, sessionId = this.getBoundSessionId(thread)): boolean {
    if (
      this.isThreadReserved(thread) ||
      this.warmingThreads.has(thread) ||
      (sessionId ? Boolean(this.getPendingSessionLoad(sessionId)) : false)
    ) {
      return false;
    }
    return ['idle', 'awaiting_prompt', 'disconnected'].includes(thread.getStatus());
  }

  private createThreadPoolSaturatedError(): Error {
    const error = new Error(`Thread pool is full (${this.maxPoolSize}), no reusable LRU thread available`);
    error.name = ACP_THREAD_POOL_SATURATED_ERROR_NAME;
    return error;
  }

  private createServiceStoppingError(): Error {
    const error = new Error(
      this.terminallyDisposed ? 'ACP Agent service is disposed' : 'ACP Agent service is stopping',
    );
    error.name = this.terminallyDisposed ? 'AcpAgentServiceDisposedError' : 'AcpAgentServiceStoppingError';
    return error;
  }

  private throwIfStopping(): void {
    if (this.stopping || this.terminallyDisposed) {
      throw this.createServiceStoppingError();
    }
  }

  private trackForegroundOperation<T>(operation: () => Promise<T>): Promise<T> {
    if (this.stopping || this.terminallyDisposed) {
      return Promise.reject(this.createServiceStoppingError());
    }

    let tracked!: Promise<T>;
    tracked = Promise.resolve()
      .then(() => {
        this.throwIfStopping();
        return operation();
      })
      .finally(() => {
        this.foregroundOperations.delete(tracked);
      });
    this.foregroundOperations.add(tracked);
    return tracked;
  }

  private trackStartedForegroundOperation<T>(operation: Promise<T>): Promise<T> {
    let tracked!: Promise<T>;
    tracked = operation.finally(() => {
      this.foregroundOperations.delete(tracked);
    });
    this.foregroundOperations.add(tracked);
    return tracked;
  }

  private trackRetirementOperation<T>(operation: Promise<T>, kind: StopOperationKind): Promise<T> {
    let tracked!: Promise<T>;
    tracked = operation.finally(() => {
      this.pendingRetirementOperations.delete(tracked);
    });
    this.pendingRetirementOperations.set(tracked, kind);
    if (kind === 'thread') {
      void tracked.catch((error) => {
        this.ownershipRetirementFailed = true;
        this.logger?.warn('[AcpAgentService] A thread retirement failed after stop ownership was sealed.', error);
      });
    }
    return tracked;
  }

  /**
   * Session RPCs own terminal cleanup through an operation-scoped token. The
   * token survives map rebinding and distinguishes a fallback-created session
   * from the requested session even when both use the same string id.
   */
  private beginSessionOperation(kind: SessionOperationKind, thread: AcpThread): SessionOperationCleanup {
    const cleanup: SessionOperationCleanup = {
      kind,
      thread,
      identities: [],
      owner: this.stopping || this.terminallyDisposed ? 'stop' : 'operation',
      closeRequested: false,
      closeDeferred: new Deferred<void>(),
      completionDeferred: new Deferred<void>(),
      forceDisposeRequested: false,
    };
    this.sessionCleanupOperations.add(cleanup);
    return cleanup;
  }

  private finishSessionOperation(cleanup: SessionOperationCleanup): void {
    this.sessionCleanupOperations.delete(cleanup);
    cleanup.completionDeferred.resolve();
  }

  private requestSessionOperationClose(cleanup: SessionOperationCleanup): void {
    cleanup.closeRequested = true;
    cleanup.closeDeferred.resolve();
  }

  private throwIfSessionOperationClosed(cleanup: SessionOperationCleanup): void {
    if (cleanup.closeRequested) {
      throw new Error('ACP session operation was disposed before completion');
    }
  }

  private observeSessionOperationIdentity(
    cleanup: SessionOperationCleanup,
    sessionId: string,
    origin: SessionIdentityOrigin,
  ): SessionOperationIdentity {
    const identity: SessionOperationIdentity = {
      sessionId,
      origin,
      owner: cleanup.owner,
      terminalRetired: false,
    };
    cleanup.identities.push(identity);
    if (identity.owner !== 'operation') {
      cleanup.thread.retireSession?.(identity.sessionId);
      this.queueSessionOperationIdentity(identity);
    }
    return identity;
  }

  private transferSessionOperationCleanup(
    cleanup: SessionOperationCleanup,
    owner: Exclude<SessionCleanupOwner, 'operation'>,
  ): void {
    // Stop is the terminal lifecycle owner and cannot be downgraded by a
    // concurrent disposeSession call.
    if (cleanup.owner === 'stop' && owner !== 'stop') {
      return;
    }
    cleanup.owner = owner;
    for (const identity of cleanup.identities) {
      identity.owner = owner;
      cleanup.thread.retireSession?.(identity.sessionId);
      this.queueSessionOperationIdentity(identity);
    }
  }

  private queueSessionOperationIdentity(identity: SessionOperationIdentity): number | undefined {
    if (identity.terminalRetired) {
      return undefined;
    }
    if (identity.releaseGeneration === undefined) {
      identity.releaseGeneration = this.requestSessionTerminalRelease(identity.sessionId);
    }
    if (identity.owner === 'disposer') {
      this.scheduleDisposerTerminalRelease(identity);
    }
    return identity.releaseGeneration;
  }

  private scheduleDisposerTerminalRelease(identity: SessionOperationIdentity): void {
    void this.retireSessionOperationIdentity(identity).catch((error) => {
      this.logger?.warn(
        `[AcpAgentService] Failed to release terminals owned by disposeSession for ${identity.sessionId}`,
        error,
      );
    });
  }

  private async retireSessionOperationIdentity(identity: SessionOperationIdentity): Promise<void> {
    if (identity.terminalRetired) {
      return;
    }
    if (identity.releaseGeneration === undefined) {
      identity.releaseGeneration = this.requestSessionTerminalRelease(identity.sessionId);
    }
    const generation = identity.releaseGeneration;
    let release = identity.releasePromise;
    if (!release) {
      release = this.releaseSessionTerminalsOnce(identity.sessionId, generation);
      identity.releasePromise = release;
    }
    try {
      await release;
      identity.terminalRetired = true;
    } catch (error) {
      if (identity.releasePromise === release) {
        identity.releasePromise = undefined;
      }
      throw error;
    }
  }

  private async drainSessionOperationCleanup(cleanup: SessionOperationCleanup): Promise<void> {
    const releases = cleanup.identities.map((identity) => this.retireSessionOperationIdentity(identity));
    await Promise.all(releases);
  }

  private trackAttachmentStream(
    stream: SumiReadableStream<AgentSessionAttachmentUpdate>,
    disposeSubscription: () => void,
  ): void {
    let settle!: () => void;
    const tracked = new Promise<void>((resolve) => {
      settle = resolve;
    });
    let settled = false;
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      disposeSubscription();
      this.attachmentStreams.delete(stream);
      this.foregroundOperations.delete(tracked);
      settle();
    };

    this.attachmentStreams.add(stream);
    this.foregroundOperations.add(tracked);
    stream.onEnd(finish);
    stream.onError(finish);
  }

  private createThreadRuntimeConfigKey(config: AgentThreadRuntimeConfigKey): string {
    const env = Array.isArray(config.env)
      ? config.env
          .map((item) => ({
            name: String((item as { name?: unknown }).name ?? ''),
            value: String((item as { value?: unknown }).value ?? ''),
          }))
          .sort((a, b) => a.name.localeCompare(b.name) || a.value.localeCompare(b.value))
      : [];

    return JSON.stringify({
      agentId: config.agentId,
      command: config.command,
      args: config.args ?? [],
      cwd: config.cwd,
      env,
      nodePath: config.nodePath ?? '',
    });
  }

  private rememberThreadRuntimeConfig(thread: AcpThread, config: AgentThreadRuntimeConfigKey): void {
    this.threadRuntimeConfigKeys.set(thread, this.createThreadRuntimeConfigKey(config));
  }

  private canReuseThreadForConfig(thread: AcpThread, config: AgentProcessConfig): boolean {
    return this.threadRuntimeConfigKeys.get(thread) === this.createThreadRuntimeConfigKey(config);
  }

  private isThreadReserved(thread: AcpThread): boolean {
    return this.reservedThreads.has(thread) || this.retiringThreads.has(thread);
  }

  private retainThreadRetirement(thread: AcpThread): void {
    this.retiringThreads.set(thread, (this.retiringThreads.get(thread) ?? 0) + 1);
  }

  private releaseThreadRetirement(thread: AcpThread): void {
    const remaining = (this.retiringThreads.get(thread) ?? 1) - 1;
    if (remaining > 0) {
      this.retiringThreads.set(thread, remaining);
    } else {
      this.retiringThreads.delete(thread);
    }
  }

  private findReusableIdleThread(config: AgentProcessConfig): AcpThread | undefined {
    return this.threadPool.find(
      (thread) =>
        !this.isThreadReserved(thread) &&
        !this.warmingThreads.has(thread) &&
        !this.hasActiveSession(thread) &&
        this.canReuseThreadForConfig(thread, config) &&
        this.isThreadProcessReusable(thread),
    );
  }

  /**
   * Claim an in-flight prewarmed thread so the caller can wait for the same
   * initialization instead of starting a duplicate CLI process.
   */
  private async reserveWarmingThread(config: AgentProcessConfig): Promise<AcpThread | undefined> {
    const thread = this.threadPool.find(
      (candidate) =>
        !this.isThreadReserved(candidate) &&
        !this.hasActiveSession(candidate) &&
        this.canReuseThreadForConfig(candidate, config) &&
        this.warmingThreads.has(candidate),
    );
    if (!thread) {
      return undefined;
    }

    const warmup = this.warmingThreads.get(thread);
    if (!warmup) {
      return undefined;
    }

    this.reservedThreads.add(thread);
    try {
      await warmup;
      this.throwIfStopping();
      if (this.threadPool.includes(thread)) {
        return thread;
      }
    } catch (error) {
      this.reservedThreads.delete(thread);
      throw error;
    }

    this.reservedThreads.delete(thread);
    return undefined;
  }

  private getBoundSessionId(thread: AcpThread): string | undefined {
    for (const [sessionId, mappedThread] of this.sessions) {
      if (mappedThread === thread) {
        return sessionId;
      }
    }
    return undefined;
  }

  private getPendingSessionLoad(sessionId: string): PendingSessionLoad | undefined {
    return (
      this.pendingSessionLoads.get(sessionId) ??
      Array.from(this.pendingSessionLoads.values()).find((pending) => pending.boundSessionId === sessionId)
    );
  }

  private clearSessionRuntimeState(sessionId: string, expectedThread?: AcpThread): void {
    const currentThread = this.sessions.get(sessionId);
    // Cleanup may await terminal/process retirement while admission remains
    // open. Never let an older session identity erase a newer binding that
    // reused the same ACP session-id string in that window.
    if (expectedThread && currentThread && currentThread !== expectedThread) {
      return;
    }
    (currentThread ?? expectedThread)?.retireSession?.(sessionId);
    this.permissionRouting.unregisterSession(sessionId);
    this.unregisterThreadStatusListener(sessionId);
    this.sessions.delete(sessionId);
    this.sessionRefCounts.delete(sessionId);
    this.builtInMcpSessionIds.delete(sessionId);
  }

  private async releaseSessionResources(sessionId: string): Promise<void> {
    const thread = this.sessions.get(sessionId);
    this.clearSessionRuntimeState(sessionId, thread);
    const generation = this.requestSessionTerminalRelease(sessionId);
    if (this.stopping || this.terminallyDisposed) {
      return;
    }
    await this.releaseSessionTerminalsOnce(sessionId, generation);
  }

  private removeThreadFromPool(thread: AcpThread): void {
    const index = this.threadPool.indexOf(thread);
    if (index !== -1) {
      this.threadPool.splice(index, 1);
    }
  }

  private async recoverThreadAfterSessionFailure(thread: AcpThread): Promise<void> {
    if (!thread.initialized || thread.getStatus() === 'disconnected') {
      this.removeThreadFromPool(thread);
      await thread.dispose();
      return;
    }
    thread.reset();
  }

  private async cleanupFailedSessionOperation(cleanup: SessionOperationCleanup, thread: AcpThread): Promise<void> {
    this.retainThreadRetirement(thread);
    try {
      const operationOwnedIdentities = cleanup.identities.filter(({ owner }) => owner === 'operation');
      // All owners may clear in-memory bindings. Only the operation owner may
      // release terminals here; disposer/stop already own those release tokens.
      for (const sessionId of new Set(cleanup.identities.map(({ sessionId }) => sessionId))) {
        this.clearSessionRuntimeState(sessionId, cleanup.thread);
      }
      const releases = operationOwnedIdentities.map(async (identity) => {
        try {
          await this.retireSessionOperationIdentity(identity);
        } catch (error) {
          this.logger.warn(
            `[AcpAgentService] Failed to release resources for unsuccessful session ${identity.sessionId}`,
            error,
          );
        }
      });
      await Promise.all(releases);
      if (!cleanup.forceDisposeRequested) {
        await this.recoverThreadAfterSessionFailure(thread);
      }
    } finally {
      this.releaseThreadRetirement(thread);
    }
  }

  private createReservedThread(sessionId: string | undefined, config: AgentProcessConfig): AcpThread {
    const thread = this.createThreadInstance(sessionId ?? '', config);
    this.threadPool.push(thread);
    this.reservedThreads.add(thread);
    return thread;
  }

  private async replaceThreadForConfig(
    thread: AcpThread,
    sessionId: string | undefined,
    request: ThreadAllocationRequest,
  ): Promise<AcpThread> {
    const nextSessionId = request.sessionId ?? PENDING_CREATE_SESSION_LOG_LABEL;
    this.reservedThreads.add(thread);
    this.logger.log(
      '[AcpAgentService] thread-pool-dispose — reason=' +
        request.reason +
        ', evictSessionId=' +
        (sessionId ?? '-') +
        ', nextSessionId=' +
        nextSessionId +
        ', threadId=' +
        thread.threadId +
        ', status=' +
        thread.getStatus() +
        ', pool=' +
        this.threadPool.length +
        '/' +
        this.maxPoolSize,
    );
    try {
      if (sessionId) {
        await this.releaseSessionResources(sessionId);
        this.throwIfStopping();
      }
      await thread.dispose();
      this.removeThreadFromPool(thread);
      this.throwIfStopping();
      return this.createReservedThread(request.sessionId, request.config);
    } finally {
      this.reservedThreads.delete(thread);
    }
  }

  private async replaceIncompatibleWarmingThread(
    thread: AcpThread,
    request: ThreadAllocationRequest,
  ): Promise<AcpThread> {
    const warmup = this.warmingThreads.get(thread);
    if (!warmup) {
      return this.throwThreadPoolSaturated(request);
    }

    this.reservedThreads.add(thread);
    try {
      await warmup;
      this.throwIfStopping();
      if (this.threadPool.includes(thread)) {
        await thread.dispose();
        this.removeThreadFromPool(thread);
        this.throwIfStopping();
      }
      if (this.threadPool.length >= this.maxPoolSize) {
        this.throwThreadPoolSaturated(request);
      }
      return this.createReservedThread(request.sessionId, request.config);
    } finally {
      this.reservedThreads.delete(thread);
    }
  }

  private getThreadAllocationDiagnostics(thread: AcpThread, config: AgentProcessConfig) {
    const sessionId = this.getBoundSessionId(thread);
    const status = thread.getStatus();
    const reserved = this.isThreadReserved(thread);
    const warming = this.warmingThreads.has(thread);
    const pendingLoad = sessionId ? Boolean(this.getPendingSessionLoad(sessionId)) : false;
    const runtimeCompatible = this.canReuseThreadForConfig(thread, config);
    const processReusable = this.isThreadProcessReusable(thread);
    const capacityReclaimable = this.isThreadCapacityReclaimable(thread, sessionId);
    const exclusionReasons: string[] = [];
    if (reserved) {
      exclusionReasons.push('reserved');
    }
    if (warming) {
      exclusionReasons.push('warming');
    }
    if (pendingLoad) {
      exclusionReasons.push('pending-load');
    }
    if (!runtimeCompatible) {
      exclusionReasons.push('runtime-incompatible');
    }
    if (!processReusable) {
      exclusionReasons.push('process-not-reusable:' + status);
    }
    if (!capacityReclaimable) {
      exclusionReasons.push('capacity-not-reclaimable:' + status);
    }
    return {
      threadId: thread.threadId,
      sessionId: sessionId ?? '-',
      status,
      reserved,
      warming,
      pendingLoad,
      runtimeCompatible,
      processReusable,
      capacityReclaimable,
      exclusionReasons,
    };
  }

  private throwThreadPoolSaturated(request: ThreadAllocationRequest): never {
    const candidates = this.threadPool.map((thread) => this.getThreadAllocationDiagnostics(thread, request.config));
    this.logger.warn(
      '[AcpAgentService] thread-pool-saturated — reason=' +
        request.reason +
        ', nextSessionId=' +
        (request.sessionId ?? PENDING_CREATE_SESSION_LOG_LABEL) +
        ', pool=' +
        this.threadPool.length +
        '/' +
        this.maxPoolSize +
        ', candidates=' +
        JSON.stringify(candidates),
    );
    throw this.createThreadPoolSaturatedError();
  }

  private async allocateThreadAtCapacity(request: ThreadAllocationRequest): Promise<AcpThread> {
    for (const thread of this.threadPool) {
      const sessionId = this.getBoundSessionId(thread);
      const status = thread.getStatus();
      if (
        sessionId ||
        !this.isThreadCapacityReclaimable(thread, sessionId) ||
        (status !== 'disconnected' &&
          (this.canReuseThreadForConfig(thread, request.config) || !this.isThreadProcessReusable(thread)))
      ) {
        continue;
      }
      return this.replaceThreadForConfig(thread, undefined, {
        ...request,
        reason: request.reason + '-unbound',
      });
    }

    for (const [sessionId, thread] of this.sessions) {
      if (thread.getStatus() !== 'disconnected' || !this.isThreadCapacityReclaimable(thread, sessionId)) {
        continue;
      }
      return this.replaceThreadForConfig(thread, sessionId, {
        ...request,
        reason: request.reason + '-disconnected',
      });
    }

    for (const [sessionId, thread] of this.sessions) {
      if (
        this.isThreadReserved(thread) ||
        this.warmingThreads.has(thread) ||
        Boolean(this.getPendingSessionLoad(sessionId)) ||
        thread.getStatus() !== 'awaiting_prompt' ||
        !this.canReuseThreadForConfig(thread, request.config)
      ) {
        continue;
      }

      this.reservedThreads.add(thread);
      this.logger.log(
        `[AcpAgentService] thread-pool-switch — reason=${request.reason}, evictSessionId=${sessionId}, nextSessionId=${
          request.sessionId ?? PENDING_CREATE_SESSION_LOG_LABEL
        }, threadId=${thread.threadId}, status=${thread.getStatus()}, pool=${this.threadPool.length}/${
          this.maxPoolSize
        }`,
      );
      try {
        await this.releaseSessionResources(sessionId);
        this.throwIfStopping();
        return thread;
      } catch (error) {
        this.reservedThreads.delete(thread);
        throw error;
      }
    }

    for (const [sessionId, thread] of this.sessions) {
      if (
        thread.getStatus() !== 'awaiting_prompt' ||
        !this.isThreadCapacityReclaimable(thread, sessionId) ||
        this.canReuseThreadForConfig(thread, request.config)
      ) {
        continue;
      }
      return this.replaceThreadForConfig(thread, sessionId, {
        ...request,
        reason: request.reason + '-different-config',
      });
    }

    const incompatibleWarmingThread = this.threadPool.find(
      (thread) =>
        !this.isThreadReserved(thread) &&
        !this.hasActiveSession(thread) &&
        this.warmingThreads.has(thread) &&
        !this.canReuseThreadForConfig(thread, request.config),
    );
    if (incompatibleWarmingThread) {
      return this.replaceIncompatibleWarmingThread(incompatibleWarmingThread, request);
    }

    return this.throwThreadPoolSaturated(request);
  }

  /**
   * Create a new AcpThread instance via factory.
   */
  private createThreadInstance(sessionId: string, config: AgentProcessConfig): AcpThread {
    const runtimeConfig: AcpThreadRuntimeConfig = {
      agentId: config.agentId,
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
      nodePath: config.nodePath,
    };
    const thread = this.threadFactory(sessionId, runtimeConfig);
    this.rememberThreadRuntimeConfig(thread, runtimeConfig);
    this.logger.log(
      `[AcpAgentService] Created new thread ${thread.threadId} for session ${sessionId}, cwd=${config.cwd}`,
    );
    return thread;
  }

  /**
   * Find an idle thread or create a new one, without binding to a sessionId.
   */
  private async findOrCreateIdleThread(config: AgentProcessConfig): Promise<AcpThread> {
    this.syncMaxPoolSize(config);

    const idleThread = this.findReusableIdleThread(config);
    if (idleThread) {
      this.reservedThreads.add(idleThread);
      return idleThread;
    }

    const warmingThread = await this.reserveWarmingThread(config);

    if (warmingThread) {
      return warmingThread;
    }

    this.throwIfStopping();
    if (this.threadPool.length < this.maxPoolSize) {
      return this.createReservedThread(undefined, config);
    }

    const recycledThread = await this.allocateThreadAtCapacity({ reason: 'create-session', config });
    return recycledThread;
  }

  private async getSessionMcpServers(thread: AcpThread, config: AgentProcessConfig): Promise<McpServer[]> {
    const mcpServers = config.mcpServers ?? [];

    const mcpCapabilities = thread.agentCapabilities?.mcpCapabilities;
    const configuredServers = mcpServers.filter((server) => {
      const type = (server as { type?: string }).type;
      if (type === 'http') {
        const supported = mcpCapabilities?.http === true;
        if (!supported) {
          this.logger.warn(`[AcpAgentService] Skipping HTTP MCP server "${server.name}"; agent does not support it`);
        }
        return supported;
      }
      if (type === 'sse') {
        const supported = mcpCapabilities?.sse === true;
        if (!supported) {
          this.logger.warn(`[AcpAgentService] Skipping SSE MCP server "${server.name}"; agent does not support it`);
        }
        return supported;
      }
      return true;
    });

    if (config.webMcp?.enabled === false) {
      this.logger.log('[AcpAgentService] Skipping built-in MCP server; WebMCP is disabled by configuration');
      return configuredServers;
    }

    if (mcpCapabilities?.http !== true || !this.opensumiMcpHttpServer) {
      return configuredServers;
    }

    const serverName = this.opensumiMcpHttpServer.getServerName();
    if (configuredServers.some((server) => server.name === serverName)) {
      this.logger.warn(`[AcpAgentService] Skipping built-in MCP server "${serverName}"; name already configured`);
      return configuredServers;
    }

    try {
      await this.opensumiMcpHttpServer.start();
      return [
        ...configuredServers,
        {
          name: serverName,
          type: 'http',
          url: this.opensumiMcpHttpServer.getUrl(),
          headers: [],
        },
      ];
    } catch (error) {
      this.logger.warn(`[AcpAgentService] Skipping built-in MCP server "${serverName}"; failed to start`, error);
      return configuredServers;
    }
  }

  /**
   * Initialize at most one process for one agent runtime configuration.
   * Callers with the same configuration can claim an in-flight warmup instead
   * of spawning another process.
   */
  async warmUpAgentPool(config: AgentProcessConfig): Promise<void> {
    if (this.stopping || this.terminallyDisposed) {
      return;
    }
    this.syncMaxPoolSize(config);

    const runtimeConfigKey = this.createThreadRuntimeConfigKey(config);
    const existingWarmup = this.poolWarmups.get(runtimeConfigKey);
    if (existingWarmup) {
      return existingWarmup;
    }

    const warmup = this.doWarmUpAgentPool(config);
    this.poolWarmups.set(runtimeConfigKey, warmup);
    try {
      await warmup;
    } finally {
      if (this.poolWarmups.get(runtimeConfigKey) === warmup) {
        this.poolWarmups.delete(runtimeConfigKey);
      }
    }
  }

  private async doWarmUpAgentPool(config: AgentProcessConfig): Promise<void> {
    const hasLiveProcess = this.threadPool.some((thread) => thread.getStatus() !== 'disconnected');
    const capacity = Math.max(0, this.maxPoolSize - this.threadPool.length);
    const targetCount = hasLiveProcess || capacity === 0 ? 0 : 1;

    if (targetCount === 0) {
      return;
    }

    this.logger.log(
      `[AcpAgentService] warmUpAgentPool() — starting ${targetCount} threads for command=${config.command}, cwd=${config.cwd}`,
    );

    const warmups: Promise<void>[] = [];
    for (let index = 0; index < targetCount; index += 1) {
      const thread = this.createThreadInstance('', config);
      this.threadPool.push(thread);

      warmups.push(this.initializeWarmingThread(thread, config));
    }

    await Promise.all(warmups);
    this.logger.log(
      `[AcpAgentService] warmUpAgentPool() — completed, pool=${this.threadPool.length}/${this.maxPoolSize}`,
    );
    this.logPoolStatus('after-warmUpAgentPool');
  }

  private initializeWarmingThread(thread: AcpThread, config: AgentProcessConfig): Promise<void> {
    // Defer initialize to a microtask so the thread is visible as warming
    // before an implementation can synchronously throw.
    const warmup = Promise.resolve()
      .then(async () => {
        await thread.initialize(config as any);
      })
      .catch(async (error) => {
        this.logger.warn(
          `[AcpAgentService] warmUpAgentPool() — failed to initialize thread ${thread.threadId}: ${getAcpErrorMessage(
            error,
          )}`,
        );
        const index = this.threadPool.indexOf(thread);
        if (index !== -1) {
          this.threadPool.splice(index, 1);
        }
        try {
          await thread.dispose();
        } catch (disposeError) {
          this.logger.warn(
            `[AcpAgentService] warmUpAgentPool() — failed to dispose thread ${thread.threadId}: ${getAcpErrorMessage(
              disposeError,
            )}`,
          );
        }
      })
      .finally(() => {
        this.warmingThreads.delete(thread);
      });
    this.warmingThreads.set(thread, warmup);
    return warmup;
  }

  private didAppendBuiltInMcpServer(config: AgentProcessConfig, mcpServers: McpServer[]): boolean {
    const serverName = this.opensumiMcpHttpServer?.getServerName();
    if (!serverName || (config.mcpServers ?? []).some((server) => server.name === serverName)) {
      return false;
    }
    return mcpServers.some((server) => server.name === serverName);
  }

  private setBuiltInMcpSessionState(sessionId: string, enabled: boolean): void {
    if (enabled) {
      this.builtInMcpSessionIds.add(sessionId);
    } else {
      this.builtInMcpSessionIds.delete(sessionId);
    }
  }

  async getOpenSumiMcpServerConnection(clientId?: string): Promise<OpenSumiMcpServerConnectionInfo> {
    this.throwIfStopping();
    if (!this.opensumiMcpHttpServer) {
      throw new Error('[AcpAgentService] OpenSumi MCP server is not available');
    }
    await this.opensumiMcpHttpServer.start();
    return this.opensumiMcpHttpServer.getConnectionInfo(clientId);
  }

  // -----------------------------------------------------------------------
  // createSession — with Deferred pattern (NOT setTimeout)
  // -----------------------------------------------------------------------

  createSession(config: AgentProcessConfig): Promise<{
    sessionId: string;
    availableCommands: AvailableCommand[];
    modes?: Array<{ id: string; name: string; description?: string }>;
    currentModeId?: string;
    models?: Array<{ modelId: string; name: string; description?: string | null }>;
    currentModelId?: string;
    configOptions?: Record<string, any>[];
  }> {
    return this.trackForegroundOperation(() => this.doCreateSession(config));
  }

  private async doCreateSession(config: AgentProcessConfig): Promise<{
    sessionId: string;
    availableCommands: AvailableCommand[];
    modes?: Array<{ id: string; name: string; description?: string }>;
    currentModeId?: string;
    models?: Array<{ modelId: string; name: string; description?: string | null }>;
    currentModelId?: string;
    configOptions?: Record<string, any>[];
  }> {
    this.logger.log(`[AcpAgentService] createSession() — cwd=${config.cwd}, command=${config.command}`);
    const thread = await this.findOrCreateIdleThread(config);
    const cleanup = this.beginSessionOperation('create', thread);

    const availableCommands: AvailableCommand[] = [];
    const deferred = new Deferred<void>();

    const disposable = thread.onEvent((event: AcpThreadEvent) => {
      if (event.type === 'session_notification') {
        const update = (event.notification as any).update;
        if (update?.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) {
          availableCommands.push(...update.availableCommands);
          deferred.resolve();
        }
      }
    });

    let realSessionId: string | undefined;

    try {
      this.throwIfStopping();
      if (!thread.initialized) {
        await thread.initialize(config as any);
        this.throwIfStopping();
      }
      if (thread.needsReset) {
        thread.reset();
      }

      const mcpServers = await this.getSessionMcpServers(thread, config);
      this.throwIfStopping();
      const newSessionResponse = await thread.newSession({
        cwd: config.cwd,
        mcpServers,
      } as any);

      realSessionId = newSessionResponse.sessionId;
      this.observeSessionOperationIdentity(cleanup, realSessionId, 'created');
      this.throwIfStopping();
      this.throwIfSessionOperationClosed(cleanup);
      this.setBuiltInMcpSessionState(realSessionId, this.didAppendBuiltInMcpServer(config, mcpServers));
      await this.applyDefaultSessionOptions(realSessionId, thread, config);
      this.throwIfStopping();
      this.throwIfSessionOperationClosed(cleanup);
      this.bindSession(realSessionId, thread);
      this.sessionRefCounts.set(realSessionId, 1);
      this.permissionRouting.registerSession(realSessionId);
      this.registerThreadStatusListener(realSessionId, thread);

      await Promise.race([
        deferred.promise,
        cleanup.closeDeferred.promise,
        new Promise<void>((resolve) => setTimeout(resolve, this.availableCommandsWaitMs)),
      ]);
      this.throwIfStopping();
      this.throwIfSessionOperationClosed(cleanup);

      const seen = new Set<string>();
      const deduplicated = availableCommands.filter((cmd) => {
        if (seen.has(cmd.name)) {
          return false;
        }
        seen.add(cmd.name);
        return true;
      });

      const sessionState = thread.getSessionState();
      const modes = sessionState.modes
        ? sessionState.modes.map(({ id, name, description }) => ({ id, name, description: description ?? undefined }))
        : [];
      this.updateLastSessionInfo(realSessionId, thread, modes);

      this.logger.log(
        `[AcpAgentService] createSession() — done, sessionId=${realSessionId}, commands=${deduplicated.length}`,
      );
      this.logPoolStatus('after-createSession');

      return {
        sessionId: realSessionId,
        availableCommands: deduplicated,
        modes,
        currentModeId: sessionState.currentModeId,
        models: sessionState.models ? [...sessionState.models] : undefined,
        currentModelId: sessionState.currentModelId,
        configOptions: sessionState.configOptions
          ? ([...sessionState.configOptions] as Record<string, any>[])
          : undefined,
      };
    } catch (e) {
      this.logger.error(`[AcpAgentService] createSession() — failed: ${getAcpErrorMessage(e)}`);
      await this.cleanupFailedSessionOperation(cleanup, thread);
      throw e;
    } finally {
      this.finishSessionOperation(cleanup);
      this.reservedThreads.delete(thread);
      disposable.dispose();
    }
  }

  // -----------------------------------------------------------------------
  // initializeAgent — create a session and return info
  // -----------------------------------------------------------------------

  async initializeAgent(config: AgentProcessConfig): Promise<AgentSessionInfo> {
    const result = await this.createSession(config);
    return {
      sessionId: result.sessionId,
      processId: this.sessions.get(result.sessionId)?.threadId || '',
      modes: [],
      status: 'ready',
    };
  }

  // -----------------------------------------------------------------------
  // loadSession
  // -----------------------------------------------------------------------

  loadSession(sessionId: string, config: AgentProcessConfig): Promise<SessionLoadResult> {
    return this.trackForegroundOperation(() => this.doLoadSessionRequest(sessionId, config));
  }

  private async doLoadSessionRequest(sessionId: string, config: AgentProcessConfig): Promise<SessionLoadResult> {
    this.syncMaxPoolSize(config);
    this.logger.log(`[AcpAgentService] loadSession() — sessionId=${sessionId}`);

    // 1. If a load for this session is already in flight, join it. The
    // sessions map may already contain a pre-registered thread at this point,
    // but that thread is not safe to expose until the load RPC completes.
    const pendingLoad = this.getPendingSessionLoad(sessionId);
    if (pendingLoad) {
      this.retainPendingSessionLoad(pendingLoad);
      this.logger.log(
        `[AcpAgentService] loadSession() — joining pending load, sessionId=${sessionId}, refs=${pendingLoad.refCount}`,
      );
      return pendingLoad.promise;
    }

    // 2. sessions.get(sessionId) exists and no pending load -> already loaded
    const existingThread = this.sessions.get(sessionId);
    if (existingThread && existingThread.getStatus() !== 'disconnected') {
      this.touchSession(sessionId);
      this.retainSession(sessionId);
      this.permissionRouting.registerSession(sessionId);
      this.registerThreadStatusListener(sessionId, existingThread);
      this.logger.log(
        `[AcpAgentService] loadSession() — thread already bound, threadId=${existingThread.threadId}, cwd=${existingThread.cwd}`,
      );
      return this.buildSessionLoadResult(sessionId, existingThread);
    }

    // 3. Pool has idle Thread
    const idleThread = this.findReusableIdleThread(config);
    if (idleThread) {
      this.logger.log(
        `[AcpAgentService] loadSession() — reusing idle thread ${idleThread.threadId}, cwd=${idleThread.cwd}`,
      );
      this.reservedThreads.add(idleThread);
      this.bindSession(sessionId, idleThread);
      this.permissionRouting.registerSession(sessionId);
      this.registerThreadStatusListener(sessionId, idleThread);
      return this.startPendingLoadSessionAndReleaseReservation(sessionId, idleThread, config);
    }

    const warmingThread = await this.reserveWarmingThread(config);

    // Another request for the same session may have crossed the await above
    // and started its load first. Join that request instead of creating a
    // second thread and overwriting its retained-reference count.
    const concurrentPendingLoad = this.getPendingSessionLoad(sessionId);
    if (concurrentPendingLoad) {
      if (warmingThread) {
        this.reservedThreads.delete(warmingThread);
      }
      this.retainPendingSessionLoad(concurrentPendingLoad);
      this.logger.log(
        `[AcpAgentService] loadSession() — joining concurrent load after warmup wait, sessionId=${sessionId}, refs=${concurrentPendingLoad.refCount}`,
      );
      return concurrentPendingLoad.promise;
    }

    if (warmingThread) {
      this.logger.log(
        `[AcpAgentService] loadSession() — waiting for prewarmed thread ${warmingThread.threadId}, cwd=${warmingThread.cwd}`,
      );
      this.bindSession(sessionId, warmingThread);
      this.permissionRouting.registerSession(sessionId);
      this.registerThreadStatusListener(sessionId, warmingThread);
      return this.startPendingLoadSessionAndReleaseReservation(sessionId, warmingThread, config);
    }

    this.throwIfStopping();

    // 4. Pool not full -> new Thread
    if (this.threadPool.length < this.maxPoolSize) {
      this.logger.log(
        `[AcpAgentService] loadSession() — creating new thread (pool=${this.threadPool.length}/${this.maxPoolSize})`,
      );
      const thread = this.createThreadInstance(sessionId, config);
      this.threadPool.push(thread);
      this.bindSession(sessionId, thread);
      this.permissionRouting.registerSession(sessionId);
      this.registerThreadStatusListener(sessionId, thread);
      return this.startPendingLoadSession(sessionId, thread, config);
    }

    // 5. Pool full, no idle -> recycle least recently used reusable Thread
    const recycledThread = await this.allocateThreadAtCapacity({ sessionId, reason: 'load-session', config });
    this.bindSession(sessionId, recycledThread);
    this.permissionRouting.registerSession(sessionId);
    this.registerThreadStatusListener(sessionId, recycledThread);
    return this.startPendingLoadSessionAndReleaseReservation(sessionId, recycledThread, config);
  }

  private startPendingLoadSessionAndReleaseReservation(
    sessionId: string,
    thread: AcpThread,
    config: AgentProcessConfig,
  ): Promise<SessionLoadResult> {
    const promise = this.startPendingLoadSession(sessionId, thread, config);
    this.reservedThreads.delete(thread);
    return promise;
  }

  private startPendingLoadSession(
    sessionId: string,
    thread: AcpThread,
    config: AgentProcessConfig,
  ): Promise<SessionLoadResult> {
    const cleanup = this.beginSessionOperation('load', thread);
    this.observeSessionOperationIdentity(cleanup, sessionId, 'requested');
    const pending: PendingSessionLoad = {
      promise: Promise.resolve(null as unknown as SessionLoadResult),
      refCount: 1,
      thread,
      boundSessionId: sessionId,
      closeRequested: false,
      terminalReleaseOwnedByStop: this.stopping || this.terminallyDisposed,
      cleanup,
    };

    const promise = this.doLoadSession(sessionId, thread, config)
      .then(() => {
        if (pending.closeRequested) {
          throw new Error(`Session load was disposed before completion: ${sessionId}`);
        }
        this.sessionRefCounts.set(sessionId, pending.refCount);
        return this.buildSessionLoadResult(sessionId, thread);
      })
      .catch(async (e) => {
        if (pending.terminalReleaseOwnedByStop) {
          // Consume the pending-load handoff explicitly. The requested
          // identity was already queued by stop and must not be released by
          // this late catch a second time.
          this.transferSessionOperationCleanup(cleanup, 'stop');
        }
        await this.cleanupFailedSessionOperation(cleanup, thread);
        this.logger.error(`[AcpAgentService] loadSession() — failed: ${getAcpErrorMessage(e)}`);
        throw mapSessionLoadError(e);
      })
      .finally(() => {
        this.pendingSessionLoads.delete(sessionId);
        this.finishSessionOperation(cleanup);
      });

    pending.promise = promise;
    this.pendingSessionLoads.set(sessionId, pending);
    return promise;
  }

  private async doLoadSession(sessionId: string, thread: AcpThread, config: AgentProcessConfig): Promise<void> {
    if (!thread.initialized) {
      await thread.initialize(config as any);
      this.throwIfStopping();
    }
    if (thread.needsReset) {
      thread.reset();
    }
    const mcpServers = await this.getSessionMcpServers(thread, config);
    this.throwIfStopping();
    await thread.loadSession({
      sessionId,
      cwd: config.cwd,
      mcpServers,
    } as any);
    this.throwIfStopping();
    this.setBuiltInMcpSessionState(sessionId, this.didAppendBuiltInMcpServer(config, mcpServers));
    await this.applyDefaultSessionOptions(sessionId, thread, config);
    this.throwIfStopping();
  }

  private buildSessionLoadResult(sessionId: string, thread: AcpThread): SessionLoadResult {
    const historyUpdates = [...thread.getSessionNotifications()];
    const sessionState = thread.getSessionState();
    const modes = sessionState.modes
      ? sessionState.modes.map(({ id, name, description }) => ({ id, name, description: description ?? undefined }))
      : [];

    this.updateLastSessionInfo(sessionId, thread, modes);

    return {
      sessionId,
      processId: thread.threadId,
      modes,
      currentModeId: sessionState.currentModeId,
      models: sessionState.models ? [...sessionState.models] : undefined,
      currentModelId: sessionState.currentModelId,
      configOptions: sessionState.configOptions
        ? ([...sessionState.configOptions] as Record<string, any>[])
        : undefined,
      status: 'ready',
      threadStatus: thread.getStatus(),
      historyUpdates,
    };
  }

  private async applyDefaultSessionOptions(
    sessionId: string,
    thread: AcpThread,
    config: AgentProcessConfig,
  ): Promise<void> {
    const sessionState = thread.getSessionState();

    if (config.defaultMode) {
      const hasMode = sessionState.modes?.some((mode) => mode.id === config.defaultMode) === true;
      if (hasMode) {
        try {
          await thread.setSessionMode({ sessionId, modeId: config.defaultMode } as any);
        } catch (error) {
          this.logger.warn(`[AcpAgentService] Failed to apply defaultMode "${config.defaultMode}"`, error);
        }
      } else {
        this.logger.warn(`[AcpAgentService] Invalid defaultMode "${config.defaultMode}" for session ${sessionId}`);
      }
    }

    if (config.defaultModel) {
      const hasModel = sessionState.models?.some((model) => model.modelId === config.defaultModel) === true;
      if (hasModel) {
        try {
          await thread.unstable_setSessionModel({ sessionId, model: config.defaultModel } as any);
        } catch (error) {
          this.logger.warn(`[AcpAgentService] Failed to apply defaultModel "${config.defaultModel}"`, error);
        }
      } else {
        this.logger.warn(`[AcpAgentService] Invalid defaultModel "${config.defaultModel}" for session ${sessionId}`);
      }
    }

    const defaults = config.defaultConfigOptions;
    if (!defaults || Object.keys(defaults).length === 0) {
      return;
    }

    const configOptions = Array.isArray(sessionState.configOptions) ? sessionState.configOptions : [];
    for (const [configId, value] of Object.entries(defaults)) {
      const option = configOptions.find((item) => this.getConfigOptionId(item) === configId);
      if (!option) {
        this.logger.warn(`[AcpAgentService] Invalid defaultConfigOptions key "${configId}" for session ${sessionId}`);
        continue;
      }

      if (typeof value === 'string') {
        const validValues = this.collectConfigOptionValues(option);
        if (validValues.size === 0 || !validValues.has(value)) {
          this.logger.warn(
            `[AcpAgentService] Invalid defaultConfigOptions value "${value}" for config option "${configId}"`,
          );
          continue;
        }
      }

      try {
        await thread.setSessionConfigOption({ sessionId, configId, value } as any);
      } catch (error) {
        this.logger.warn(`[AcpAgentService] Failed to apply defaultConfigOptions "${configId}"`, error);
      }
    }
  }

  private getConfigOptionId(option: unknown): string | undefined {
    const rawId = (option as { id?: unknown; configId?: unknown })?.id ?? (option as { configId?: unknown })?.configId;
    if (typeof rawId === 'string') {
      return rawId;
    }
    if (rawId && typeof rawId === 'object' && typeof (rawId as { id?: unknown }).id === 'string') {
      return (rawId as { id: string }).id;
    }
    return undefined;
  }

  private collectConfigOptionValues(option: unknown): Set<string> {
    const values = new Set<string>();
    const roots = [
      (option as any)?.options,
      (option as any)?.values,
      (option as any)?.kind?.options,
      (option as any)?.kind?.select?.options,
      (option as any)?.select?.options,
    ].filter(Boolean);

    const visit = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(visit);
        return;
      }
      if (!node || typeof node !== 'object') {
        return;
      }
      const record = node as Record<string, unknown>;
      const value = record.value;
      if (typeof value === 'string') {
        values.add(value);
      } else if (value && typeof value === 'object' && typeof (value as { id?: unknown }).id === 'string') {
        values.add((value as { id: string }).id);
      }
      visit(record.options);
      visit(record.values);
      visit(record.groups);
    };

    roots.forEach(visit);
    return values;
  }

  // -----------------------------------------------------------------------
  // sendMessage — streaming forward
  // -----------------------------------------------------------------------

  attachSession(sessionId: string): SumiReadableStream<AgentSessionAttachmentUpdate> {
    const stream = new SumiReadableStream<AgentSessionAttachmentUpdate>();
    try {
      this.throwIfStopping();
    } catch (error) {
      stream.emitError(normalizeAcpError(error));
      return stream;
    }
    const thread = this.sessions.get(sessionId);
    if (!thread || thread.getStatus() === 'disconnected') {
      stream.emitError(new Error(`No active session for sessionId: ${sessionId}`));
      return stream;
    }

    this.touchSession(sessionId);
    let snapshotEmitted = false;
    const bufferedUpdates: AgentUpdate[] = [];

    const emitUpdate = (update: AgentUpdate) => {
      update.sessionId = update.sessionId || sessionId;
      update.threadStatus = update.threadStatus || thread.getStatus();
      if (!snapshotEmitted) {
        bufferedUpdates.push(update);
        return;
      }
      stream.emitData({ type: 'update', update });
    };

    const eventDisposable = thread.onEvent((event: AcpThreadEvent) => {
      if (event.type === 'session_notification') {
        if (event.notification.sessionId && event.notification.sessionId !== sessionId) {
          this.logger.warn(
            `[AcpAgentService] attachSession() — ignoring notification for ${event.notification.sessionId}; current session is ${sessionId}`,
          );
          return;
        }
        const agentUpdates = toAgentUpdate(event.notification);
        if (Array.isArray(agentUpdates)) {
          agentUpdates.forEach(emitUpdate);
        } else if (agentUpdates) {
          emitUpdate(agentUpdates);
        }
      } else if (event.type === 'status_changed') {
        emitUpdate({
          type: 'thread_status',
          content: '',
          sessionId,
          threadStatus: event.status,
        });
      }
    });

    this.trackAttachmentStream(stream, () => eventDisposable.dispose());

    stream.emitData({
      type: 'snapshot',
      snapshot: {
        ...this.buildSessionLoadResult(sessionId, thread),
        threadStatus: thread.getStatus(),
      },
    });
    snapshotEmitted = true;
    bufferedUpdates.splice(0).forEach((update) => stream.emitData({ type: 'update', update }));
    return stream;
  }

  sendMessage(request: AgentRequest, config: AgentProcessConfig): SumiReadableStream<AgentUpdate> {
    const stream = new SumiReadableStream<AgentUpdate>();
    try {
      this.throwIfStopping();
    } catch (error) {
      stream.emitError(normalizeAcpError(error));
      return stream;
    }
    void this.trackStartedForegroundOperation(this.startSendMessage(request, config, stream)).catch((error) => {
      stream.emitError(normalizeAcpError(error));
    });
    return stream;
  }

  private async startSendMessage(
    request: AgentRequest,
    config: AgentProcessConfig,
    stream: SumiReadableStream<AgentUpdate>,
  ): Promise<void> {
    let thread = this.sessions.get(request.sessionId);
    if (!thread) {
      this.logger.log(`[AcpAgentService] sendMessage() — session not active, loading sessionId=${request.sessionId}`);
      try {
        await this.loadSession(request.sessionId, config);
        thread = this.sessions.get(request.sessionId);
      } catch (error) {
        stream.emitError(normalizeAcpError(error));
        return;
      }
      if (!thread) {
        stream.emitError(new Error(`No active session for sessionId: ${request.sessionId}`));
        return;
      }
    }
    this.touchSession(request.sessionId);

    // Add user message to thread entries
    thread.addUserMessage(request.prompt);

    // Emit the current thread status as the first update so the browser
    // always receives the status even if no status_changed event fires
    // during this prompt (e.g. session was already awaiting_prompt).
    const currentStatus = thread.getStatus();
    if (currentStatus) {
      stream.emitData({ type: 'thread_status', content: '', threadStatus: currentStatus });
    }

    this.logger.log(
      `[AcpAgentService] sendMessage() — sessionId=${request.sessionId}, thread=${thread.threadId}, entries=${
        thread.getEntries().length
      }`,
    );

    // Subscribe thread.onEvent: session_notification -> emitData to stream
    const disposables: IDisposable[] = [];

    const eventDisposable = thread.onEvent((event: AcpThreadEvent) => {
      if (event.type === 'session_notification') {
        if (event.notification.sessionId && event.notification.sessionId !== request.sessionId) {
          this.logger.warn(
            `[AcpAgentService] sendMessage() — ignoring notification for ${event.notification.sessionId}; current session is ${request.sessionId}`,
          );
          return;
        }
        const agentUpdates = toAgentUpdate(event.notification);
        const normalizedUpdates = Array.isArray(agentUpdates) ? agentUpdates : [];
        if (agentUpdates && !Array.isArray(agentUpdates)) {
          normalizedUpdates.push(agentUpdates);
        }
        for (const agentUpdate of normalizedUpdates) {
          agentUpdate.threadStatus = thread.getStatus();
          agentUpdate.sessionId = agentUpdate.sessionId || event.notification.sessionId || request.sessionId;
          stream.emitData(agentUpdate);
        }
      } else if (event.type === 'status_changed') {
        // Emit standalone threadStatus update for status transitions that don't
        // coincide with a session_notification (e.g. disconnected, errored, idle).
        stream.emitData({ type: 'thread_status', content: '', threadStatus: event.status });
      }
    });
    disposables.push(eventDisposable);

    // Stream onEnd / onError -> cleanup subscriptions
    stream.onEnd(() => {
      disposables.forEach((d) => d.dispose());
    });
    stream.onError(() => {
      disposables.forEach((d) => d.dispose());
    });

    // thread.prompt() -> then markAssistantComplete -> emitData('done') -> stream.end()
    await this.sendPrompt(thread, request, config, stream, disposables);
  }

  private async sendPrompt(
    thread: AcpThread,
    request: AgentRequest,
    config: AgentProcessConfig,
    stream: SumiReadableStream<AgentUpdate>,
    disposables: IDisposable[],
  ): Promise<void> {
    try {
      const webMcpHintsEnabled = config.webMcp?.enabled !== false && this.builtInMcpSessionIds.has(request.sessionId);
      const promptForAgent = await this.withWebMcpCapabilityHint(
        request.prompt,
        webMcpHintsEnabled && thread.getEntries().length <= 1,
        webMcpHintsEnabled,
      );
      const promptBlocks = this.buildPromptBlocks(promptForAgent, request.images);
      this.logger.log(
        `[AcpAgentService] sendPrompt() — sessionId=${request.sessionId}, promptChars=${
          request.prompt.length
        }, promptBytes=${Buffer.byteLength(request.prompt, 'utf8')}, sentPromptChars=${
          promptForAgent.length
        }, sentPromptBytes=${Buffer.byteLength(promptForAgent, 'utf8')}, images=${
          request.images?.length ?? 0
        }, blocks=${promptBlocks.length}, entries=${thread.getEntries().length}`,
      );
      await thread.prompt({
        sessionId: request.sessionId,
        prompt: promptBlocks,
      } as any);
      this.logger.log(
        `[AcpAgentService] sendPrompt() — prompt returned, sessionId=${request.sessionId}, thread=${thread.threadId}`,
      );

      thread.markAssistantComplete();
      stream.emitData({ type: 'done', content: '' });
      stream.end();
    } catch (error) {
      this.logger.error(
        `[AcpAgentService] sendPrompt() — failed, sessionId=${request.sessionId}, thread=${
          thread.threadId
        }, error=${getAcpErrorMessage(error)}`,
      );
      stream.emitError(normalizeAcpError(error));
    }
  }

  // -----------------------------------------------------------------------
  // cancelRequest
  // -----------------------------------------------------------------------

  async cancelRequest(sessionId: string): Promise<void> {
    const thread = this.sessions.get(sessionId);
    if (!thread) {
      this.logger?.warn(`[AcpAgentService] cancelRequest: no thread for session ${sessionId}`);
      return;
    }
    this.touchSession(sessionId);

    try {
      await thread.cancel({ sessionId } as any);
    } catch (error) {
      this.logger?.warn('[AcpAgentService] cancelRequest error:', error);
    }
  }

  // -----------------------------------------------------------------------
  // listSessions
  // -----------------------------------------------------------------------

  listSessions(params?: ListSessionsRequest, config?: AgentProcessConfig): Promise<ListSessionsResponse> {
    return this.trackForegroundOperation(() => this.doListSessions(params, config));
  }

  private async doListSessions(
    params?: ListSessionsRequest,
    config?: AgentProcessConfig,
  ): Promise<ListSessionsResponse> {
    const sessionsMap = new Map<string, SessionInfo>();
    let lastNextCursor: string | undefined;
    let activeThreadCount = 0;

    for (const [sessionId, thread] of this.sessions) {
      if (thread.getStatus() === 'disconnected' || (config && !this.canReuseThreadForConfig(thread, config))) {
        continue;
      }
      activeThreadCount++;
      try {
        const result = await thread.listSessions(params);
        if (result?.sessions) {
          for (const info of result.sessions) {
            sessionsMap.set(info.sessionId, info);
          }
        }
        // nextCursor/_meta are thread-specific; only meaningful for single-thread results
        if (result?.nextCursor) {
          lastNextCursor = result.nextCursor;
        }
      } catch (error) {
        this.logger?.warn(`[AcpAgentService] listSessions error for thread ${sessionId}, cwd=${thread.cwd}:`, error);
      }
    }

    if (activeThreadCount === 0 && config) {
      const thread = await this.findOrCreateIdleThread(config);
      try {
        if (!thread.initialized) {
          await thread.initialize(config as any);
          this.throwIfStopping();
        }
        if (thread.needsReset) {
          thread.reset();
        }
        const result = await thread.listSessions(params);
        if (result?.sessions) {
          for (const info of result.sessions) {
            sessionsMap.set(info.sessionId, info);
          }
        }
        if (result?.nextCursor) {
          lastNextCursor = result.nextCursor;
        }
        activeThreadCount = 1;
      } catch (error) {
        this.logger?.warn(`[AcpAgentService] listSessions error for idle thread, cwd=${thread.cwd}:`, error);
      } finally {
        this.reservedThreads.delete(thread);
      }
    }

    // Single active thread: preserve its cursor for pagination
    // Multiple threads: cursors can't be meaningfully merged, so clear
    return {
      sessions: Array.from(sessionsMap.values()),
      nextCursor: activeThreadCount === 1 ? lastNextCursor : undefined,
    };
  }

  // -----------------------------------------------------------------------
  // setSessionMode
  // -----------------------------------------------------------------------

  async setSessionMode(params: { sessionId: string; modeId: string }): Promise<void> {
    const thread = this.sessions.get(params.sessionId);
    if (!thread) {
      throw new Error(`No active session for sessionId: ${params.sessionId}`);
    }
    this.touchSession(params.sessionId);

    try {
      await thread.setSessionMode({
        sessionId: params.sessionId,
        modeId: params.modeId,
      } as any);
    } catch (error) {
      this.logger?.warn(`[AcpAgentService] setSessionMode error for session ${params.sessionId}:`, error);
      throw error;
    }
  }

  // -----------------------------------------------------------------------
  // loadSessionOrNew — with fallback
  // -----------------------------------------------------------------------

  loadSessionOrNew(sessionId: string, config: AgentProcessConfig): Promise<SessionLoadResult> {
    return this.trackForegroundOperation(() => this.doLoadSessionOrNew(sessionId, config));
  }

  private async doLoadSessionOrNew(sessionId: string, config: AgentProcessConfig): Promise<SessionLoadResult> {
    this.syncMaxPoolSize(config);
    this.logger.log(`[AcpAgentService] loadSessionOrNew() — sessionId=${sessionId}`);

    const pendingLoad = this.getPendingSessionLoad(sessionId);
    if (pendingLoad) {
      this.retainPendingSessionLoad(pendingLoad);
      return pendingLoad.promise;
    }

    const existingThread = this.sessions.get(sessionId);
    if (existingThread && existingThread.getStatus() !== 'disconnected') {
      this.touchSession(sessionId);
      this.retainSession(sessionId);
      return this.buildSessionLoadResult(sessionId, existingThread);
    }

    const thread = await this.findOrCreateThread(sessionId, config);
    const cleanup = this.beginSessionOperation('load-or-new', thread);
    const requestedIdentity = this.observeSessionOperationIdentity(cleanup, sessionId, 'requested');
    this.permissionRouting.registerSession(sessionId);
    this.registerThreadStatusListener(sessionId, thread);
    const pending: PendingSessionLoad = {
      promise: Promise.resolve(null as unknown as SessionLoadResult),
      refCount: 1,
      thread,
      boundSessionId: sessionId,
      closeRequested: false,
      terminalReleaseOwnedByStop: this.stopping || this.terminallyDisposed,
      cleanup,
    };

    const promise = Promise.resolve()
      .then(async (): Promise<SessionLoadResult> => {
        if (!thread.initialized) {
          await thread.initialize(config as any);
          this.throwIfStopping();
        }
        if (thread.needsReset) {
          thread.reset();
        }
        const mcpServers = await this.getSessionMcpServers(thread, config);
        this.throwIfStopping();
        const loadResult = await thread.loadSessionOrNew({
          sessionId,
          cwd: config.cwd,
          mcpServers,
        } as any);
        const actualSessionId = (loadResult as { sessionId?: string }).sessionId || sessionId;
        if (!hasAcpLoadSessionFallbackProvenance(loadResult)) {
          throw new Error('loadSessionOrNew did not report fallback provenance');
        }
        const createdByFallback = loadResult.createdByFallback;
        if (!createdByFallback && actualSessionId !== sessionId) {
          throw new Error(
            `loadSessionOrNew returned a different session id without fallback provenance: ${actualSessionId}`,
          );
        }
        if (createdByFallback) {
          this.observeSessionOperationIdentity(cleanup, actualSessionId, 'created');
        }
        this.throwIfStopping();
        if (pending.closeRequested) {
          throw new Error(`Session load was disposed before completion: ${sessionId}`);
        }
        if (createdByFallback && actualSessionId !== sessionId) {
          this.sessions.delete(sessionId);
          this.sessionRefCounts.delete(sessionId);
          this.permissionRouting.unregisterSession(sessionId);
          this.builtInMcpSessionIds.delete(sessionId);
          this.unregisterThreadStatusListener(sessionId);
          this.bindSession(actualSessionId, thread);
          pending.boundSessionId = actualSessionId;
          this.sessionRefCounts.set(actualSessionId, pending.refCount);
          this.permissionRouting.registerSession(actualSessionId);
          this.registerThreadStatusListener(actualSessionId, thread);
        } else {
          this.sessionRefCounts.set(sessionId, pending.refCount);
        }
        if (createdByFallback && requestedIdentity.owner === 'operation') {
          // The requested load identity is no longer active. Retire it even
          // when the newly-created session happens to reuse the same string.
          await this.retireSessionOperationIdentity(requestedIdentity);
        }
        this.setBuiltInMcpSessionState(actualSessionId, this.didAppendBuiltInMcpServer(config, mcpServers));
        await this.applyDefaultSessionOptions(actualSessionId, thread, config);
        this.throwIfStopping();
        if (pending.closeRequested) {
          throw new Error(`Session load was disposed before completion: ${sessionId}`);
        }
        return this.buildSessionLoadResult(actualSessionId, thread);
      })
      .catch(async (e) => {
        if (pending.terminalReleaseOwnedByStop) {
          this.transferSessionOperationCleanup(cleanup, 'stop');
        }
        await this.cleanupFailedSessionOperation(cleanup, thread);
        throw e;
      })
      .finally(() => {
        this.pendingSessionLoads.delete(sessionId);
        this.finishSessionOperation(cleanup);
      });

    pending.promise = promise;
    this.pendingSessionLoads.set(sessionId, pending);
    this.reservedThreads.delete(thread);
    return promise;
  }

  // -----------------------------------------------------------------------
  // setSessionConfigOption
  // -----------------------------------------------------------------------

  async setSessionConfigOption(params: {
    sessionId: string;
    configId: string;
    value: boolean | string;
  }): Promise<void> {
    const thread = this.sessions.get(params.sessionId);
    if (!thread) {
      throw new Error(`No active session for sessionId: ${params.sessionId}`);
    }
    this.touchSession(params.sessionId);
    try {
      // SDK uses a discriminated union: { type: "boolean"; value: boolean } | { value: string }
      // We infer the correct variant from the value's runtime type.
      const request: SetSessionConfigOptionRequest = {
        sessionId: params.sessionId,
        configId: params.configId,
        value: params.value,
      };
      if (typeof params.value === 'boolean') {
        request.type = 'boolean';
      }

      await thread.setSessionConfigOption(request as any);
    } catch (error) {
      this.logger?.warn(`[AcpAgentService] setSessionConfigOption error for session ${params.sessionId}:`, error);
      throw error;
    }
  }

  // -----------------------------------------------------------------------
  // forkSession
  // -----------------------------------------------------------------------

  async forkSession(params: {
    sessionId: string;
    cwd?: string;
    mcpServers?: McpServer[];
  }): Promise<{ sessionId: string }> {
    const thread = this.sessions.get(params.sessionId);
    if (!thread) {
      throw new Error(`No active session for sessionId: ${params.sessionId}`);
    }
    this.touchSession(params.sessionId);
    try {
      const response = await thread.unstable_forkSession({
        sessionId: params.sessionId,
        cwd: params.cwd,
        mcpServers: params.mcpServers,
      } as any);
      return { sessionId: response.sessionId };
    } catch (error) {
      this.logger?.warn(`[AcpAgentService] forkSession error for session ${params.sessionId}:`, error);
      throw error;
    }
  }

  // -----------------------------------------------------------------------
  // resumeSession
  // -----------------------------------------------------------------------

  async resumeSession(params: { sessionId: string; cwd?: string }): Promise<void> {
    const thread = this.sessions.get(params.sessionId);
    if (!thread) {
      throw new Error(`No active session for sessionId: ${params.sessionId}`);
    }
    this.touchSession(params.sessionId);
    try {
      await thread.unstable_resumeSession({ sessionId: params.sessionId, cwd: params.cwd ?? thread.cwd });
    } catch (error) {
      this.logger?.warn(`[AcpAgentService] resumeSession error for session ${params.sessionId}:`, error);
      throw error;
    }
  }

  // -----------------------------------------------------------------------
  // closeSession
  // -----------------------------------------------------------------------

  async closeSession(params: { sessionId: string }): Promise<void> {
    const thread = this.sessions.get(params.sessionId);
    if (!thread) {
      throw new Error(`No active session for sessionId: ${params.sessionId}`);
    }
    this.touchSession(params.sessionId);
    try {
      await thread.unstable_closeSession({ sessionId: params.sessionId } as any);
    } catch (error) {
      this.logger?.warn(`[AcpAgentService] closeSession error for session ${params.sessionId}:`, error);
      throw error;
    }
  }

  // -----------------------------------------------------------------------
  // setSessionModel
  // -----------------------------------------------------------------------

  async setSessionModel(params: { sessionId: string; model: string }): Promise<void> {
    const thread = this.sessions.get(params.sessionId);
    if (!thread) {
      throw new Error(`No active session for sessionId: ${params.sessionId}`);
    }
    this.touchSession(params.sessionId);
    try {
      await thread.unstable_setSessionModel({ sessionId: params.sessionId, model: params.model } as any);
    } catch (error) {
      this.logger?.warn(`[AcpAgentService] setSessionModel error for session ${params.sessionId}:`, error);
      throw error;
    }
  }

  // -----------------------------------------------------------------------
  // disposeSession — default returns thread to pool, force disposes it
  // -----------------------------------------------------------------------

  async disposeSession(sessionId: string, force = false): Promise<void> {
    let thread = this.sessions.get(sessionId);
    this.logger.log(`[AcpAgentService] disposeSession() — sessionId=${sessionId}, force=${force}`);

    const liveCleanup = Array.from(this.sessionCleanupOperations).find((cleanup) =>
      cleanup.identities.some((identity) => identity.sessionId === sessionId),
    );
    const pendingLoad =
      this.getPendingSessionLoad(sessionId) ??
      (liveCleanup
        ? Array.from(this.pendingSessionLoads.values()).find(({ cleanup }) => cleanup === liveCleanup)
        : undefined);
    thread ??= pendingLoad?.thread ?? liveCleanup?.thread;
    if (!thread && !pendingLoad && !liveCleanup) {
      const pendingRelease = this.terminalReleaseStates.get(sessionId);
      if (pendingRelease && !this.stopping && !this.terminallyDisposed) {
        await this.releaseSessionTerminalsOnce(sessionId, pendingRelease.requestedGeneration);
      }
      return;
    }

    if (!force && pendingLoad) {
      pendingLoad.refCount = Math.max(0, pendingLoad.refCount - 1);
      if (this.sessions.get(pendingLoad.boundSessionId) === pendingLoad.thread) {
        this.sessionRefCounts.set(pendingLoad.boundSessionId, pendingLoad.refCount);
      }
      if (pendingLoad.refCount > 0) {
        this.logger.log(
          `[AcpAgentService] disposeSession() — pending load still retained, sessionId=${sessionId}, refs=${pendingLoad.refCount}`,
        );
        return;
      }
    } else {
      const refCount = this.sessionRefCounts.get(sessionId) ?? (thread ? 1 : 0);
      if (!force && refCount > 1) {
        this.sessionRefCounts.set(sessionId, refCount - 1);
        this.logger.log(
          `[AcpAgentService] disposeSession() — session still retained, sessionId=${sessionId}, refs=${refCount - 1}`,
        );
        return;
      }
    }

    if (thread) {
      // The binding may be removed before the operation and terminal cleanup
      // settle. Hold this independently-refcounted fence across every await so
      // no acquisition can reuse the retiring process in between continuations.
      this.retainThreadRetirement(thread);
    }

    let pendingCleanup: SessionOperationCleanup | undefined;
    if (pendingLoad) {
      pendingLoad.closeRequested = true;
      this.requestSessionOperationClose(pendingLoad.cleanup);
      pendingCleanup = pendingLoad.cleanup;
      pendingCleanup.forceDisposeRequested ||= force;
      this.transferSessionOperationCleanup(
        pendingCleanup,
        this.stopping || this.terminallyDisposed ? 'stop' : 'disposer',
      );
      if (!force) {
        try {
          await pendingLoad.promise;
        } catch {
          // The operation-scoped token is owned by this disposal (or stop), so
          // the pending catch only retires the thread.
        }
      }
      thread = this.sessions.get(sessionId) ?? pendingLoad.thread;
    } else if (liveCleanup) {
      pendingCleanup = liveCleanup;
      pendingCleanup.forceDisposeRequested ||= force;
      this.requestSessionOperationClose(liveCleanup);
      this.transferSessionOperationCleanup(liveCleanup, this.stopping || this.terminallyDisposed ? 'stop' : 'disposer');
    }

    const cleanupErrors: unknown[] = [];
    try {
      if (pendingCleanup) {
        if (pendingCleanup.owner === 'disposer') {
          for (const identitySessionId of new Set(pendingCleanup.identities.map(({ sessionId }) => sessionId))) {
            this.clearSessionRuntimeState(identitySessionId, pendingCleanup.thread);
          }
          await this.drainSessionOperationCleanup(pendingCleanup);
        }
      } else {
        await this.releaseSessionResources(sessionId);
      }
    } catch (error) {
      cleanupErrors.push(error);
    }

    if (pendingCleanup && !force) {
      // A live create can be blocked in a post-session RPC that the close
      // signal cannot cancel. Keep the retiring-thread fence until its catch
      // has completed, otherwise that late catch could reset a replacement
      // session that reused the same process.
      await pendingCleanup.completionDeferred.promise;
    }

    try {
      if (force && thread) {
        // Force dispose: release terminals + dispose thread
        this.logger.log(
          `[AcpAgentService] disposeSession() — force disposing thread ${thread.threadId}, cwd=${thread.cwd}`,
        );
        try {
          await thread.dispose();
        } catch (error) {
          cleanupErrors.push(error);
        }
        const idx = this.threadPool.indexOf(thread);
        if (idx !== -1) {
          this.threadPool.splice(idx, 1);
        }
      }

      // Default: just remove from session mapping, thread returns to pool.
      // Match the retired process identity so a concurrent same-id load on a
      // replacement thread remains authoritative.
      this.clearSessionRuntimeState(sessionId, thread);
      this.logPoolStatus('after-disposeSession');
    } finally {
      if (thread) {
        this.releaseThreadRetirement(thread);
      }
    }

    if (cleanupErrors.length === 1) {
      throw cleanupErrors[0];
    }
    if (cleanupErrors.length > 1) {
      throw new AggregateError(cleanupErrors, `Failed to dispose ACP session ${sessionId}`);
    }
  }

  // -----------------------------------------------------------------------
  // getAvailableModes
  // -----------------------------------------------------------------------

  async getAvailableModes(): Promise<any | null> {
    // Return modes from the most recently used thread
    for (const thread of this.threadPool) {
      // AcpThread stores agentCapabilities but not modes directly
      // Modes come from initialize response; would need to track them
    }
    return null;
  }

  async getAcpDebugLog(): Promise<AcpDebugLogEntry[]> {
    return acpDebugLogStore.getEntries();
  }

  async clearAcpDebugLog(): Promise<void> {
    acpDebugLogStore.clear();
  }

  // -----------------------------------------------------------------------
  // getSessionInfo
  // -----------------------------------------------------------------------

  getSessionInfo(sessionId?: string): AgentSessionInfo | null {
    if (sessionId) {
      const thread = this.sessions.get(sessionId);
      if (!thread) {
        return null;
      }
      return {
        sessionId,
        processId: thread.threadId,
        modes: [],
        status: this.threadStatusToAgentStatus(thread.getStatus()),
      };
    }
    return this.lastSessionInfo;
  }

  // -----------------------------------------------------------------------
  // stopAgent — dispose all threads
  // -----------------------------------------------------------------------

  stopAgent(): Promise<void> {
    if (this.stopPromise) {
      return this.stopPromise;
    }

    this.stopping = true;
    this.stopTimedOut = false;
    this.terminalCleanupSnapshotTaken = false;
    for (const pendingLoad of this.pendingSessionLoads.values()) {
      pendingLoad.terminalReleaseOwnedByStop = true;
    }
    for (const cleanup of this.sessionCleanupOperations) {
      this.transferSessionOperationCleanup(cleanup, 'stop');
    }
    let sharedStop!: Promise<void>;
    sharedStop = Promise.resolve()
      .then(() => this.doStopAgent())
      .finally(() => {
        if (this.stopPromise === sharedStop) {
          this.stopPromise = undefined;
        }
        for (const sessionId of this.lateTerminalReleaseIds) {
          this.scheduleLateTerminalRelease(sessionId);
        }
        if (!this.terminallyDisposed && !this.stopTimedOut && !this.ownershipRetirementFailed) {
          this.stopping = false;
        }
      });
    this.stopPromise = sharedStop;
    return sharedStop;
  }

  private async doStopAgent(): Promise<void> {
    this.logger?.log(
      `[AcpAgentService] stopAgent() — disposing ${this.threadPool.length} threads, ${this.sessions.size} active sessions`,
    );

    const attachments = Array.from(this.attachmentStreams);
    attachments.forEach((stream) => stream.end());

    const deadline = Date.now() + this.stopLeaseMs;
    const ownedThreads = Array.from(
      new Set([
        ...this.threadPool,
        ...this.sessions.values(),
        ...this.warmingThreads.keys(),
        ...Array.from(this.pendingSessionLoads.values(), ({ thread }) => thread),
      ]),
    );
    for (const warmup of this.warmingThreads.values()) {
      this.trackRetirementOperation(warmup, 'warmup');
    }
    for (const thread of ownedThreads) {
      let disposal: Promise<void>;
      try {
        disposal = thread.dispose();
      } catch (error) {
        disposal = Promise.reject(error);
      }
      this.trackRetirementOperation(disposal, 'thread');
    }

    const ownershipOperations = [
      ...Array.from(this.foregroundOperations, (operation) => ({ kind: 'foreground' as const, operation })),
      ...Array.from(this.pendingRetirementOperations, ([operation, kind]) => ({ kind, operation })),
    ];
    const ownershipSettlement = await settleWithinDeadline(
      ownershipOperations.map(({ operation }) => operation),
      deadline,
    );
    const stopErrors: unknown[] = [];
    ownershipSettlement.outcomes.forEach((outcome, index) => {
      if (outcome?.status === 'rejected' && ownershipOperations[index].kind === 'thread') {
        stopErrors.push(outcome.reason);
      }
    });
    if (ownershipSettlement.timedOut) {
      this.stopTimedOut = true;
      const timeoutError = createStopTimeoutError('thread, warmup, or foreground retirement');
      stopErrors.push(timeoutError);
      this.logger?.warn(timeoutError.message);
    }

    const operationCoveredSessionIds = new Set(
      Array.from(this.sessionCleanupOperations).flatMap(({ identities }) =>
        identities
          .filter(({ releaseGeneration, terminalRetired }) => releaseGeneration !== undefined || terminalRetired)
          .map(({ sessionId }) => sessionId),
      ),
    );
    for (const sessionId of this.sessions.keys()) {
      if (!this.pendingTerminalReleaseIds.has(sessionId) && !operationCoveredSessionIds.has(sessionId)) {
        this.requestSessionTerminalRelease(sessionId);
      }
    }
    this.terminalCleanupSnapshotTaken = true;
    const terminalReleaseErrors = await this.releasePendingTerminals(Date.now() + this.stopLeaseMs);
    stopErrors.push(...terminalReleaseErrors);

    const sessionIds = Array.from(this.sessions.keys());
    for (const sessionId of sessionIds) {
      this.clearSessionRuntimeState(sessionId);
    }

    this.threadPool = [];
    this.warmingThreads.clear();
    this.poolWarmups.clear();
    this.sessions.clear();
    this.pendingSessionLoads.clear();
    this.reservedThreads.clear();
    this.retiringThreads.clear();
    this.sessionRefCounts.clear();
    this.lastSessionInfo = null;
    this.builtInMcpSessionIds.clear();
    this.logPoolStatus('after-stopAgent');

    if (stopErrors.length > 0) {
      throw new AggregateError(stopErrors, 'ACP Agent service stop completed with cleanup failures');
    }
  }

  private async releasePendingTerminals(
    deadline: number,
    candidateSessionIds?: ReadonlySet<string>,
  ): Promise<unknown[]> {
    let finalErrors: unknown[] = [];
    for (
      let attempt = 1;
      attempt <= (this.terminallyDisposed ? 2 : 1) &&
      Array.from(this.pendingTerminalReleaseIds).some(
        (sessionId) => !candidateSessionIds || candidateSessionIds.has(sessionId),
      );
      attempt++
    ) {
      const sessionIds = Array.from(this.pendingTerminalReleaseIds).filter(
        (sessionId) => !candidateSessionIds || candidateSessionIds.has(sessionId),
      );
      const settlement = await settleWithinDeadline(
        sessionIds.map((sessionId) => this.releaseSessionTerminalsOnce(sessionId)),
        deadline,
      );
      finalErrors = [];
      settlement.outcomes.forEach((outcome, index) => {
        const sessionId = sessionIds[index];
        if (outcome?.status === 'rejected') {
          finalErrors.push(outcome.reason);
          this.logger?.warn(
            `[AcpAgentService] Failed to release terminals for session ${sessionId} (attempt ${attempt})`,
            outcome.reason,
          );
        }
      });
      if (settlement.timedOut) {
        this.stopTimedOut = true;
        const timeoutError = createStopTimeoutError('ACP session terminal release');
        finalErrors.push(timeoutError);
        this.logger?.warn(timeoutError.message);
        break;
      }
    }
    return finalErrors;
  }

  private scheduleLateTerminalRelease(sessionId: string): void {
    if (this.lateTerminalCleanupOperations.has(sessionId) || !this.pendingTerminalReleaseIds.has(sessionId)) {
      return;
    }

    this.logger?.log(`[AcpAgentService] Releasing terminal resources for late session ${sessionId}`);
    const candidates = new Set([sessionId]);
    const scheduledGeneration = this.terminalReleaseStates.get(sessionId)?.requestedGeneration ?? 0;
    let shouldContinue = false;
    let cleanup!: Promise<void>;
    cleanup = this.releasePendingTerminals(Date.now() + this.stopLeaseMs, candidates)
      .then((errors) => {
        if (errors.length > 0) {
          this.logger?.warn(
            `[AcpAgentService] Late terminal cleanup failed for session ${sessionId}`,
            new AggregateError(errors, `Late terminal cleanup failed for session ${sessionId}`),
          );
          shouldContinue = (this.terminalReleaseStates.get(sessionId)?.requestedGeneration ?? 0) > scheduledGeneration;
          return;
        }
        if (!this.pendingTerminalReleaseIds.has(sessionId)) {
          this.lateTerminalReleaseIds.delete(sessionId);
        } else {
          // Another identity generation arrived while this release was in
          // flight. Drain it in a fresh pass after unregistering this one.
          shouldContinue = true;
        }
      })
      .finally(() => {
        if (this.lateTerminalCleanupOperations.get(sessionId) === cleanup) {
          this.lateTerminalCleanupOperations.delete(sessionId);
        }
        if (shouldContinue) {
          this.scheduleLateTerminalRelease(sessionId);
        }
      });
    this.lateTerminalCleanupOperations.set(sessionId, cleanup);
    void cleanup.catch((error) => {
      this.logger?.warn(`[AcpAgentService] Unexpected late terminal cleanup failure for session ${sessionId}`, error);
    });
  }

  private requestSessionTerminalRelease(sessionId: string): number {
    let state = this.terminalReleaseStates.get(sessionId);
    if (!state) {
      state = { requestedGeneration: 0, completedGeneration: 0 };
      this.terminalReleaseStates.set(sessionId, state);
    }
    state.requestedGeneration = ++this.terminalReleaseGeneration;
    this.pendingTerminalReleaseIds.add(sessionId);
    if (this.terminalCleanupSnapshotTaken) {
      this.lateTerminalReleaseIds.add(sessionId);
      if (!this.stopPromise) {
        this.scheduleLateTerminalRelease(sessionId);
      }
    }
    return state.requestedGeneration;
  }

  /**
   * Drain all cleanup generations through `targetGeneration`. Requests for
   * the same string that arrive during an in-flight release form a later
   * generation and therefore trigger a follow-up release instead of being
   * mistaken for the already-retired session identity.
   */
  private async releaseSessionTerminalsOnce(sessionId: string, targetGeneration?: number): Promise<void> {
    let state = this.terminalReleaseStates.get(sessionId);
    if (!state) {
      const generation = this.requestSessionTerminalRelease(sessionId);
      state = this.terminalReleaseStates.get(sessionId)!;
      targetGeneration = targetGeneration ?? generation;
    }
    const target = targetGeneration ?? state.requestedGeneration;

    while (state.completedGeneration < target) {
      let inFlight = state.inFlight;
      if (!inFlight) {
        const throughGeneration = state.requestedGeneration;
        let release!: Promise<void>;
        release = Promise.resolve()
          .then(() => this.terminalHandler.releaseSessionTerminals(sessionId))
          .then(() => {
            state!.completedGeneration = Math.max(state!.completedGeneration, throughGeneration);
            if (state!.completedGeneration >= state!.requestedGeneration) {
              this.pendingTerminalReleaseIds.delete(sessionId);
              this.lateTerminalReleaseIds.delete(sessionId);
            }
          })
          .finally(() => {
            if (state!.inFlight?.promise === release) {
              state!.inFlight = undefined;
            }
            if (this.terminalReleaseOperations.get(sessionId) === release) {
              this.terminalReleaseOperations.delete(sessionId);
            }
            if (!state!.inFlight && state!.completedGeneration >= state!.requestedGeneration) {
              this.terminalReleaseStates.delete(sessionId);
            }
          });
        inFlight = { throughGeneration, promise: release };
        state.inFlight = inFlight;
        this.terminalReleaseOperations.set(sessionId, release);
      }
      await inFlight.promise;
    }
  }

  // -----------------------------------------------------------------------
  // dispose — clean up all resources
  // -----------------------------------------------------------------------

  dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.terminallyDisposed = true;
      this.disposePromise = Promise.resolve().then(() => this.doDispose());
    }
    return this.disposePromise;
  }

  private async doDispose(): Promise<void> {
    this.logger?.log('[AcpAgentService] dispose() — pool size=' + this.threadPool.length);
    try {
      await this.stopAgent();
    } finally {
      this._onThreadStatusChange.dispose();
      this.logger?.log('[AcpAgentService] dispose() — done');
    }
  }

  // -----------------------------------------------------------------------
  // Thread status change tracking
  // -----------------------------------------------------------------------

  /**
   * Register a persistent listener for thread status changes.
   * Fires onThreadStatusChange for every status transition, even outside sendMessage streams.
   */
  private registerThreadStatusListener(sessionId: string, thread: AcpThread): void {
    this.unregisterThreadStatusListener(sessionId);
    this.logger.log(`[AcpAgentService] registerThreadStatusListener: sessionId=${sessionId}`);
    const disposable = thread.onEvent((event: AcpThreadEvent) => {
      if (event.type === 'status_changed') {
        this.logger.log(`[AcpAgentService] thread status_changed: sessionId=${sessionId}, status=${event.status}`);
        this._onThreadStatusChange.fire({ sessionId, status: event.status });
      }
    });
    this.threadStatusDisposables.set(sessionId, disposable);
  }

  private unregisterThreadStatusListener(sessionId: string): void {
    const disposable = this.threadStatusDisposables.get(sessionId);
    if (disposable) {
      this.logger.log(`[AcpAgentService] unregisterThreadStatusListener: sessionId=${sessionId}`);
      disposable.dispose();
      this.threadStatusDisposables.delete(sessionId);
    }
  }

  // -----------------------------------------------------------------------
  // Internal helpers
  // -----------------------------------------------------------------------

  /**
   * Log pool status summary — call after key pool operations.
   */
  private logPoolStatus(context: string): void {
    const threadsInfo = this.threadPool.map((t) => ({
      id: t.threadId,
      status: t.getStatus(),
      sid: t.sessionId || '-',
      entries: t.getEntries().length,
    }));
    const activeCount = this.sessions.size;
    this.logger.log(
      `[AcpAgentService] pool(${context}) — threads:${this.threadPool.length}/${
        this.maxPoolSize
      }, active_sessions:${activeCount}, threads=[${threadsInfo
        .map((t) => `${t.id}(${t.status},sid=${t.sid},entries=${t.entries})`)
        .join(', ')}]`,
    );
  }

  private threadStatusToAgentStatus(status: string): AgentSessionStatus {
    switch (status) {
      case 'idle':
      case 'awaiting_prompt':
        return 'ready';
      case 'working':
        return 'running';
      case 'disconnected':
        return 'stopped';
      case 'errored':
        return 'error';
      default:
        return 'ready';
    }
  }

  private updateLastSessionInfo(
    sessionId: string,
    thread: AcpThread,
    modes: Array<{ id: string; name: string }>,
  ): void {
    this.lastSessionInfo = {
      sessionId,
      processId: thread.threadId,
      modes,
      status: 'ready',
    };
  }

  private retainSession(sessionId: string): void {
    this.sessionRefCounts.set(sessionId, (this.sessionRefCounts.get(sessionId) ?? 1) + 1);
  }

  private retainPendingSessionLoad(pending: PendingSessionLoad): void {
    pending.refCount += 1;
    if (this.sessions.get(pending.boundSessionId) === pending.thread) {
      this.sessionRefCounts.set(pending.boundSessionId, pending.refCount);
    }
  }

  private buildPromptBlocks(input: string, images?: string[]): Array<{ type: string; [key: string]: unknown }> {
    const blocks: Array<{ type: string; [key: string]: unknown }> = [];

    blocks.push({
      type: 'text',
      text: input,
    });

    if (images && images.length > 0) {
      for (const imageData of images) {
        const { mimeType, base64Data } = this.parseDataUrl(imageData);
        blocks.push({
          type: 'image',
          data: base64Data,
          mimeType,
        });
      }
    }

    return blocks;
  }

  private async withWebMcpCapabilityHint(
    input: string,
    includeHint: boolean,
    webMcpHintsEnabled = true,
  ): Promise<string> {
    if (!webMcpHintsEnabled || !includeHint) {
      return input;
    }
    return `${WEBMCP_CAPABILITY_HINT}\n\n${input}`;
  }

  private parseDataUrl(dataUrl: string): { mimeType: string; base64Data: string } {
    if (dataUrl.startsWith('data:')) {
      const matches = dataUrl.match(/^data:([^;]+);base64,(.+)$/);
      if (matches) {
        return { mimeType: matches[1], base64Data: matches[2] };
      }
    }
    return { mimeType: 'image/jpeg', base64Data: dataUrl };
  }
}
