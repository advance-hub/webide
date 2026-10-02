import { Emitter, IDisposable, MaybePromise } from '@opensumi/ide-core-node';

import { ExtensionHostProcessEpochLoss, ExtensionHostProcessLease, IExtensionHostManager, Output } from '../common';

import type { ForkOptions } from 'child_process';

export interface ExtensionHostProcessLeaseObserver {
  onExit?: (lease: ExtensionHostProcessLease, code: number, signal: string) => void;
  onMessage?: (lease: ExtensionHostProcessLease, message: unknown) => void;
  onOutput?: (lease: ExtensionHostProcessLease, output: Output) => void;
}

/**
 * A fork is deliberately split into registration and publication. Managers
 * buffer child events until the RuntimeHandle has attached the returned lease
 * and calls activate(). discard() only closes that event buffer; process
 * cleanup remains an explicit lease operation owned by the caller.
 */
export interface ExtensionHostProcessRegistration {
  readonly lease: ExtensionHostProcessLease;
  activate(): void;
  discard(): void;
}

export interface IExtensionHostProcessLeaseManager extends IExtensionHostManager {
  readonly processLeaseVersion: 1;
  /**
   * Whether PID-only kernel APIs execute in the same process namespace as the
   * managed child. Unknown is deliberately fail-safe for legacy/custom
   * managers: callers must not signal a PID in their own namespace.
   */
  readonly processControlLocation?: 'local' | 'remote' | 'unknown';
  /** 等待已经退役的本地进程释放名额；活跃会话不能因此被驱逐。 */
  waitForProcessCapacity?(timeoutMs: number): MaybePromise<void>;
  forkWithLease(
    modulePath: string,
    args: string[],
    options: ForkOptions,
    observer: ExtensionHostProcessLeaseObserver,
  ): MaybePromise<ExtensionHostProcessRegistration>;
  sendLease(lease: ExtensionHostProcessLease, message: string): MaybePromise<void>;
  isRunningLease(lease: ExtensionHostProcessLease): MaybePromise<boolean>;
  treeKillLease(lease: ExtensionHostProcessLease): MaybePromise<void>;
  killLease(lease: ExtensionHostProcessLease, signal?: string): MaybePromise<void>;
  isKilledLease(lease: ExtensionHostProcessLease): MaybePromise<boolean>;
  onOutputLease(
    lease: ExtensionHostProcessLease,
    listener: (lease: ExtensionHostProcessLease, output: Output) => void,
  ): MaybePromise<IDisposable>;
  onExitLease(
    lease: ExtensionHostProcessLease,
    listener: (lease: ExtensionHostProcessLease, code: number, signal: string) => void,
  ): MaybePromise<IDisposable>;
  onMessageLease(
    lease: ExtensionHostProcessLease,
    listener: (lease: ExtensionHostProcessLease, message: unknown) => void,
  ): MaybePromise<IDisposable>;
  disposeLease(lease: ExtensionHostProcessLease): MaybePromise<void>;
}

export type ExtensionHostProcessLeaseErrorReason = 'foreign' | 'stale' | 'identity-mismatch';

export class ExtensionHostProcessLeaseError extends Error {
  readonly code = 'EXTENSION_HOST_PROCESS_LEASE_INVALID';

  constructor(
    readonly operation: string,
    readonly reason: ExtensionHostProcessLeaseErrorReason,
  ) {
    super(`Cannot ${operation} Extension Host process: ${reason} lease`);
    this.name = 'ExtensionHostProcessLeaseError';
  }
}

export const ExtensionHostProcessPendingEventLimit = 1024;

export class ExtensionHostProcessRegistrationOverflowError extends Error {
  readonly code = 'EXTENSION_HOST_PROCESS_EVENT_BUFFER_OVERFLOW';

  constructor(readonly lease: ExtensionHostProcessLease) {
    super(
      `Extension Host process ${lease.managerEpoch}:${lease.leaseId} buffered more than ` +
        `${ExtensionHostProcessPendingEventLimit} events before activation`,
    );
    this.name = 'ExtensionHostProcessRegistrationOverflowError';
  }
}

let nextManagerEpoch = 1;

export function allocateExtensionHostProcessManagerEpoch(): number {
  if (!Number.isSafeInteger(nextManagerEpoch)) {
    throw new Error('Extension Host process manager epoch space exhausted');
  }
  return nextManagerEpoch++;
}

export function createExtensionHostProcessLease(
  managerEpoch: number,
  pid: number,
  leaseId: number,
): ExtensionHostProcessLease {
  return Object.freeze({ managerEpoch, pid, leaseId });
}

type BufferedProcessEvent =
  | { kind: 'exit'; code: number; signal: string }
  | { kind: 'message'; message: unknown }
  | { kind: 'output'; output: Output };

