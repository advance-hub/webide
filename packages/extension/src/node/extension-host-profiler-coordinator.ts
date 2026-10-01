import { Autowired, Injectable } from '@opensumi/di';
import { INodeLogger } from '@opensumi/ide-core-node';

import { IExtensionNodeService } from '../common';

import type {
  ExtensionHostRuntimeOwnedResource,
  ExtensionHostRuntimeOwnedResourceRetireReason,
  ExtensionHostRuntimeSnapshot,
} from './extension-host-runtime';
import type { Profile, ProfilingSession } from 'v8-inspect-profiler';

const PROFILER_RESOURCE_KIND = 'profiler';
const PROFILER_REPLACEMENT_ATTEMPTS = 3;
const PROFILER_CLEANUP_STOP_ATTEMPTS = 2;
const MAX_RETAINED_PROFILES = 128;

export interface ExtensionHostProfilerTarget {
  readonly clientId: string;
  readonly generation: number;
  readonly identity: object;
  readonly inspectPort: number;
  readonly processId: number;
  attach(resource: ExtensionHostRuntimeOwnedResource): boolean;
  confirmCurrent(): Promise<boolean>;
  detach(resource: ExtensionHostRuntimeOwnedResource): void;
}

export interface ExtensionHostProfilerTargetSource {
  acquire(clientId: string): Promise<ExtensionHostProfilerTarget | undefined>;
}

export const EXTENSION_HOST_PROFILER_TARGET_READER = Symbol('ExtensionHostProfilerTargetReader');

export interface ExtensionHostRuntimeProfilerTargetReader {
  [EXTENSION_HOST_PROFILER_TARGET_READER](clientId: string): Promise<ExtensionHostProfilerTarget | undefined>;
}

interface ExtensionHostRuntimeSnapshotReader {
  getRuntimeHandleSnapshot(clientId: string): ExtensionHostRuntimeSnapshot | undefined;
}

interface ProfilerGeneration {
  inspectPort: number;
  processId: number;
  runtimeGeneration?: number;
}

export interface ExtensionHostProfilerStartOptions {
  cleanupLeaseMs: number;
  startProfiler: (inspectPort: number) => Promise<ProfilingSession>;
}

export interface ExtensionHostProfilerProfile {
  profile: Profile;
  version: number;
}

export interface ExtensionHostProfilerStopResult {
  profile?: Profile;
  stopped: boolean;
}

interface ProfilerSessionHandle extends ProfilerGeneration {
  owner?: object;
  retired: boolean;
  session: ProfilingSession;
  stopped: boolean;
  stopPromise?: Promise<ExtensionHostProfilerStopResult>;
}

interface ProfilerStartAttempt {
  authority: object;
  cancelled: boolean;
  promise: Promise<void>;
}

interface StoredProfile extends ExtensionHostProfilerProfile {
  targetIdentity?: object;
}

type ProfilerSlotState = 'idle' | 'running' | 'starting' | 'stopping' | 'retired' | 'retiring' | 'uncertain';

type BoundedSettlement<T> =
  { status: 'fulfilled'; value: T } | { reason: unknown; status: 'rejected' } | { reason: Error; status: 'timed-out' };

function safeLogError(logger: INodeLogger, message: string, reason?: unknown): void {
  try {
    if (reason === undefined) {
      logger.error(message);
    } else {
      logger.error(message, reason);
    }
  } catch {
    // Injector teardown must not create a second rejection through logging.
  }
}

function createLeaseTimeoutError(operation: string): Error {
  const error = new Error(`Extension profiler lifecycle lease expired while ${operation}`);
  error.name = 'ExtensionProfilerLeaseTimeoutError';
  return error;
}

function assertLeaseActive(deadline: number, operation: string): void {
  if (deadline - Date.now() <= 0) {
    throw createLeaseTimeoutError(operation);
  }
}

