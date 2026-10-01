import assert from 'assert';
import cp from 'child_process';

import isRunning from 'is-running';
import treeKill from 'tree-kill';

import { Injectable } from '@opensumi/di';
import { Event, IDisposable } from '@opensumi/ide-core-common';
import { findFreePort } from '@opensumi/ide-core-common/node/ports';

import { ExtensionHostProcessLease, Output, OutputType } from '../common';

import {
  BufferedExtensionHostProcessRegistration,
  ExtensionHostProcessLeaseError,
  ExtensionHostProcessLeaseObserver,
  ExtensionHostProcessRegistration,
  IExtensionHostProcessLeaseManager,
  allocateExtensionHostProcessManagerEpoch,
  createExtensionHostProcessLease,
} from './extension-host-process-manager';

export interface ExtensionHostProcessObserver {
  onExit?: (pid: number, code: number, signal: string) => void;
  onMessage?: (pid: number, message: unknown) => void;
  onOutput?: (pid: number, output: Output) => void;
}

interface ManagedExtensionHostProcessRecord {
  readonly lease: ExtensionHostProcessLease;
  readonly process: cp.ChildProcess;
  readonly registration: BufferedExtensionHostProcessRegistration;
  readonly disposables: IDisposable[];
  readonly exitListeners: Set<(code: number, signal: string) => void>;
  state: 'active' | 'superseded' | 'released';
}

@Injectable()
export class ExtensionHostManager implements IExtensionHostProcessLeaseManager {
  readonly processLeaseVersion = 1 as const;
  readonly processControlLocation = 'local' as const;

  private readonly managerEpoch = allocateExtensionHostProcessManagerEpoch();
  private nextLeaseId = 1;
  private readonly issuedLeases = new WeakSet<object>();

  /** Exact ownership source; PID maps below are legacy, non-owning indexes. */
  private readonly processRecords = new Map<number, ManagedExtensionHostProcessRecord>();
  private readonly currentProcessByPid = new Map<number, ManagedExtensionHostProcessRecord>();

  /** Legacy PID projections retained for source compatibility and diagnostics. */
  private readonly processMap = new Map<number, cp.ChildProcess>();
  private readonly processDisposables = new Map<number, IDisposable[]>();

  private lifecycleState: 'running' | 'draining' | 'disposed' = 'running';
  private forksInFlight = 0;
  private forksSettledBarrier:
    | {
        promise: Promise<void>;
        resolve: () => void;
      }
    | undefined;
  private disposePromise: Promise<void> | undefined;

  private readonly maxProcessCount = (() => {
    const configured = Number(process.env.MAX_MANAGED_EXTENSION_PROCESSES);
    return Number.isSafeInteger(configured) && configured > 0 ? configured : 3;
  })();

  constructor() {
    this.init();
  }

  init() {
    // Debug Auto Launch 插件 https://github.com/microsoft/vscode/blob/1.44.2/extensions/debug-auto-launch/src/extension.ts#L120
    // 依赖了 VSCODE_PID 来查找子进程
    process.env['VSCODE_PID'] = String(process.pid);
  }

  fork(modulePath: string, ...args: any[]): number {
    const registration = this.forkManaged(modulePath, args, {});
    registration.activate();
    return registration.lease.pid;
  }

  /** Legacy direct-manager fast path; new callers retain the registration. */
  forkWithLifecycle(
    modulePath: string,
    args: string[],
    options: cp.ForkOptions,
    observer: ExtensionHostProcessObserver,
  ): number {
    const registration = this.forkWithLease(modulePath, args, options, {
      onExit: (lease, code, signal) => observer.onExit?.(lease.pid, code, signal),
      onMessage: (lease, message) => observer.onMessage?.(lease.pid, message),
      onOutput: (lease, output) => observer.onOutput?.(lease.pid, output),
    });
    registration.activate();
    return registration.lease.pid;
  }

  forkWithLease(
    modulePath: string,
    args: string[],
    options: cp.ForkOptions,
    observer: ExtensionHostProcessLeaseObserver,
  ): ExtensionHostProcessRegistration {
    return this.forkManaged(modulePath, [args, options], observer);
  }