export class BufferedExtensionHostProcessRegistration implements ExtensionHostProcessRegistration {
  private state: 'pending' | 'active' | 'discarded' = 'pending';
  private pendingEvents: BufferedProcessEvent[] = [];
  private overflowError: ExtensionHostProcessRegistrationOverflowError | undefined;

  constructor(
    readonly lease: ExtensionHostProcessLease,
    private readonly observer: ExtensionHostProcessLeaseObserver,
  ) {}

  activate(): void {
    if (this.state !== 'pending') {
      return;
    }
    if (this.overflowError) {
      const error = this.overflowError;
      this.state = 'discarded';
      this.pendingEvents = [];
      this.overflowError = undefined;
      throw error;
    }
    this.state = 'active';
    let firstError: unknown;
    while (this.state === 'active' && this.pendingEvents.length > 0) {
      const event = this.pendingEvents.shift()!;
      try {
        this.deliver(event);
      } catch (error) {
        firstError ??= error;
      }
    }
    if (firstError) {
      throw firstError;
    }
  }

  discard(): void {
    if (this.state === 'discarded') {
      return;
    }
    this.state = 'discarded';
    this.pendingEvents = [];
    this.overflowError = undefined;
  }

  acceptMessage(message: unknown): void {
    this.accept({ kind: 'message', message });
  }

  acceptOutput(output: Output): void {
    this.accept({ kind: 'output', output });
  }

  acceptExit(code: number, signal: string): void {
    this.accept({ kind: 'exit', code, signal });
  }

  private accept(event: BufferedProcessEvent): void {
    if (this.state === 'discarded') {
      return;
    }
    if (this.state === 'pending') {
      if (this.overflowError) {
        return;
      }
      if (this.pendingEvents.length >= ExtensionHostProcessPendingEventLimit) {
        this.overflowError = new ExtensionHostProcessRegistrationOverflowError(this.lease);
        return;
      }
      this.pendingEvents.push(event);
      return;
    }
    this.deliver(event);
  }

  private deliver(event: BufferedProcessEvent): void {
    switch (event.kind) {
      case 'exit':
        this.observer.onExit?.(this.lease, event.code, event.signal);
        break;
      case 'message':
        this.observer.onMessage?.(this.lease, event.message);
        break;
      case 'output':
        this.observer.onOutput?.(this.lease, event.output);
        break;
    }
  }
}

interface LegacyProcessRecord {
  readonly lease: ExtensionHostProcessLease;
  readonly registration: BufferedExtensionHostProcessRegistration;
  state: 'active' | 'superseded' | 'released';
}

class LegacyExtensionHostProcessLeaseManager implements IExtensionHostProcessLeaseManager {
  readonly processLeaseVersion = 1 as const;
  readonly processControlLocation: 'local' | 'remote' | 'unknown';
  private readonly processEpochLostEmitter = new Emitter<ExtensionHostProcessEpochLoss>();
  readonly onDidLoseProcessEpoch = this.processEpochLostEmitter.event;
  private readonly managerEpoch = allocateExtensionHostProcessManagerEpoch();
  private nextLeaseId = 1;
  private readonly issuedLeases = new WeakSet<object>();
  private readonly recordsByLeaseId = new Map<number, LegacyProcessRecord>();
  private readonly currentRecordByPid = new Map<number, LegacyProcessRecord>();
  private processEpochGeneration = 0;

  private readonly managerEpochLossDisposable: IDisposable | undefined;

  constructor(private readonly manager: IExtensionHostManager) {
    const processControlLocation = (manager as Partial<IExtensionHostProcessLeaseManager>).processControlLocation;
    this.processControlLocation =
      processControlLocation === 'local' || processControlLocation === 'remote' ? processControlLocation : 'unknown';
    this.managerEpochLossDisposable = manager.onDidLoseProcessEpoch?.((loss) => {
      // Invalidate every PID alias before the service observes the transport
      // loss. Its retirement path must not forward an old lease into a new
      // proxy epoch that happens to reuse the same PID.
      this.processEpochGeneration += 1;
      this.invalidateAllRecords();
      this.processEpochLostEmitter.fire(loss);
    });
  }

  init(): MaybePromise<void> {
    return this.manager.init();
  }

  fork(modulePath: string, ...args: any[]): MaybePromise<number> {
    return this.manager.fork(modulePath, ...args);
  }