function settleWithinLease<T>(
  promise: PromiseLike<T>,
  deadline: number,
  operation: string,
  logger: INodeLogger,
): Promise<BoundedSettlement<T>> {
  const observed = Promise.resolve(promise);
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    void observed.catch((reason) => {
      safeLogError(logger, `Late extension profiler operation failed after timeout: ${operation}.`, reason);
    });
    return Promise.resolve({ reason: createLeaseTimeoutError(operation), status: 'timed-out' });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: BoundedSettlement<T>) => {
      if (settled) {
        if (result.status === 'rejected') {
          safeLogError(logger, `Late extension profiler operation failed after timeout: ${operation}.`, result.reason);
        }
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ reason: createLeaseTimeoutError(operation), status: 'timed-out' }),
      remaining,
    );
    timer.unref?.();
    void observed.then(
      (value) => finish({ status: 'fulfilled', value }),
      (reason) => finish({ reason, status: 'rejected' }),
    );
  });
}

function isProfilerGeneration(value: ProfilerGeneration | undefined): value is ProfilerGeneration {
  return Boolean(
    value &&
    Number.isInteger(value.processId) &&
    value.processId > 0 &&
    Number.isInteger(value.inspectPort) &&
    value.inspectPort > 0,
  );
}

function isSameGeneration(left: ProfilerGeneration, right: ProfilerGeneration): boolean {
  if (left.runtimeGeneration !== undefined || right.runtimeGeneration !== undefined) {
    return (
      left.runtimeGeneration !== undefined &&
      right.runtimeGeneration !== undefined &&
      left.runtimeGeneration === right.runtimeGeneration &&
      left.processId === right.processId &&
      left.inspectPort === right.inspectPort
    );
  }
  return left.processId === right.processId && left.inspectPort === right.inspectPort;
}

async function readLegacyGeneration(
  extensionService: IExtensionNodeService,
  clientId: string,
  enableInspectPort: boolean,
): Promise<ProfilerGeneration | undefined> {
  if (enableInspectPort && !(await extensionService.tryEnableInspectPort(clientId))) {
    return;
  }

  const snapshotReader = extensionService as IExtensionNodeService & Partial<ExtensionHostRuntimeSnapshotReader>;
  if (typeof snapshotReader.getRuntimeHandleSnapshot === 'function') {
    const snapshot = snapshotReader.getRuntimeHandleSnapshot(clientId);
    const generation = snapshot
      ? {
          inspectPort: snapshot.inspectPort,
          processId: snapshot.processId,
          runtimeGeneration: snapshot.generation,
        }
      : undefined;
    if (snapshot?.phase === 'ready' && isProfilerGeneration(generation as ProfilerGeneration | undefined)) {
      return generation as ProfilerGeneration;
    }
    return;
  }

  const processId = await extensionService.getExtProcessId(clientId);
  if (typeof processId !== 'number') {
    return;
  }
  const inspectPort = await extensionService.getProcessInspectPort(clientId);
  const confirmedProcessId = await extensionService.getExtProcessId(clientId);
  const generation = { inspectPort, processId } as ProfilerGeneration;
  if (confirmedProcessId !== processId || !isProfilerGeneration(generation)) {
    return;
  }
  return generation;
}

@Injectable()
export class DefaultExtensionHostProfilerTargetSource implements ExtensionHostProfilerTargetSource {
  @Autowired(IExtensionNodeService)
  private readonly extensionService: IExtensionNodeService;

  private readonly legacyTargets = new Map<string, { generation: ProfilerGeneration; identity: object }>();

  async acquire(clientId: string): Promise<ExtensionHostProfilerTarget | undefined> {
    const exactReader = this.extensionService as IExtensionNodeService &
      Partial<ExtensionHostRuntimeProfilerTargetReader>;
    if (typeof exactReader[EXTENSION_HOST_PROFILER_TARGET_READER] === 'function') {
      return exactReader[EXTENSION_HOST_PROFILER_TARGET_READER]!(clientId);
    }

    const generation = await readLegacyGeneration(this.extensionService, clientId, true);
    if (!generation) {
      return;
    }
    const previous = this.legacyTargets.get(clientId);
    const identity = previous && isSameGeneration(previous.generation, generation) ? previous.identity : {};
    this.legacyTargets.set(clientId, { generation, identity });
    return {
      clientId,
      generation: generation.runtimeGeneration ?? 0,
      identity,
      inspectPort: generation.inspectPort,
      processId: generation.processId,
      attach: () => true,
      confirmCurrent: async () => {
        const confirmed = await readLegacyGeneration(this.extensionService, clientId, false);
        return Boolean(confirmed && isSameGeneration(generation, confirmed));
      },
      detach: () => undefined,
    };
  }
}