  private forkManaged(
    modulePath: string,
    args: any[],
    observer: ExtensionHostProcessLeaseObserver,
  ): ExtensionHostProcessRegistration {
    if (this.lifecycleState !== 'running') {
      const error = new Error('Extension host manager is draining and does not accept new processes');
      error.name = 'ExtensionHostManagerDrainingError';
      throw error;
    }
    if (this.processRecords.size + this.forksInFlight >= this.maxProcessCount) {
      throw new Error(`Managed extension child process limit (${this.maxProcessCount}) reached`);
    }

    this.beginFork();
    try {
      const extProcess = cp.fork(modulePath, ...args);
      assert(extProcess.pid, `fork ${modulePath} error`);

      const lease = createExtensionHostProcessLease(this.managerEpoch, extProcess.pid, this.nextLeaseId++);
      const registration = new BufferedExtensionHostProcessRegistration(lease, observer);
      const record: ManagedExtensionHostProcessRecord = {
        lease,
        process: extProcess,
        registration,
        disposables: [],
        exitListeners: new Set(),
        state: 'active',
      };
      const previous = this.currentProcessByPid.get(lease.pid);
      if (previous?.state === 'active') {
        previous.state = 'superseded';
      }
      this.issuedLeases.add(lease);
      this.processRecords.set(lease.leaseId, record);
      this.currentProcessByPid.set(lease.pid, record);
      this.processMap.set(lease.pid, extProcess);
      this.processDisposables.set(lease.pid, record.disposables);

      extProcess.once('exit', (code, signal) => {
        const exitCode = code ?? 0;
        const exitSignal = signal ?? '';
        const listeners = [...record.exitListeners];
        this.releaseRecord(record);

        let firstError: unknown;
        if (observer.onExit) {
          try {
            registration.acceptExit(exitCode, exitSignal);
          } catch (error) {
            firstError = error;
          }
        }
        for (const listener of listeners) {
          try {
            listener(exitCode, exitSignal);
          } catch (error) {
            firstError ??= error;
          }
        }
        if (firstError) {
          throw firstError;
        }
      });

      try {
        if (observer.onMessage) {
          this.onMessageLease(lease, (_lease, message) => registration.acceptMessage(message));
        }
        if (observer.onOutput) {
          this.onOutputLease(lease, (_lease, output) => registration.acceptOutput(output));
        }
      } catch (error) {
        registration.discard();
        this.disposeLease(lease);
        throw error;
      }
      return registration;
    } finally {
      this.endFork();
    }
  }

  private beginFork(): void {
    this.forksInFlight += 1;
    if (this.forksInFlight === 1) {
      let resolve: () => void = () => undefined;
      const promise = new Promise<void>((forksSettled) => {
        resolve = forksSettled;
      });
      this.forksSettledBarrier = { promise, resolve };
    }
  }

  private endFork(): void {
    this.forksInFlight -= 1;
    if (this.forksInFlight === 0) {
      const barrier = this.forksSettledBarrier;
      this.forksSettledBarrier = undefined;
      barrier?.resolve();
    }
  }

  private whenForksSettled(): Promise<void> {
    return this.forksSettledBarrier?.promise || Promise.resolve();
  }

  private trackRecordDisposable(record: ManagedExtensionHostProcessRecord, disposable: IDisposable): IDisposable {
    if (record.state === 'released') {
      disposable.dispose();
    } else {
      record.disposables.push(disposable);
    }
    return disposable;
  }

  private releaseRecord(record: ManagedExtensionHostProcessRecord): void {
    if (record.state === 'released') {
      return;
    }
    record.state = 'released';
    this.processRecords.delete(record.lease.leaseId);
    if (this.currentProcessByPid.get(record.lease.pid) === record) {
      this.currentProcessByPid.delete(record.lease.pid);
      if (this.processMap.get(record.lease.pid) === record.process) {
        this.processMap.delete(record.lease.pid);
      }
      if (this.processDisposables.get(record.lease.pid) === record.disposables) {
        this.processDisposables.delete(record.lease.pid);
      }
    }
    record.disposables.splice(0).forEach((disposable) => disposable.dispose());
    record.exitListeners.clear();
  }