  async forkWithLease(
    modulePath: string,
    args: string[],
    options: ForkOptions,
    observer: ExtensionHostProcessLeaseObserver,
  ): Promise<ExtensionHostProcessRegistration> {
    const processEpochGeneration = this.processEpochGeneration;
    const pid = await this.manager.fork(modulePath, args, options);
    if (processEpochGeneration !== this.processEpochGeneration) {
      throw new ExtensionHostProcessLeaseError('complete fork', 'stale');
    }
    const lease = createExtensionHostProcessLease(this.managerEpoch, pid, this.nextLeaseId++);
    const registration = new BufferedExtensionHostProcessRegistration(lease, observer);
    const record: LegacyProcessRecord = { lease, registration, state: 'active' };
    const previous = this.currentRecordByPid.get(pid);
    if (previous?.state === 'active') {
      previous.state = 'superseded';
    }
    this.issuedLeases.add(lease);
    this.recordsByLeaseId.set(lease.leaseId, record);
    this.currentRecordByPid.set(pid, record);

    try {
      await Promise.all([
        Promise.resolve(
          this.manager.onMessage(pid, (message) => {
            if (this.isCurrent(record)) {
              registration.acceptMessage(message);
            }
          }),
        ),
        Promise.resolve(
          this.manager.onOutput(pid, (output) => {
            if (this.isCurrent(record)) {
              registration.acceptOutput(output);
            }
          }),
        ),
        Promise.resolve(
          this.manager.onExit(pid, (code, signal) => {
            try {
              if (this.isCurrent(record)) {
                registration.acceptExit(code, signal);
              }
            } finally {
              this.releaseRecord(record);
            }
          }),
        ),
      ]);
      if (processEpochGeneration !== this.processEpochGeneration || !this.isCurrent(record)) {
        throw new ExtensionHostProcessLeaseError('complete fork', 'stale');
      }
    } catch (error) {
      registration.discard();
      await this.disposeLease(lease);
      throw error;
    }
    return registration;
  }

  send(pid: number, message: string): MaybePromise<void> {
    return this.manager.send(pid, message);
  }

  sendLease(lease: ExtensionHostProcessLease, message: string): MaybePromise<void> {
    return this.manager.send(this.requireActiveRecord(lease, 'send').lease.pid, message);
  }

  isRunning(pid: number): MaybePromise<boolean> {
    return this.manager.isRunning(pid);
  }

  isRunningLease(lease: ExtensionHostProcessLease): MaybePromise<boolean> {
    const record = this.getIssuedRecord(lease, 'query');
    if (!record || !this.isCurrent(record)) {
      return false;
    }
    return this.manager.isRunning(record.lease.pid);
  }

  treeKill(pid: number): MaybePromise<void> {
    return this.manager.treeKill(pid);
  }

  treeKillLease(lease: ExtensionHostProcessLease): MaybePromise<void> {
    return this.manager.treeKill(this.requireActiveRecord(lease, 'tree-kill').lease.pid);
  }

  kill(pid: number, signal?: string): MaybePromise<void> {
    return this.manager.kill(pid, signal);
  }

  killLease(lease: ExtensionHostProcessLease, signal?: string): MaybePromise<void> {
    return this.manager.kill(this.requireActiveRecord(lease, 'kill').lease.pid, signal);
  }

  isKilled(pid: number): MaybePromise<boolean> {
    return this.manager.isKilled(pid);
  }

  isKilledLease(lease: ExtensionHostProcessLease): MaybePromise<boolean> {
    const record = this.getIssuedRecord(lease, 'query');
    if (!record || !this.isCurrent(record)) {
      return true;
    }
    return this.manager.isKilled(record.lease.pid);
  }

  findDebugPort(startPort: number, giveUpAfter: number, timeout: number): Promise<number> {
    return this.manager.findDebugPort(startPort, giveUpAfter, timeout);
  }

  onOutput(pid: number, listener: (output: Output) => void): MaybePromise<void> {
    return this.manager.onOutput(pid, listener);
  }

  onOutputLease(
    lease: ExtensionHostProcessLease,
    listener: (lease: ExtensionHostProcessLease, output: Output) => void,
  ): MaybePromise<IDisposable> {
    const record = this.requireActiveRecord(lease, 'observe output');
    return this.createGuardedListener(record, (enabled) =>
      this.manager.onOutput(record.lease.pid, (output) => {
        if (enabled()) {
          listener(record.lease, output);
        }
      }),
    );
  }

  onExit(pid: number, listener: (code: number, signal: string) => void): MaybePromise<void> {
    return this.manager.onExit(pid, listener);
  }

  onExitLease(
    lease: ExtensionHostProcessLease,
    listener: (lease: ExtensionHostProcessLease, code: number, signal: string) => void,
  ): MaybePromise<IDisposable> {
    const record = this.requireActiveRecord(lease, 'observe exit');
    return this.createGuardedListener(record, (enabled) =>
      this.manager.onExit(record.lease.pid, (code, signal) => {
        if (enabled()) {
          listener(record.lease, code, signal);
        }
      }),
    );
  }