function stopProfilerSessionHandle(handle: ProfilerSessionHandle): Promise<ExtensionHostProfilerStopResult> {
  if (handle.stopped) {
    return Promise.resolve({ stopped: false });
  }
  if (handle.stopPromise) {
    return handle.stopPromise;
  }
  const stopPromise = Promise.resolve()
    .then(() => handle.session.stop())
    .then((result) => ({ profile: result?.profile, stopped: true }));
  handle.stopPromise = stopPromise;
  void stopPromise.then(
    () => {
      handle.stopped = true;
      if (handle.stopPromise === stopPromise) {
        handle.stopPromise = undefined;
      }
    },
    () => {
      if (handle.stopPromise === stopPromise) {
        handle.stopPromise = undefined;
      }
    },
  );
  return stopPromise;
}

class HostProfilerSlot implements ExtensionHostRuntimeOwnedResource {
  private authority: object | undefined;
  private detachedHandle: ProfilerSessionHandle | undefined;
  private startAttempt: ProfilerStartAttempt | undefined;
  private state: ProfilerSlotState = 'idle';
  private stopPromise: Promise<ExtensionHostProfilerStopResult> | undefined;
  private retirePromise: Promise<void> | undefined;

  constructor(
    private readonly coordinator: ExtensionHostProfilerCoordinator,
    readonly target: ExtensionHostProfilerTarget,
    private cleanupLeaseMs: number,
    private readonly legacyOrphan = false,
  ) {}

  matches(target: ExtensionHostProfilerTarget): boolean {
    return (
      this.target.identity === target.identity ||
      (this.legacyOrphan &&
        this.target.generation === target.generation &&
        this.target.processId === target.processId &&
        this.target.inspectPort === target.inspectPort)
    );
  }

  matchesSessionGeneration(handle: ProfilerSessionHandle): boolean {
    return this.matchesGeneration(handle);
  }

  get isLegacyCompatibilityOrphan(): boolean {
    return this.legacyOrphan;
  }

  get operationLeaseMs(): number {
    return this.cleanupLeaseMs;
  }

  adoptExistingSession(authority: object, handle: ProfilerSessionHandle): void {
    this.authority = authority;
    handle.owner = authority;
    this.state = 'running';
  }

  async start(
    authority: object,
    startProfiler: (inspectPort: number) => Promise<ProfilingSession>,
    operationDeadline: number,
    cleanupLeaseMs: number,
  ): Promise<void> {
    this.cleanupLeaseMs = Math.min(this.cleanupLeaseMs, cleanupLeaseMs);
    if (this.state === 'retired' || this.state === 'retiring') {
      throw new Error('Extension profiler target is retiring');
    }
    if (this.state === 'uncertain') {
      const error = new Error('Extension profiler stop outcome is uncertain for the current Host generation');
      error.name = 'ExtensionProfilerUncertainStateError';
      throw error;
    }

    this.authority = authority;
    if (this.state === 'running') {
      const handle = this.coordinator.getSession(this.target.clientId);
      if (handle) {
        handle.owner = authority;
      }
      return;
    }
    if (this.state === 'starting' && this.startAttempt) {
      this.startAttempt.authority = authority;
      this.startAttempt.cancelled = false;
      return this.waitForLiveStart(this.startAttempt, operationDeadline, authority);
    }
    if (this.state === 'stopping' && this.stopPromise) {
      const stopPromise = this.stopPromise;
      const stopResult = await settleWithinLease(
        stopPromise,
        operationDeadline,
        'waiting for a profiling stop before replacement start',
        this.coordinator.logger,
      );
      if (stopResult.status === 'timed-out') {
        if (this.authority === authority && this.stopPromise === stopPromise && this.coordinator.isCurrentSlot(this)) {
          this.state = 'uncertain';
        }
        throw stopResult.reason;
      }
      if (this.authority !== authority) {
        return;
      }
      if (this.currentState() === 'running') {
        return;
      }
      if (stopResult.status === 'rejected') {
        throw stopResult.reason;
      }
    }
    if (this.state !== 'idle') {
      throw new Error(`Extension profiler cannot start from ${this.state}`);
    }

    this.state = 'starting';
    const attempt = { authority, cancelled: false, promise: Promise.resolve() } as ProfilerStartAttempt;
    attempt.promise = this.runStart(attempt, startProfiler);
    this.startAttempt = attempt;
    return this.waitForLiveStart(attempt, operationDeadline, authority);
  }