  private getIssuedRecord(
    lease: ExtensionHostProcessLease,
    operation: string,
  ): ManagedExtensionHostProcessRecord | undefined {
    if (!lease || typeof lease !== 'object' || !this.issuedLeases.has(lease)) {
      throw new ExtensionHostProcessLeaseError(operation, 'foreign');
    }
    const record = this.processRecords.get(lease.leaseId);
    if (
      lease.managerEpoch !== this.managerEpoch ||
      (record && (record.lease !== lease || record.lease.pid !== lease.pid || record.lease.leaseId !== lease.leaseId))
    ) {
      throw new ExtensionHostProcessLeaseError(operation, 'identity-mismatch');
    }
    return record;
  }

  private requireActiveRecord(lease: ExtensionHostProcessLease, operation: string): ManagedExtensionHostProcessRecord {
    const record = this.getIssuedRecord(lease, operation);
    if (!record || record.state !== 'active' || this.currentProcessByPid.get(record.lease.pid) !== record) {
      throw new ExtensionHostProcessLeaseError(operation, 'stale');
    }
    return record;
  }

  private getLegacyRecord(pid: number): ManagedExtensionHostProcessRecord | undefined {
    const record = this.currentProcessByPid.get(pid);
    return record?.state === 'active' ? record : undefined;
  }

  send(pid: number, message: string): Promise<void> {
    const record = this.getLegacyRecord(pid);
    return record ? this.sendRecord(record, message) : Promise.reject(new Error(`Can't find process with pid ${pid}`));
  }

  sendLease(lease: ExtensionHostProcessLease, message: string): Promise<void> {
    return this.sendRecord(this.requireActiveRecord(lease, 'send'), message);
  }