  onMessage(pid: number, listener: (msg: any) => void): MaybePromise<void> {
    return this.manager.onMessage(pid, listener);
  }

  onMessageLease(
    lease: ExtensionHostProcessLease,
    listener: (lease: ExtensionHostProcessLease, message: unknown) => void,
  ): MaybePromise<IDisposable> {
    const record = this.requireActiveRecord(lease, 'observe message');
    return this.createGuardedListener(record, (enabled) =>
      this.manager.onMessage(record.lease.pid, (message) => {
        if (enabled()) {
          listener(record.lease, message);
        }
      }),
    );
  }

  disposeProcess(pid: number): MaybePromise<void> {
    return this.manager.disposeProcess(pid);
  }

  disposeLease(lease: ExtensionHostProcessLease): MaybePromise<void> {
    const record = this.getIssuedRecord(lease, 'dispose');
    record?.registration.discard();
    if (!record || !this.isCurrent(record)) {
      if (record) {
        this.releaseRecord(record);
      }
      return;
    }
    this.releaseRecord(record);
    return this.manager.disposeProcess(record.lease.pid);
  }

  async dispose(): Promise<void> {
    try {
      await this.manager.dispose();
    } finally {
      this.invalidateAllRecords();
      this.managerEpochLossDisposable?.dispose();
      this.processEpochLostEmitter.dispose();
    }
  }

  private async createGuardedListener(
    record: LegacyProcessRecord,
    register: (enabled: () => boolean) => MaybePromise<void>,
  ): Promise<IDisposable> {
    let enabled = true;
    await register(() => enabled && this.isCurrent(record));
    return {
      dispose: () => {
        enabled = false;
      },
    };
  }

  private getIssuedRecord(lease: ExtensionHostProcessLease, operation: string): LegacyProcessRecord | undefined {
    if (!lease || typeof lease !== 'object' || !this.issuedLeases.has(lease)) {
      throw new ExtensionHostProcessLeaseError(operation, 'foreign');
    }
    const record = this.recordsByLeaseId.get(lease.leaseId);
    if (
      lease.managerEpoch !== this.managerEpoch ||
      (record && (record.lease !== lease || record.lease.pid !== lease.pid || record.lease.leaseId !== lease.leaseId))
    ) {
      throw new ExtensionHostProcessLeaseError(operation, 'identity-mismatch');
    }
    return record;
  }

  private requireActiveRecord(lease: ExtensionHostProcessLease, operation: string): LegacyProcessRecord {
    const record = this.getIssuedRecord(lease, operation);
    if (!record || !this.isCurrent(record)) {
      throw new ExtensionHostProcessLeaseError(operation, 'stale');
    }
    return record;
  }

  private isCurrent(record: LegacyProcessRecord): boolean {
    return record.state === 'active' && this.currentRecordByPid.get(record.lease.pid) === record;
  }

  private releaseRecord(record: LegacyProcessRecord): void {
    if (record.state === 'released') {
      return;
    }
    record.state = 'released';
    this.recordsByLeaseId.delete(record.lease.leaseId);
    if (this.currentRecordByPid.get(record.lease.pid) === record) {
      this.currentRecordByPid.delete(record.lease.pid);
    }
  }

  private invalidateAllRecords(): void {
    for (const record of [...this.recordsByLeaseId.values()]) {
      record.registration.discard();
      this.releaseRecord(record);
    }
  }
}

export function isExtensionHostProcessLeaseManager(
  manager: IExtensionHostManager,
): manager is IExtensionHostProcessLeaseManager {
  const candidate = manager as Partial<IExtensionHostProcessLeaseManager>;
  return (
    candidate.processLeaseVersion === 1 &&
    typeof candidate.forkWithLease === 'function' &&
    typeof candidate.sendLease === 'function' &&
    typeof candidate.isRunningLease === 'function' &&
    typeof candidate.treeKillLease === 'function' &&
    typeof candidate.killLease === 'function' &&
    typeof candidate.isKilledLease === 'function' &&
    typeof candidate.onOutputLease === 'function' &&
    typeof candidate.onExitLease === 'function' &&
    typeof candidate.onMessageLease === 'function' &&
    typeof candidate.disposeLease === 'function'
  );
}

const legacyLeaseManagers = new WeakMap<IExtensionHostManager, IExtensionHostProcessLeaseManager>();

export function createExtensionHostProcessLeaseManager(
  manager: IExtensionHostManager,
): IExtensionHostProcessLeaseManager {
  if (isExtensionHostProcessLeaseManager(manager)) {
    return manager;
  }
  let adapter = legacyLeaseManagers.get(manager);
  if (!adapter) {
    adapter = new LegacyExtensionHostProcessLeaseManager(manager);
    legacyLeaseManagers.set(manager, adapter);
  }
  return adapter;
}
