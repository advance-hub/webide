import net from 'net';

import { WSServerChannel } from '@opensumi/ide-connection';
import {
  Deferred,
  DisposableStore,
  ExtensionHostRuntimePhase,
  IDisposable,
  INodeLogger,
  MaybePromise,
} from '@opensumi/ide-core-node';

import { ExtensionHostProcessLease } from '../common';

import { ExtensionHostProcessRegistration, IExtensionHostProcessLeaseManager } from './extension-host-process-manager';

export interface ExtensionHostRuntimeSnapshot {
  clientId: string;
  generation: number;
  phase: ExtensionHostRuntimePhase;
  processId?: number;
  inspectPort?: number;
  hasConnection: boolean;
  hasMainThreadBridge: boolean;
}

export interface RecordedExtensionActivationDiagnostic {
  extensionId: string;
  activationCount: number;
  failureCount: number;
  maxActivationDurationMs: number;
  maxModuleCount: number;
  maxSubscriptionCount: number;
  maxObservedHeapUsedBytes: number;
  maxObservedRssBytes: number;
  maxPositiveHeapUsedDeltaBytes: number;
  maxPositiveRssDeltaBytes: number;
}

export interface ExtensionHostRuntimeStopOptions {
  gracefulTimeoutMs: number;
  killProcess: boolean;
}

export interface ExtensionHostRuntimeStopReport {
  hadProcess: boolean;
  processId?: number;
}

export type ExtensionHostRuntimeOwnedResourceRetireReason = 'root-dispose' | 'runtime-retire';

/**
 * A resource whose lifetime is bounded by one exact Extension Host generation.
 *
 * The resource must close admission synchronously when `retire` is called and
 * settle cleanup within the supplied absolute deadline. Runtime shutdown will
 * continue after the deadline so an auxiliary resource cannot strand the Host.
 */
export interface ExtensionHostRuntimeOwnedResource {
  retire(deadline: number, reason: ExtensionHostRuntimeOwnedResourceRetireReason): Promise<void>;
}

export interface ExtensionHostSocketConnection {
  destroy(): void;
  dispose(): void;
  onMessage(listener: (data: Uint8Array) => void): IDisposable;
  onceClose(listener: (code?: number, reason?: string) => void): IDisposable;
  send(data: Uint8Array): void;
}

type RuntimeOperationSettlement<T> =
  | { status: 'fulfilled'; value: T }
  | { reason: unknown; status: 'rejected' }
  | { pending?: Promise<T>; reason: Error; status: 'timed-out' };

function createRuntimeError(
  runtime: ExtensionHostRuntimeHandle,
  message: string,
  name = 'ExtensionHostRuntimeError',
): Error {
  const error = new Error(`Extension Host ${runtime.clientId}#${runtime.generation} ${message}`);
  error.name = name;
  return error;
}

function waitForServerClose(
  server: net.Server,
  logger: INodeLogger,
  identity: string,
  timeoutMs: number,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      logger.warn(`Timed out closing Extension Host IPC server for ${identity}`);
      (server as net.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
      finish();
    }, timeoutMs);
    timer.unref?.();
    const finish = () => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    try {
      server.close((error) => {
        if (error) {
          logger.warn(`Close Extension Host IPC server failed for ${identity}`, error);
        }
        finish();
      });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      if (code !== 'ERR_SERVER_NOT_RUNNING') {
        logger.warn(`Close Extension Host IPC server failed for ${identity}`, error);
      }
      finish();
    }
  });
}

/**
 * Owns every resource whose lifetime is exactly one Extension Host generation.
 *
 * Browser connections and RPC facades intentionally do not live here: a browser
 * connection may be replaced while this process is retained during the
 * disconnect grace period. Every asynchronous callback must capture this object
 * and must never recover generation resources through a mutable clientId map.
 */