  async stop(authority: object, operationDeadline: number): Promise<ExtensionHostProfilerStopResult> {
    if (this.authority !== authority) {
      return { stopped: false };
    }
    if (this.state === 'starting' && this.startAttempt) {
      const attempt = this.startAttempt;
      const startResult = await settleWithinLease(
        attempt.promise,
        operationDeadline,
        'waiting for a profiling start before stop',
        this.coordinator.logger,
      );
      if (startResult.status !== 'fulfilled') {
        if (
          startResult.status === 'timed-out' &&
          this.authority === authority &&
          this.startAttempt === attempt &&
          attempt.authority === authority
        ) {
          attempt.cancelled = true;
          this.state = 'uncertain';
        }
        throw startResult.reason;
      }
      if (this.authority !== authority) {
        return { stopped: false };
      }
    }
    if (this.state === 'stopping' && this.stopPromise) {
      return this.waitForLiveStop(this.stopPromise, operationDeadline, authority);
    }
    if (this.state === 'uncertain') {
      const error = new Error('Extension profiler operation outcome is uncertain for the current Host generation');
      error.name = 'ExtensionProfilerUncertainStateError';
      throw error;
    }
    if (this.state !== 'running') {
      return { stopped: false };
    }
    return this.waitForLiveStop(this.stopRunningSession(true), operationDeadline, authority);
  }