  private sendRecord(record: ManagedExtensionHostProcessRecord, message: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      record.process.send(message, (error) => (error ? reject(error) : resolve()));
    });
  }

  isRunning(pid: number): boolean {
    return isRunning(pid);
  }

  isRunningLease(lease: ExtensionHostProcessLease): boolean {
    const record = this.getIssuedRecord(lease, 'query');
    if (!record || record.state !== 'active' || this.currentProcessByPid.get(record.lease.pid) !== record) {
      return false;
    }
    if (record.process.killed || (record.process.exitCode !== null && record.process.exitCode !== undefined)) {
      return false;
    }
    return this.isRunning(record.lease.pid);
  }

  treeKill(pid: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      treeKill(pid, (error) => (error ? reject(error) : resolve()));
    });
  }

  treeKillLease(lease: ExtensionHostProcessLease): Promise<void> {
    return this.treeKill(this.requireActiveRecord(lease, 'tree-kill').lease.pid);
  }

  kill(pid: number, signal?: NodeJS.Signals): void {
    this.getLegacyRecord(pid)?.process.kill(signal);
  }

  killLease(lease: ExtensionHostProcessLease, signal?: NodeJS.Signals): void {
    this.requireActiveRecord(lease, 'kill').process.kill(signal);
  }

  isKilled(pid: number): boolean {
    const record = this.getLegacyRecord(pid);
    return record ? record.process.killed : true;
  }

  isKilledLease(lease: ExtensionHostProcessLease): boolean {
    const record = this.getIssuedRecord(lease, 'query');
    if (!record || record.state !== 'active' || this.currentProcessByPid.get(record.lease.pid) !== record) {
      return true;
    }
    return record.process.killed;
  }

  findDebugPort(startPort: number, giveUpAfter: number, timeout: number): Promise<number> {
    return findFreePort(startPort, giveUpAfter, timeout);
  }

  onOutput(pid: number, listener: (output: Output) => void): void {
    const record = this.getLegacyRecord(pid);
    if (record) {
      this.onOutputRecord(record, listener);
    }
  }

  onOutputLease(
    lease: ExtensionHostProcessLease,
    listener: (lease: ExtensionHostProcessLease, output: Output) => void,
  ): IDisposable {
    const record = this.requireActiveRecord(lease, 'observe output');
    return this.onOutputRecord(record, (output) => listener(record.lease, output));
  }

  private onOutputRecord(record: ManagedExtensionHostProcessRecord, listener: (output: Output) => void): IDisposable {
    assert(record.process.stdout, 'ext process spawn failed');
    assert(record.process.stderr, 'ext process spawn failed');
    record.process.stdout.setEncoding('utf8');
    record.process.stderr.setEncoding('utf8');
    const onStdout = Event.fromNodeEventEmitter<string>(record.process.stdout, 'data');
    const onStderr = Event.fromNodeEventEmitter<string>(record.process.stderr, 'data');
    const onOutput = Event.any(
      Event.map(onStdout, (output) => ({ type: OutputType.STDOUT, data: `%c${output}`, format: [''] })),
      Event.map(onStderr, (output) => ({ type: OutputType.STDERR, data: `%c${output}`, format: ['color: red'] })),
    );
    const onDebouncedOutput = Event.debounce<Output>(
      onOutput,
      (result, output) =>
        result
          ? {
              data: result.data + output.data,
              format: [...result.format, ...output.format],
              type: [result.type, output.type].includes(OutputType.STDERR) ? OutputType.STDERR : OutputType.STDOUT,
            }
          : { data: output.data, format: output.format, type: output.type },
      100,
    );
    return this.trackRecordDisposable(record, onDebouncedOutput(listener));
  }

  onExit(pid: number, listener: (code: number, signal: string) => void): void {
    const record = this.getLegacyRecord(pid);
    if (record) {
      this.onExitRecord(record, listener);
    }
  }

  onExitLease(
    lease: ExtensionHostProcessLease,
    listener: (lease: ExtensionHostProcessLease, code: number, signal: string) => void,
  ): IDisposable {
    const record = this.requireActiveRecord(lease, 'observe exit');
    return this.onExitRecord(record, (code, signal) => listener(record.lease, code, signal));
  }

  private onExitRecord(
    record: ManagedExtensionHostProcessRecord,
    listener: (code: number, signal: string) => void,
  ): IDisposable {
    record.exitListeners.add(listener);
    return this.trackRecordDisposable(record, { dispose: () => record.exitListeners.delete(listener) });
  }

  onMessage(pid: number, listener: (message: any) => void): void {
    const record = this.getLegacyRecord(pid);
    if (record) {
      this.onMessageRecord(record, listener);
    }
  }

  onMessageLease(
    lease: ExtensionHostProcessLease,
    listener: (lease: ExtensionHostProcessLease, message: unknown) => void,
  ): IDisposable {
    const record = this.requireActiveRecord(lease, 'observe message');
    return this.onMessageRecord(record, (message) => listener(record.lease, message));
  }

  private onMessageRecord(record: ManagedExtensionHostProcessRecord, listener: (message: any) => void): IDisposable {
    record.process.on('message', listener);
    return this.trackRecordDisposable(record, { dispose: () => record.process.off('message', listener) });
  }

  disposeProcess(pid: number): void {
    const record = this.getLegacyRecord(pid);
    if (!record) {
      return;
    }
    try {
      if (this.isRunning(pid)) {
        record.process.kill();
      }
    } finally {
      this.releaseRecord(record);
    }
  }

  disposeLease(lease: ExtensionHostProcessLease): void {
    const record = this.getIssuedRecord(lease, 'dispose');
    record?.registration.discard();
    if (!record || record.state !== 'active' || this.currentProcessByPid.get(record.lease.pid) !== record) {
      if (record) {
        this.releaseRecord(record);
      }
      return;
    }
    try {
      if (!record.process.killed && (record.process.exitCode === null || record.process.exitCode === undefined)) {
        record.process.kill();
      }
    } finally {
      this.releaseRecord(record);
    }
  }

  dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.lifecycleState = 'draining';
      this.disposePromise = this.disposeOnce();
    }
    return this.disposePromise;
  }

  private async disposeOnce(): Promise<void> {
    try {
      await this.whenForksSettled();
      const records = [...this.processRecords.values()];
      await Promise.allSettled(
        records.map(async (record) => {
          if (record.state !== 'active' || this.currentProcessByPid.get(record.lease.pid) !== record) {
            if (
              record.state !== 'released' &&
              !record.process.killed &&
              (record.process.exitCode === null || record.process.exitCode === undefined)
            ) {
              record.process.kill();
            }
            return;
          }
          if (await this.isRunningLease(record.lease)) {
            await this.treeKillLease(record.lease);
          }
        }),
      );
      records.forEach((record) => {
        record.registration.discard();
        this.releaseRecord(record);
      });
    } finally {
      this.lifecycleState = 'disposed';
    }
  }
}