export class ExtensionHostRuntimeHandle {
  readonly childReady = new Deferred<void>();
  readonly connectionReady = new Deferred<void>();
  readonly finished = new Deferred<void>();
  readonly activationDiagnostics = new Map<string, RecordedExtensionActivationDiagnostic>();

  private _phase: ExtensionHostRuntimePhase = 'created';
  private _processLease: ExtensionHostProcessLease | undefined;
  private _inspectPort: number | undefined;
  private _listenOptions: net.ListenOptions | undefined;
  private _server: net.Server | undefined;
  private _connection: ExtensionHostSocketConnection | undefined;
  private _bridge: DisposableStore | undefined;
  private readonly ownedResources = new Map<string, ExtensionHostRuntimeOwnedResource>();
  private childReadySettled = false;
  private connectionReadySettled = false;
  private finishSettled = false;
  private stopPromise: Promise<ExtensionHostRuntimeStopReport> | undefined;

  constructor(
    readonly clientId: string,
    readonly generation: number,
    private readonly extensionHostManager: IExtensionHostProcessLeaseManager,
    private readonly logger: INodeLogger,
  ) {
    // A terminal transition may happen before a consumer starts waiting. Keep
    // the Deferred rejections observed while preserving rejection for callers.
    void this.childReady.promise.catch(() => undefined);
    void this.connectionReady.promise.catch(() => undefined);
    void this.finished.promise.catch(() => undefined);
  }

  get phase(): ExtensionHostRuntimePhase {
    return this._phase;
  }

  get processId(): number | undefined {
    return this._processLease?.pid;
  }

  get processLease(): ExtensionHostProcessLease | undefined {
    return this._processLease;
  }

  get inspectPort(): number | undefined {
    return this._inspectPort;
  }

  get listenOptions(): net.ListenOptions | undefined {
    return this._listenOptions;
  }

  get connection(): ExtensionHostSocketConnection | undefined {
    return this._connection;
  }

  get isTerminal(): boolean {
    return ['stopped', 'failed', 'crashed'].includes(this._phase);
  }

  get isStopping(): boolean {
    return this._phase === 'stopping';
  }

  get canPublish(): boolean {
    return !this.isTerminal && !this.isStopping;
  }

  setListenOptions(options: net.ListenOptions): void {
    if (this._listenOptions) {
      return;
    }
    this._listenOptions = options;
  }

  attachServer(server: net.Server): boolean {
    if (!this.canPublish || this._server) {
      return false;
    }
    this._server = server;
    this._phase = 'listening';
    return true;
  }

  attachConnection(connection: ExtensionHostSocketConnection): boolean {
    if (!this.canPublish || this._connection) {
      connection.dispose();
      connection.destroy();
      return false;
    }
    this._connection = connection;
    this.connectionReadySettled = true;
    this.connectionReady.resolve();
    return true;
  }

  attachProcess(registration: ExtensionHostProcessRegistration): boolean {
    if (!this.canPublish || this._processLease !== undefined) {
      registration.discard();
      return false;
    }
    this._processLease = registration.lease;
    this._phase = 'starting';
    registration.activate();
    return true;
  }

  setInspectPort(processLease: ExtensionHostProcessLease, inspectPort: number): boolean {
    if (!this.matchesProcess(processLease) || !this.canPublish) {
      return false;
    }
    this._inspectPort = inspectPort;
    return true;
  }

  markChildReady(processLease: ExtensionHostProcessLease): boolean {
    if (!this.matchesProcess(processLease) || !this.canPublish || this.childReadySettled) {
      return false;
    }
    this.childReadySettled = true;
    this.childReady.resolve();
    return true;
  }

  markReady(): boolean {
    if (!this.canPublish || !this.childReadySettled || !this.connectionReadySettled) {
      return false;
    }
    this._phase = 'ready';
    return true;
  }

  markFinished(processLease: ExtensionHostProcessLease): boolean {
    if (!this.matchesProcess(processLease) || this.finishSettled) {
      return false;
    }
    this.finishSettled = true;
    this.finished.resolve();
    return true;
  }