  async cleanupLegacyOrphan(authority: object, deadline: number): Promise<void> {
    if (!this.legacyOrphan) {
      throw new Error('Only a legacy profiler orphan can use compatibility cleanup');
    }
    this.authority = authority;
    const failures = await this.stopWithinDeadline(deadline, false);
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Legacy extension profiling session cleanup failed');
    }
    this.authority = undefined;
    this.state = 'retired';
    this.target.detach(this);
    this.coordinator.retireSlot(this);
  }

  async release(authority: object, cleanupLeaseMs = this.cleanupLeaseMs): Promise<void> {
    if (this.authority !== authority) {
      return;
    }
    this.cleanupLeaseMs = Math.min(this.cleanupLeaseMs, cleanupLeaseMs);
    this.authority = undefined;
    const deadline = Date.now() + this.cleanupLeaseMs;
    const failures: unknown[] = [];

    if (this.state === 'starting' && this.startAttempt) {
      const attempt = this.startAttempt;
      attempt.cancelled = true;
      const startResult = await settleWithinLease(
        attempt.promise,
        deadline,
        'waiting for an in-flight profiling start during connection cleanup',
        this.coordinator.logger,
      );
      if (this.authority !== undefined) {
        return;
      }
      if (startResult.status !== 'fulfilled') {
        failures.push(startResult.reason);
      }
      if (startResult.status === 'timed-out') {
        this.state = 'uncertain';
      }
    }

    if (this.state === 'uncertain' && this.detachedHandle) {
      const detachedStopped = await this.stopDetached(
        this.detachedHandle,
        'stopping a detached profiler during connection cleanup',
        deadline,
      );
      if (!detachedStopped) {
        failures.push(createLeaseTimeoutError('stopping a detached profiler during connection cleanup'));
      }
    }

    if (this.state === 'running' || this.state === 'stopping') {
      failures.push(...(await this.stopWithinDeadline(deadline, true, authority)));
    }

    if (failures.length > 0) {
      throw new AggregateError(failures, 'Extension profiling session cleanup failed');
    }
  }

  retire(deadline: number, _reason: ExtensionHostRuntimeOwnedResourceRetireReason): Promise<void> {
    if (this.retirePromise) {
      return this.retirePromise;
    }
    this.state = 'retiring';
    this.authority = undefined;
    if (this.startAttempt) {
      this.startAttempt.cancelled = true;
    }
    this.retirePromise = this.doRetire(deadline);
    return this.retirePromise;
  }

  private async runStart(
    attempt: ProfilerStartAttempt,
    startProfiler: (inspectPort: number) => Promise<ProfilingSession>,
  ): Promise<void> {
    try {
      const session = await startProfiler(this.target.inspectPort);
      const handle: ProfilerSessionHandle = {
        inspectPort: this.target.inspectPort,
        owner: this.authority,
        processId: this.target.processId,
        retired: false,
        runtimeGeneration: this.target.generation || undefined,
        session,
        stopped: false,
      };
      const confirmedCurrent = await this.target.confirmCurrent();
      const current =
        this.startAttempt === attempt && !attempt.cancelled && this.state === 'starting' && confirmedCurrent;
      if (!current) {
        const staleTarget =
          this.startAttempt === attempt && !attempt.cancelled && this.state === 'starting' && !confirmedCurrent;
        handle.retired = true;
        const detachedStopped = await this.stopDetached(handle, 'discarding a stale profiler start');
        if (this.startAttempt === attempt && ['starting', 'uncertain'].includes(this.state)) {
          this.state = detachedStopped ? 'idle' : 'uncertain';
        }
        if (staleTarget) {
          const error = new Error('Extension profiler target changed while starting');
          error.name = 'StaleExtensionHostProfilerTargetError';
          throw error;
        }
        return;
      }
      const concurrent = this.coordinator.getSession(this.target.clientId);
      if (concurrent && concurrent !== handle) {
        handle.retired = true;
        const detachedStopped = await this.stopDetached(handle, 'discarding a superseded profiler start');
        if (!detachedStopped) {
          this.state = 'uncertain';
          return;
        }
        concurrent.owner = this.authority;
        this.state = 'running';
        return;
      }
      this.coordinator.setSession(this.target.clientId, handle);
      this.state = 'running';
    } catch (error) {
      if (this.startAttempt === attempt && this.state === 'starting') {
        this.state = 'idle';
      } else if (
        this.startAttempt === attempt &&
        attempt.cancelled &&
        this.state === 'uncertain' &&
        !this.detachedHandle &&
        !this.coordinator.getSession(this.target.clientId) &&
        this.coordinator.isCurrentSlot(this)
      ) {
        this.state = 'idle';
      }
      throw error;
    } finally {
      if (this.startAttempt === attempt) {
        this.startAttempt = undefined;
      }
    }
  }

  private async stopRunningSession(preserveProfile: boolean): Promise<ExtensionHostProfilerStopResult> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    const handle = this.coordinator.getSession(this.target.clientId);
    if (!handle || handle.retired) {
      if (!['retired', 'retiring'].includes(this.state)) {
        this.state = 'idle';
      }
      return { stopped: false };
    }
    const retiring = ['retired', 'retiring'].includes(this.state);
    if (!retiring) {
      this.state = 'stopping';
    }
    const stopPromise = stopProfilerSessionHandle(handle);
    this.stopPromise = stopPromise;
    try {
      const result = await stopPromise;
      handle.retired = true;
      this.coordinator.deleteSession(this.target.clientId, handle);
      const canPublish = this.coordinator.isCurrentSlot(this) && !['retired', 'retiring'].includes(this.currentState());
      if (preserveProfile && result.profile && canPublish) {
        this.coordinator.publishProfile(this.target, result.profile);
      }
      if (!retiring && canPublish) {
        this.state = 'idle';
      }
      return result;
    } catch (error) {
      if (!retiring && this.coordinator.isCurrentSlot(this)) {
        this.state = 'running';
      }
      throw error;
    } finally {
      if (this.stopPromise === stopPromise) {
        this.stopPromise = undefined;
      }
    }
  }

  private async waitForLiveStart(attempt: ProfilerStartAttempt, deadline: number, authority: object): Promise<void> {
    const result = await settleWithinLease(
      attempt.promise,
      deadline,
      'starting an extension profiling session',
      this.coordinator.logger,
    );
    if (result.status === 'fulfilled') {
      const session = this.coordinator.getSession(this.target.clientId);
      if (
        this.state === 'running' &&
        this.coordinator.isCurrentSlot(this) &&
        session &&
        this.matchesGeneration(session)
      ) {
        return;
      }
      const error = new Error('Extension profiler start was superseded before a running session was published');
      error.name = 'ExtensionProfilerStartSupersededError';
      throw error;
    }
    if (
      result.status === 'timed-out' &&
      this.authority === authority &&
      this.startAttempt === attempt &&
      attempt.authority === authority
    ) {
      attempt.cancelled = true;
      this.state = 'uncertain';
    }
    throw result.reason;
  }

  private async waitForLiveStop(
    stopPromise: Promise<ExtensionHostProfilerStopResult>,
    deadline: number,
    authority: object,
  ): Promise<ExtensionHostProfilerStopResult> {
    const result = await settleWithinLease(
      stopPromise,
      deadline,
      'stopping an extension profiling session',
      this.coordinator.logger,
    );
    if (result.status === 'fulfilled') {
      return result.value;
    }
    if (
      result.status === 'timed-out' &&
      this.authority === authority &&
      this.stopPromise === stopPromise &&
      this.coordinator.isCurrentSlot(this)
    ) {
      this.state = 'uncertain';
    }
    throw result.reason;
  }

  private async stopWithinDeadline(
    deadline: number,
    preserveProfile: boolean,
    releasedAuthority?: object,
  ): Promise<unknown[]> {
    const failures: unknown[] = [];
    for (let attempt = 1; attempt <= PROFILER_CLEANUP_STOP_ATTEMPTS; attempt++) {
      if (releasedAuthority && this.authority !== undefined && this.authority !== releasedAuthority) {
        return [];
      }
      const stopResult = await settleWithinLease(
        this.stopRunningSession(preserveProfile),
        deadline,
        `stopping a profiling session during cleanup (attempt ${attempt})`,
        this.coordinator.logger,
      );
      if (stopResult.status === 'fulfilled') {
        return [];
      }
      failures.push(stopResult.reason);
      if (stopResult.status === 'timed-out') {
        if (this.state !== 'retiring') {
          this.state = 'uncertain';
        }
        break;
      }
    }
    return failures;
  }

  private async stopDetached(handle: ProfilerSessionHandle, operation: string, deadline?: number): Promise<boolean> {
    this.detachedHandle = handle;
    const stopPromise = stopProfilerSessionHandle(handle);
    const result = await settleWithinLease(
      stopPromise,
      deadline ?? Date.now() + this.cleanupLeaseMs,
      operation,
      this.coordinator.logger,
    );
    if (result.status === 'fulfilled') {
      this.clearDetachedHandle(handle);
      return true;
    }
    safeLogError(this.coordinator.logger, `Failed while ${operation}.`, result.reason);
    void stopPromise.then(
      () => this.clearDetachedHandle(handle),
      (reason) =>
        safeLogError(this.coordinator.logger, `Late detached profiler stop failed while ${operation}.`, reason),
    );
    return false;
  }

  private async doRetire(deadline: number): Promise<void> {
    const failures: unknown[] = [];
    try {
      if (this.startAttempt) {
        const startResult = await settleWithinLease(
          this.startAttempt.promise,
          deadline,
          'waiting for profiler start before Host retirement',
          this.coordinator.logger,
        );
        if (startResult.status !== 'fulfilled') {
          failures.push(startResult.reason);
        }
      }
      if (this.coordinator.getSession(this.target.clientId)) {
        failures.push(...(await this.stopWithinDeadline(deadline, false)));
      }
      if (this.detachedHandle) {
        const detachedStopped = await this.stopDetached(
          this.detachedHandle,
          'stopping a detached profiler during Host retirement',
          deadline,
        );
        if (!detachedStopped) {
          failures.push(createLeaseTimeoutError('stopping a detached profiler during Host retirement'));
        }
      }
    } finally {
      const handle = this.coordinator.getSession(this.target.clientId);
      if (handle && this.matchesGeneration(handle)) {
        handle.retired = true;
        this.coordinator.deleteSession(this.target.clientId, handle);
      }
      this.state = 'retired';
      this.target.detach(this);
      this.coordinator.retireSlot(this);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, 'Extension profiler retirement did not settle cleanly');
    }
  }

  private matchesGeneration(handle: ProfilerSessionHandle): boolean {
    return isSameGeneration(handle, {
      inspectPort: this.target.inspectPort,
      processId: this.target.processId,
      runtimeGeneration: this.target.generation || undefined,
    });
  }

  private currentState(): ProfilerSlotState {
    return this.state;
  }

  private clearDetachedHandle(handle: ProfilerSessionHandle): void {
    if (this.detachedHandle !== handle) {
      return;
    }
    this.detachedHandle = undefined;
    if (this.state === 'uncertain' && this.coordinator.isCurrentSlot(this)) {
      this.state = 'idle';
    }
  }
}

@Injectable()
export class ExtensionHostProfilerCoordinator {
  @Autowired(DefaultExtensionHostProfilerTargetSource)
  private readonly targetSource: ExtensionHostProfilerTargetSource;

  @Autowired(INodeLogger)
  readonly logger: INodeLogger;

  private readonly profiles = new Map<string, StoredProfile>();
  private readonly releasedAuthorities = new WeakSet<object>();
  private readonly sessions = new Map<string, ProfilerSessionHandle>();
  private readonly slots = new Map<string, HostProfilerSlot>();
  private nextProfileVersion = 1;

  async start(authority: object, clientId: string, options: ExtensionHostProfilerStartOptions): Promise<void> {
    const operationDeadline = Date.now() + Math.max(0, options.cleanupLeaseMs);
    for (let attempt = 1; attempt <= PROFILER_REPLACEMENT_ATTEMPTS; attempt++) {
      if (this.releasedAuthorities.has(authority)) {
        return;
      }
      const acquisition = await settleWithinLease(
        this.targetSource.acquire(clientId),
        operationDeadline,
        'acquiring an Extension Host profiler target',
        this.logger,
      );
      if (acquisition.status !== 'fulfilled') {
        throw acquisition.reason;
      }
      const target = acquisition.value;
      if (!target || this.releasedAuthorities.has(authority)) {
        return;
      }
      let slot = this.slots.get(clientId);
      const legacyHandle = this.sessions.get(clientId);
      if (
        !slot &&
        legacyHandle &&
        !legacyHandle.retired &&
        !isSameGeneration(legacyHandle, {
          inspectPort: target.inspectPort,
          processId: target.processId,
          runtimeGeneration: target.generation || undefined,
        })
      ) {
        slot = this.adoptOrphanSession(authority, clientId, options.cleanupLeaseMs);
      }
      if (slot && !slot.matches(target)) {
        if (slot.isLegacyCompatibilityOrphan) {
          await slot.cleanupLegacyOrphan(authority, operationDeadline);
        } else {
          await slot.retire(operationDeadline, 'runtime-retire').catch((reason) => {
            safeLogError(this.logger, 'Failed to retire the previous Extension Host profiler generation.', reason);
          });
        }
        assertLeaseActive(operationDeadline, 'replacing an Extension Host profiler generation');
        continue;
      }
      assertLeaseActive(operationDeadline, 'admitting an Extension Host profiler target');
      let createdSlot = false;
      if (!slot) {
        slot = new HostProfilerSlot(this, target, options.cleanupLeaseMs);
        if (!target.attach(slot)) {
          continue;
        }
        const concurrent = this.slots.get(clientId);
        if (concurrent) {
          target.detach(slot);
          slot = concurrent;
          if (!slot.matches(target)) {
            continue;
          }
        } else {
          this.slots.set(clientId, slot);
          createdSlot = true;
        }
      }
      if (createdSlot) {
        this.adoptLegacySession(slot, authority, clientId);
      }
      if (this.releasedAuthorities.has(authority)) {
        await slot.release(authority, options.cleanupLeaseMs);
        return;
      }
      assertLeaseActive(operationDeadline, 'starting an extension profiling session');
      try {
        await slot.start(authority, options.startProfiler, operationDeadline, options.cleanupLeaseMs);
        return;
      } catch (error) {
        if ((error as Error)?.name !== 'StaleExtensionHostProfilerTargetError') {
          throw error;
        }
        await slot.retire(operationDeadline, 'runtime-retire').catch(() => undefined);
        assertLeaseActive(operationDeadline, 'retrying a stale Extension Host profiler target');
      }
    }
    const error = new Error('Extension Host generation changed repeatedly while starting a profiling session');
    error.name = 'StaleExtensionHostProfilerTargetError';
    throw error;
  }