  markCrashed(processLease: ExtensionHostProcessLease, reason?: unknown): boolean {
    if (!this.matchesProcess(processLease) || this.isStopping || this.isTerminal) {
      return false;
    }
    this._phase = 'crashed';
    this.rejectPending(reason ?? createRuntimeError(this, 'crashed during startup'));
    return true;
  }

  markFailed(reason: unknown): void {
    if (this.isStopping || this.isTerminal) {
      return;
    }
    this._phase = 'failed';
    this.rejectPending(reason);
  }

  async whenReady(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all([this.childReady.promise, this.connectionReady.promise]).then(() => undefined),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(
              createRuntimeError(this, `startup timed out after ${timeoutMs} ms`, 'ExtensionHostStartupTimeoutError'),
            );
          }, timeoutMs);
          timer.unref?.();
        }),
      ]);

      if (this.isStopping || this.isTerminal) {
        throw createRuntimeError(this, `cannot become ready from ${this._phase}`);
      }
      if (!this._processLease || !(await this.extensionHostManager.isRunningLease(this._processLease))) {
        throw createRuntimeError(this, 'process exited before completing startup');
      }
      if (!this.markReady()) {
        throw createRuntimeError(this, `cannot become ready from ${this._phase}`);
      }
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  replaceMainThreadBridge(channel: WSServerChannel): boolean {
    const connection = this._connection;
    if (!connection || !this.canPublish) {
      return false;
    }

    this.detachMainThreadBridge();
    const bridge = new DisposableStore();
    let released = false;
    const release = () => {
      if (released) {
        return;
      }
      released = true;
      if (this._bridge === bridge) {
        this._bridge = undefined;
      }
      bridge.dispose();
    };

    bridge.add(connection.onMessage((data) => channel.sendBinary(data)));
    bridge.add(channel.onBinary((data) => connection.send(data)));
    bridge.add(connection.onceClose(release));
    bridge.add(channel.onceClose(release));
    this._bridge = bridge;
    return true;
  }

  detachMainThreadBridge(): void {
    const bridge = this._bridge;
    this._bridge = undefined;
    bridge?.dispose();
  }

  attachOwnedResource(kind: string, resource: ExtensionHostRuntimeOwnedResource): boolean {
    if (!kind || !this.canPublish || this.ownedResources.has(kind)) {
      return false;
    }
    this.ownedResources.set(kind, resource);
    return true;
  }

  detachOwnedResource(kind: string, resource: ExtensionHostRuntimeOwnedResource): boolean {
    if (this.ownedResources.get(kind) !== resource) {
      return false;
    }
    this.ownedResources.delete(kind);
    return true;
  }

  matchesProcess(processLease: ExtensionHostProcessLease): boolean {
    return this._processLease === processLease;
  }

  isProcessRunning(): Promise<boolean> {
    const processLease = this._processLease;
    return Promise.resolve(processLease ? this.extensionHostManager.isRunningLease(processLease) : false);
  }

  killProcess(signal?: string): Promise<void> {
    const processLease = this._processLease;
    if (!processLease) {
      return Promise.resolve();
    }
    return Promise.resolve(this.extensionHostManager.killLease(processLease, signal));
  }

  snapshot(): ExtensionHostRuntimeSnapshot {
    return {
      clientId: this.clientId,
      generation: this.generation,
      phase: this._phase,
      ...(this._processLease === undefined ? {} : { processId: this._processLease.pid }),
      ...(this._inspectPort === undefined ? {} : { inspectPort: this._inspectPort }),
      hasConnection: Boolean(this._connection),
      hasMainThreadBridge: Boolean(this._bridge),
    };
  }

  stop(options: ExtensionHostRuntimeStopOptions): Promise<ExtensionHostRuntimeStopReport> {
    if (this.stopPromise) {
      return this.stopPromise;
    }
    this.stopPromise = this.doStop(options);
    return this.stopPromise;
  }

  private async doStop(options: ExtensionHostRuntimeStopOptions): Promise<ExtensionHostRuntimeStopReport> {
    const processLease = this._processLease;
    const processId = processLease?.pid;
    const hadProcess = processLease !== undefined;
    const shutdownDeadline = Date.now() + options.gracefulTimeoutMs;
    this._phase = 'stopping';
    await this.retireOwnedResources(shutdownDeadline, 'runtime-retire');
    this.detachMainThreadBridge();
    this.rejectStartup(createRuntimeError(this, 'was stopped'));

    if (processLease) {
      const running = await this.settleManagerOperation(
        () => this.extensionHostManager.isRunningLease(processLease),
        shutdownDeadline,
        'checking whether the process is running for graceful shutdown',
      );
      if (running.status === 'fulfilled' && running.value) {
        const close = await this.settleManagerOperation(
          () => this.extensionHostManager.sendLease(processLease, 'close'),
          shutdownDeadline,
          'sending graceful process shutdown',
        );
        if (close.status === 'fulfilled' && !this.finishSettled) {
          await this.waitForFinish(Math.max(0, shutdownDeadline - Date.now()));
        }
      }
    }

    this.detachMainThreadBridge();
    const connection = this._connection;
    this._connection = undefined;
    if (connection) {
      try {
        connection.dispose();
        connection.destroy();
      } catch (error) {
        this.logger.warn(`Close Extension Host connection failed for ${this.identity}`, error);
      }
    }

    const server = this._server;
    this._server = undefined;
    if (server) {
      // net.Server.close() settles only after accepted sockets close, so the
      // generation-owned connection must be destroyed before awaiting it.
      await waitForServerClose(server, this.logger, this.identity, Math.max(0, shutdownDeadline - Date.now()));
    }

    if (processLease) {
      let deferredLeaseDisposal: Promise<void> | undefined;
      if (options.killProcess) {
        const forceRunning = await this.settleManagerOperation(
          () => this.extensionHostManager.isRunningLease(processLease),
          shutdownDeadline,
          'checking whether the process is running before force-stop',
          true,
        );
        if (forceRunning.status !== 'fulfilled' || forceRunning.value) {
          const forceStop = await this.settleManagerOperation(
            () => this.extensionHostManager.treeKillLease(processLease),
            shutdownDeadline,
            'force-stopping the process tree',
            true,
          );
          if (forceStop.status === 'timed-out' && forceStop.pending) {
            deferredLeaseDisposal = forceStop.pending;
          }
        }
      }
      if (deferredLeaseDisposal) {
        this.deferLeaseDisposalUntilTreeKillSettles(processLease, deferredLeaseDisposal);
      } else {
        await this.settleManagerOperation(
          () => this.extensionHostManager.disposeLease(processLease),
          shutdownDeadline,
          'releasing the process lease',
          true,
        );
      }
    }

    if (!this.finishSettled) {
      this.finishSettled = true;
      this.finished.reject(createRuntimeError(this, 'stopped before reporting finish'));
    }
    this._phase = 'stopped';
    return { hadProcess, ...(processId === undefined ? {} : { processId }) };
  }

  private async retireOwnedResources(
    deadline: number,
    reason: ExtensionHostRuntimeOwnedResourceRetireReason,
  ): Promise<void> {
    const resources = Array.from(this.ownedResources.entries());
    this.ownedResources.clear();
    const results = await Promise.allSettled(
      resources.map(async ([kind, resource]) => {
        const retirement = Promise.resolve().then(() => resource.retire(deadline, reason));
        void retirement.catch(() => undefined);
        const remaining = Math.max(0, deadline - Date.now());
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            retirement,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => {
                reject(new Error(`Timed out retiring Extension Host owned resource ${kind}`));
              }, remaining);
              timer.unref?.();
            }),
          ]);
        } finally {
          if (timer) {
            clearTimeout(timer);
          }
        }
      }),
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        this.logger.warn(
          `Retire Extension Host owned resource ${resources[index][0]} failed for ${this.identity}`,
          result.reason,
        );
      }
    });
  }

  private async waitForFinish(timeoutMs: number): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.finished.promise.catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  private async settleManagerOperation<T>(
    operation: () => MaybePromise<T>,
    deadline: number,
    description: string,
    initiateAfterDeadline = false,
  ): Promise<RuntimeOperationSettlement<T>> {
    const remainingBeforeStart = deadline - Date.now();
    if (remainingBeforeStart <= 0 && !initiateAfterDeadline) {
      const reason = createRuntimeError(this, `shutdown deadline expired before ${description}`);
      this.logger.warn(reason.message);
      return { reason, status: 'timed-out' };
    }

    let observed: Promise<T>;
    try {
      const operationResult = operation();
      if (
        operationResult === null ||
        operationResult === undefined ||
        (typeof operationResult !== 'object' && typeof operationResult !== 'function') ||
        typeof (operationResult as PromiseLike<T>).then !== 'function'
      ) {
        return { status: 'fulfilled', value: operationResult as T };
      }
      observed = Promise.resolve(operationResult);
    } catch (reason) {
      this.logger.warn(`Extension Host manager failed while ${description} for ${this.identity}`, reason);
      return { reason, status: 'rejected' };
    }
    void observed.catch(() => undefined);

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      void observed.catch((reason) =>
        this.logger.warn(`Late Extension Host manager failure while ${description} for ${this.identity}`, reason),
      );
      const reason = createRuntimeError(this, `shutdown deadline expired while ${description}`);
      this.logger.warn(reason.message);
      return { pending: observed, reason, status: 'timed-out' };
    }

    return new Promise((resolve) => {
      let settled = false;
      const finish = (result: RuntimeOperationSettlement<T>) => {
        if (settled) {
          if (result.status === 'rejected') {
            this.logger.warn(
              `Late Extension Host manager failure while ${description} for ${this.identity}`,
              result.reason,
            );
          }
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (result.status === 'rejected') {
          this.logger.warn(`Extension Host manager failed while ${description} for ${this.identity}`, result.reason);
        }
        resolve(result);
      };
      const timer = setTimeout(() => {
        const reason = createRuntimeError(this, `shutdown deadline expired while ${description}`);
        this.logger.warn(reason.message);
        finish({
          pending: observed,
          reason,
          status: 'timed-out',
        });
      }, remaining);
      timer.unref?.();
      void observed.then(
        (value) => finish({ status: 'fulfilled', value }),
        (reason) => finish({ reason, status: 'rejected' }),
      );
    });
  }

  private deferLeaseDisposalUntilTreeKillSettles(
    processLease: ExtensionHostProcessLease,
    treeKill: Promise<void>,
  ): void {
    const dispose = () => {
      try {
        const disposal = this.extensionHostManager.disposeLease(processLease);
        void Promise.resolve(disposal).catch((reason) => {
          this.logger.warn(`Deferred process lease release failed for ${this.identity}`, reason);
        });
      } catch (reason) {
        this.logger.warn(`Deferred process lease release failed for ${this.identity}`, reason);
      }
    };
    // Do not release the exact lease record while a manager tree-kill is still
    // operating on its raw PID. Stop may return at the absolute deadline, but
    // record disposal remains serialized after either late outcome.
    void treeKill.then(dispose, dispose);
  }

  private rejectPending(reason: unknown): void {
    this.rejectStartup(reason);
    if (!this.finishSettled) {
      this.finishSettled = true;
      this.finished.reject(reason);
    }
  }

  private rejectStartup(reason: unknown): void {
    if (!this.childReadySettled) {
      this.childReadySettled = true;
      this.childReady.reject(reason);
    }
    if (!this.connectionReadySettled) {
      this.connectionReadySettled = true;
      this.connectionReady.reject(reason);
    }
  }

  private get identity(): string {
    return `${this.clientId}#${this.generation}`;
  }
}