  async stop(authority: object, clientId: string): Promise<ExtensionHostProfilerStopResult> {
    const slot = this.slots.get(clientId) ?? this.adoptOrphanSession(authority, clientId);
    if (!slot) {
      return { stopped: false };
    }
    return slot.stop(authority, Date.now() + slot.operationLeaseMs);
  }

  async release(authority: object, clientId: string, cleanupLeaseMs = 5_000): Promise<void> {
    this.releasedAuthorities.add(authority);
    await (this.slots.get(clientId) ?? this.adoptOrphanSession(authority, clientId, cleanupLeaseMs))?.release(
      authority,
      cleanupLeaseMs,
    );
  }

  peekLastProfile(clientId: string): ExtensionHostProfilerProfile | undefined {
    const stored = this.profiles.get(clientId);
    return stored ? { profile: stored.profile, version: stored.version } : undefined;
  }

  consumeLastProfile(clientId: string, version: number): boolean {
    const stored = this.profiles.get(clientId);
    if (!stored || stored.version !== version) {
      return false;
    }
    this.profiles.delete(clientId);
    return true;
  }

  setLastProfile(clientId: string, profile: Profile | null): void {
    if (!profile) {
      this.profiles.delete(clientId);
      return;
    }
    this.storeProfile(clientId, { profile, version: this.nextProfileVersion++ });
  }

  getSessionMap(): Map<string, ProfilerSessionHandle> {
    return this.sessions;
  }

  getSession(clientId: string): ProfilerSessionHandle | undefined {
    return this.sessions.get(clientId);
  }

  setSession(clientId: string, handle: ProfilerSessionHandle): void {
    this.sessions.set(clientId, handle);
  }

  deleteSession(clientId: string, handle: ProfilerSessionHandle): void {
    if (this.sessions.get(clientId) === handle) {
      this.sessions.delete(clientId);
    }
  }

  publishProfile(target: ExtensionHostProfilerTarget, profile: Profile): void {
    this.storeProfile(target.clientId, {
      profile,
      targetIdentity: target.identity,
      version: this.nextProfileVersion++,
    });
  }

  retireSlot(slot: HostProfilerSlot): void {
    if (this.slots.get(slot.target.clientId) === slot) {
      this.slots.delete(slot.target.clientId);
    }
  }

  isCurrentSlot(slot: HostProfilerSlot): boolean {
    return this.slots.get(slot.target.clientId) === slot;
  }

  private adoptLegacySession(slot: HostProfilerSlot, authority: object, clientId: string): void {
    const handle = this.sessions.get(clientId);
    if (handle && !handle.retired) {
      if (!slot.matchesSessionGeneration(handle)) {
        slot.target.detach(slot);
        if (this.slots.get(clientId) === slot) {
          this.slots.delete(clientId);
        }
        const error = new Error('Legacy extension profiler session belongs to a different Host generation');
        error.name = 'StaleExtensionHostProfilerSessionError';
        throw error;
      }
      slot.adoptExistingSession(authority, handle);
    }
  }

  private storeProfile(clientId: string, profile: StoredProfile): void {
    // Refresh insertion order so the bounded map evicts the least recently
    // published client result. A completed profile survives Runtime retirement
    // until an exact-version save consumes it, a newer profile replaces it, or
    // this process-wide safety bound is reached.
    this.profiles.delete(clientId);
    this.profiles.set(clientId, profile);
    while (this.profiles.size > MAX_RETAINED_PROFILES) {
      const oldestClientId = this.profiles.keys().next().value as string | undefined;
      if (oldestClientId === undefined) {
        break;
      }
      this.profiles.delete(oldestClientId);
    }
  }

  private adoptOrphanSession(
    authority: object,
    clientId: string,
    cleanupLeaseMs = 5_000,
  ): HostProfilerSlot | undefined {
    const handle = this.sessions.get(clientId);
    if (!handle || handle.retired) {
      return;
    }
    const identity = handle as object;
    const target: ExtensionHostProfilerTarget = {
      clientId,
      generation: handle.runtimeGeneration ?? 0,
      identity,
      inspectPort: handle.inspectPort,
      processId: handle.processId,
      attach: () => true,
      confirmCurrent: async () => this.sessions.get(clientId) === handle,
      detach: () => undefined,
    };
    const slot = new HostProfilerSlot(this, target, cleanupLeaseMs, true);
    slot.adoptExistingSession(authority, handle);
    this.slots.set(clientId, slot);
    return slot;
  }
}
