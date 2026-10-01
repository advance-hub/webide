import net from 'net';

import { Autowired, Injectable, Optional } from '@opensumi/di';
import { NetSocketConnection, SumiConnectionMultiplexer } from '@opensumi/ide-connection';
import { Disposable, Emitter, IDisposable, MaybePromise, toDisposable } from '@opensumi/ide-core-common';
import { AppConfig, INodeLogger } from '@opensumi/ide-core-node';

import {
  EXT_HOST_PROXY_IDENTIFIER,
  EXT_HOST_PROXY_PROCESS_WIRE_VERSION,
  EXT_HOST_PROXY_SERVER_PROT,
  EXT_SERVER_IDENTIFIER,
  ExtHostProxyCapabilitiesV2,
  ExtHostProxyProcessEventV2,
  ExtHostProxyProcessLeaseV2,
  ExtHostProxyProtocolMode,
  ExtensionHostProcessEpochLoss,
  ExtensionHostProcessLease,
  IExtHostProxyRPCService,
  IExtensionHostManager,
  Output,
  OutputType,
} from '../common';

import {
  BufferedExtensionHostProcessRegistration,
  ExtensionHostProcessLeaseError,
  ExtensionHostProcessLeaseObserver,
  ExtensionHostProcessRegistration,
  IExtensionHostProcessLeaseManager,
  allocateExtensionHostProcessManagerEpoch,
  createExtensionHostProcessLease,
  createExtensionHostProcessLeaseManager,
} from './extension-host-process-manager';

import type { ForkOptions } from 'child_process';

type ProxyProcessEventListener<T extends any[]> = (lease: ExtensionHostProcessLease, ...args: T) => void;

interface PendingProxyFork {
  readonly epoch: number;
  readonly events: ExtHostProxyProcessEventV2[];
  readonly observer: ExtensionHostProcessLeaseObserver;
  readonly operationId: string;
  nextSequence: number;
  record?: ProxyProcessLeaseRecord;
  terminal: boolean;
}

interface ProxyProcessLeaseRecord {
  readonly lease: ExtensionHostProcessLease;
  readonly messageListeners: Set<ProxyProcessEventListener<[unknown]>>;
  readonly operation: PendingProxyFork;
  readonly outputListeners: Set<ProxyProcessEventListener<[Output]>>;
  readonly exitListeners: Set<ProxyProcessEventListener<[number, string]>>;
  readonly registration: BufferedExtensionHostProcessRegistration;
  readonly wireLease: ExtHostProxyProcessLeaseV2;
  state: 'active' | 'released' | 'superseded';
}

interface NegotiatedProxyEpoch {
  readonly capabilities?: ExtHostProxyCapabilitiesV2;
  readonly epoch: number;
  readonly mode: 'v1' | 'v2';
  readonly proxy: IExtHostProxyRPCService;
}

const MAX_PENDING_PROCESS_EVENTS = 1024;
const MAX_RETIRED_PROCESS_OPERATIONS = 1024;

@Injectable()
export class ExtensionHostProxyManager implements IExtensionHostProcessLeaseManager {
  readonly processLeaseVersion = 1 as const;
  readonly processControlLocation = 'remote' as const;

  @Autowired(INodeLogger)
  private readonly logger: INodeLogger;

  @Autowired(AppConfig)
  private readonly appConfig: AppConfig;

  private callId = 0;
  private extHostProxyProtocol: SumiConnectionMultiplexer;
  private extHostProxy: IExtHostProxyRPCService;
  private callbackMap = new Map<number, (...args: any[]) => void>();
  private processDisposeMap = new Map<number, Disposable>();
  private disposer = new Disposable();
  private readonly processEpochLostEmitter = new Emitter<ExtensionHostProcessEpochLoss>();
  readonly onDidLoseProcessEpoch = this.processEpochLostEmitter.event;
  private processEpoch = 0;
  private processEpochLost = true;
  private protocolMode: ExtHostProxyProtocolMode = 'lost';
  private capabilityNegotiation:
    | {
        epoch: number;
        promise: Promise<NegotiatedProxyEpoch>;
      }
    | undefined;
  private currentLeaseManagerEpoch = 0;
  private nextOperationId = 1;
  private readonly issuedLeases = new WeakSet<object>();
  private readonly legacyLeaseManagerByLease = new WeakMap<object, IExtensionHostProcessLeaseManager>();
  private readonly processLeaseRecords = new Map<number, ProxyProcessLeaseRecord>();
  private readonly currentLeaseRecordByPid = new Map<number, ProxyProcessLeaseRecord>();
  private readonly pendingForks = new Map<string, PendingProxyFork>();
  private readonly retiredOperationIds = new Set<string>();
  private legacyLeaseManager: IExtensionHostProcessLeaseManager | undefined;

  LOG_TAG = '[ExtensionHostProxyManager]';
  connection: NetSocketConnection;

  constructor(
    @Optional()
    private listenOptions: net.ListenOptions = {
      port: EXT_HOST_PROXY_SERVER_PROT,
    },
  ) {
    this.disposer.addDispose(this.processEpochLostEmitter);
  }

  get processLeaseProtocolMode(): ExtHostProxyProtocolMode {
    return this.protocolMode;
  }

  async init() {
    await this.startProxyServer();
  }

  private startProxyServer() {
    return new Promise<void>((resolve) => {
      const server = net.createServer();
      this.disposer.addDispose(
        toDisposable(() => {
          this.logger.warn(this.LOG_TAG, 'dispose server');
          server.close((err) => {
            if (err) {
              this.logger.error(this.LOG_TAG, 'close server error', err);
            }
          });
        }),
      );

      this.logger.log(this.LOG_TAG, 'waiting ext-proxy connecting...');
      server.on('connection', (socket) => {
        this.logger.log(this.LOG_TAG, 'there are new connections coming in');
        if (this.processEpoch > 0 && !this.processEpochLost) {
          this.loseProcessEpoch(this.processEpoch, 'connection-replaced');
        }
        this.extHostProxyProtocol?.dispose();
        this.connection?.destroy();

        const connection = new NetSocketConnection(socket);
        const epoch = ++this.processEpoch;
        this.processEpochLost = false;
        this.protocolMode = 'negotiating';
        this.capabilityNegotiation = undefined;
        this.currentLeaseManagerEpoch = allocateExtensionHostProcessManagerEpoch();
        this.connection = connection;
        connection.onceClose(() => this.loseProcessEpoch(epoch, 'connection-closed'));
        this.disposer.addDispose(
          toDisposable(() => {
            if (!socket.destroyed) {
              socket.destroy();
            }
          }),
        );
        this.setExtHostProxyRPCProtocol(connection, epoch);
        resolve();
      });
      server.listen(this.listenOptions);
    });
  }

  private setExtHostProxyRPCProtocol(connection: NetSocketConnection, epoch: number) {
    this.disposeAllProcessCallbacks();
    this.clearLeaseState();
    this.extHostProxyProtocol = new SumiConnectionMultiplexer(connection, {
      timeout: this.appConfig.rpcMessageTimeout,
    });

    this.extHostProxyProtocol.set(EXT_SERVER_IDENTIFIER, {
      $callback: async (callId: number, ...args: any[]) => {
        const callback = this.callbackMap.get(callId);
        if (!callback) {
          return Promise.reject(new Error(`no found callback: ${callId}`));
        }
        callback(...args);
      },
      $processEventV2: async (event: ExtHostProxyProcessEventV2) => this.acceptProcessEvent(epoch, event),
    });

    const proxy = this.extHostProxyProtocol.getProxy(EXT_HOST_PROXY_IDENTIFIER);
    this.extHostProxy = proxy;
    this.legacyLeaseManager = createExtensionHostProcessLeaseManager(this.createLegacyManager(epoch, proxy));
  }

  private loseProcessEpoch(epoch: number, reason: ExtensionHostProcessEpochLoss['reason']): void {
    if (epoch !== this.processEpoch || this.processEpochLost) {
      return;
    }
    this.processEpochLost = true;
    this.protocolMode = 'lost';
    this.capabilityNegotiation = undefined;
    this.disposeAllProcessCallbacks();
    this.clearLeaseState();
    const legacyLeaseManager = this.legacyLeaseManager;
    this.legacyLeaseManager = undefined;
    this.processEpochLostEmitter.fire({ epoch, reason });
    void Promise.resolve(legacyLeaseManager?.dispose()).catch(() => undefined);
  }

  private clearLeaseState(): void {
    for (const record of this.processLeaseRecords.values()) {
      record.registration.discard();
      record.messageListeners.clear();
      record.outputListeners.clear();
      record.exitListeners.clear();
      record.state = 'released';
    }
    for (const operation of this.pendingForks.values()) {
      operation.events.length = 0;
      operation.record?.registration.discard();
    }
    this.processLeaseRecords.clear();
    this.currentLeaseRecordByPid.clear();
    this.pendingForks.clear();
    this.retiredOperationIds.clear();
  }

  private addNewCallback(pid: number, callback: (...args: any[]) => void) {
    const callId = this.callId++;
    this.callbackMap.set(callId, callback);
    let processDisposer = this.processDisposeMap.get(pid);
    if (!processDisposer) {
      processDisposer = new Disposable();
      this.processDisposeMap.set(pid, processDisposer);
      this.disposer.addDispose(processDisposer);
    }
    processDisposer.addDispose(
      toDisposable(() => {
        this.callbackMap.delete(callId);
      }),
    );
    return callId;
  }

  private disposeProcessCallbacks(pid: number) {
    this.processDisposeMap.get(pid)?.dispose();
    this.processDisposeMap.delete(pid);
  }

  private disposeAllProcessCallbacks() {
    this.processDisposeMap.forEach((disposer) => disposer.dispose());
    this.processDisposeMap.clear();
    this.callbackMap.clear();
  }

  private createLegacyManager(epoch: number, proxy: IExtHostProxyRPCService): IExtensionHostManager {
    const assertCurrent = () => this.assertCurrentEpoch(epoch);
    return {
      onDidLoseProcessEpoch: this.onDidLoseProcessEpoch,
      init: () => undefined,
      fork: (modulePath: string, ...args: any[]) => {
        assertCurrent();
        return proxy.$fork(modulePath, ...args);
      },
      send: (pid, message) => {
        assertCurrent();
        return proxy.$send(pid, message);
      },
      isRunning: (pid) => {
        assertCurrent();
        return proxy.$isRunning(pid);
      },
      treeKill: (pid) => {
        assertCurrent();
        return proxy.$treeKill(pid);
      },
      kill: (pid, signal) => {
        assertCurrent();
        return proxy.$kill(pid, signal);
      },
      isKilled: (pid) => {
        assertCurrent();
        return proxy.$isKilled(pid);
      },
      findDebugPort: (startPort, giveUpAfter, timeout) => {
        assertCurrent();
        return proxy.$findDebugPort(startPort, giveUpAfter, timeout);
      },
      onOutput: (pid, listener) => {
        assertCurrent();
        const callId = this.addNewCallback(pid, listener);
        return proxy.$onOutput(callId, pid);
      },
      onExit: (pid, listener) => {
        assertCurrent();
        const callId = this.addNewCallback(pid, (code, signal) => {
          try {
            listener(code, signal);
          } finally {
            this.disposeProcessCallbacks(pid);
          }
        });
        return proxy.$onExit(callId, pid);
      },
      onMessage: (pid, listener) => {
        assertCurrent();
        const callId = this.addNewCallback(pid, listener);
        return proxy.$onMessage(callId, pid);
      },
      disposeProcess: (pid) => {
        assertCurrent();
        this.disposeProcessCallbacks(pid);
        return proxy.$disposeProcess(pid);
      },
      dispose: () => undefined,
    };
  }

  private async negotiateProcessWire(epoch: number): Promise<NegotiatedProxyEpoch> {
    this.assertCurrentEpoch(epoch);
    if (this.protocolMode === 'v1') {
      return { epoch, mode: 'v1', proxy: this.extHostProxy };
    }
    if (this.protocolMode === 'v2') {
      return this.capabilityNegotiation!.promise;
    }
    if (this.capabilityNegotiation?.epoch === epoch) {
      return this.capabilityNegotiation.promise;
    }

    const proxy = this.extHostProxy;
    const promise = (async (): Promise<NegotiatedProxyEpoch> => {
      try {
        const capabilities = await proxy.$getCapabilities!();
        this.assertCurrentEpoch(epoch);
        if (!this.isValidCapabilities(capabilities)) {
          throw new Error('Extension Host proxy returned invalid V2 capabilities');
        }
        this.protocolMode = 'v2';
        return { capabilities, epoch, mode: 'v2', proxy };
      } catch (error) {
        if (this.isMissingProxyMethod(error, '$getCapabilities')) {
          this.assertCurrentEpoch(epoch);
          this.protocolMode = 'v1';
          return { epoch, mode: 'v1', proxy };
        }
        this.failCloseEpoch(epoch, error);
        throw error;
      }
    })();
    this.capabilityNegotiation = { epoch, promise };
    return promise;
  }

  private isValidCapabilities(value: unknown): value is ExtHostProxyCapabilitiesV2 {
    const capabilities = value as Partial<ExtHostProxyCapabilitiesV2> | undefined;
    return Boolean(
      capabilities &&
      capabilities.protocolVersion === EXT_HOST_PROXY_PROCESS_WIRE_VERSION &&
      typeof capabilities.proxyInstanceId === 'string' &&
      capabilities.proxyInstanceId.length > 0 &&
      Number.isSafeInteger(capabilities.managerEpoch) &&
      capabilities.managerEpoch! > 0 &&
      capabilities.features?.atomicLifecycle === true &&
      capabilities.features?.processLease === true &&
      capabilities.features?.sequencedProcessEvents === true,
    );
  }

  private isMissingProxyMethod(error: unknown, method: string): boolean {
    return (
      error instanceof Error &&
      error.message === `Unknown method ${method} on actor ${EXT_HOST_PROXY_IDENTIFIER.serviceId}`
    );
  }

  private failCloseEpoch(epoch: number, error: unknown): void {
    if (epoch !== this.processEpoch || this.processEpochLost) {
      return;
    }
    this.logger.error(this.LOG_TAG, `fail-close process epoch ${epoch}`, error);
    this.loseProcessEpoch(epoch, 'connection-closed');
    this.extHostProxyProtocol?.dispose();
    this.connection?.destroy();
  }

  private assertCurrentEpoch(epoch: number): void {
    if (epoch !== this.processEpoch || this.processEpochLost) {
      const error = new Error(`Extension Host proxy process epoch ${epoch} is stale`);
      error.name = 'ExtensionHostProxyEpochError';
      throw error;
    }
  }

  async forkWithLease(
    modulePath: string,
    args: string[],
    options: ForkOptions,
    observer: ExtensionHostProcessLeaseObserver,
  ): Promise<ExtensionHostProcessRegistration> {
    const epoch = this.processEpoch;
    const negotiated = await this.negotiateProcessWire(epoch);
    if (negotiated.mode === 'v1') {
      const legacyLeaseManager = this.requireLegacyLeaseManager('fork');
      const registration = await legacyLeaseManager.forkWithLease(modulePath, args, options, observer);
      this.legacyLeaseManagerByLease.set(registration.lease, legacyLeaseManager);
      return registration;
    }
    return this.forkWithLeaseV2(negotiated, modulePath, args, options, observer);
  }

  private async forkWithLeaseV2(
    negotiated: NegotiatedProxyEpoch,
    modulePath: string,
    args: string[],
    options: ForkOptions,
    observer: ExtensionHostProcessLeaseObserver,
  ): Promise<ExtensionHostProcessRegistration> {
    const operationId = `${negotiated.epoch}:${this.nextOperationId++}`;
    const operation: PendingProxyFork = {
      epoch: negotiated.epoch,
      events: [],
      nextSequence: 0,
      observer,
      operationId,
      terminal: false,
    };
    this.pendingForks.set(operationId, operation);

    let wireLease: ExtHostProxyProcessLeaseV2;
    try {
      wireLease = await negotiated.proxy.$forkWithLifecycleV2!({ operationId, modulePath, args, options });
    } catch (error) {
      this.pendingForks.delete(operationId);
      // A timeout/close cannot prove whether the remote fork committed. Never
      // retry it in-place: closing this epoch makes the proxy disposer the
      // single reconciliation owner for every possibly-created process.
      if (this.isUncertainForkFailure(error) || this.isMissingProxyMethod(error, '$forkWithLifecycleV2')) {
        this.failCloseEpoch(negotiated.epoch, error);
      }
      throw error;
    }
    this.assertCurrentEpoch(negotiated.epoch);
    if (!this.isValidWireLease(negotiated.capabilities!, wireLease)) {
      const error = new Error('Extension Host proxy returned an invalid process lease');
      this.failCloseEpoch(negotiated.epoch, error);
      throw error;
    }
    if (this.processLeaseRecords.has(wireLease.leaseId)) {
      const error = new Error(`Duplicate Extension Host proxy lease id ${wireLease.leaseId}`);
      this.failCloseEpoch(negotiated.epoch, error);
      throw error;
    }

    const lease = createExtensionHostProcessLease(this.currentLeaseManagerEpoch, wireLease.pid, wireLease.leaseId);
    const registration = new BufferedExtensionHostProcessRegistration(lease, observer);
    const record: ProxyProcessLeaseRecord = {
      lease,
      messageListeners: new Set(),
      operation,
      outputListeners: new Set(),
      exitListeners: new Set(),
      registration,
      state: operation.terminal ? 'released' : 'active',
      wireLease,
    };
    operation.record = record;
    this.issuedLeases.add(lease);
    this.processLeaseRecords.set(lease.leaseId, record);
    const previous = this.currentLeaseRecordByPid.get(lease.pid);
    if (previous?.state === 'active') {
      previous.state = 'superseded';
    }
    if (record.state === 'active') {
      this.currentLeaseRecordByPid.set(lease.pid, record);
    }
    for (const event of operation.events.splice(0)) {
      if (!this.matchesWireLease(wireLease, event.lease)) {
        const error = new Error(`Extension Host proxy event lease mismatch for ${operationId}`);
        this.failCloseEpoch(negotiated.epoch, error);
        throw error;
      }
      this.deliverProcessEvent(record, event);
    }
    return registration;
  }

  private isValidWireLease(
    capabilities: ExtHostProxyCapabilitiesV2,
    lease: unknown,
  ): lease is ExtHostProxyProcessLeaseV2 {
    return (
      this.isValidWireLeaseShape(lease) &&
      lease.proxyInstanceId === capabilities.proxyInstanceId &&
      lease.managerEpoch === capabilities.managerEpoch
    );
  }

  private isUncertainForkFailure(error: unknown): boolean {
    return (
      error instanceof Error &&
      (error.name === 'ConnectionClosedError' ||
        error.constructor.name === 'MethodTimeoutError' ||
        /^method .* timeout$/.test(error.message))
    );
  }

  private acceptProcessEvent(epoch: number, event: unknown): void {
    this.assertCurrentEpoch(epoch);
    if (!this.isValidProcessEvent(event)) {
      const error = new Error('Malformed Extension Host proxy process event');
      this.failCloseEpoch(epoch, error);
      throw error;
    }
    const operation = this.pendingForks.get(event.operationId);
    if (!operation) {
      if (this.retiredOperationIds.has(event.operationId)) {
        return;
      }
      const error = new Error(`Unknown Extension Host proxy operation ${event.operationId}`);
      this.failCloseEpoch(epoch, error);
      throw error;
    }
    if (operation.epoch !== epoch || event.sequence !== operation.nextSequence) {
      const error = new Error(`Invalid Extension Host proxy event sequence for ${event.operationId}`);
      this.failCloseEpoch(epoch, error);
      throw error;
    }
    operation.nextSequence += 1;
    if (operation.record && !this.matchesWireLease(operation.record.wireLease, event.lease)) {
      const error = new Error(`Extension Host proxy event lease mismatch for ${event.operationId}`);
      this.failCloseEpoch(epoch, error);
      throw error;
    }
    if (operation.terminal) {
      const error = new Error(`Extension Host proxy emitted an event after exit for ${event.operationId}`);
      this.failCloseEpoch(epoch, error);
      throw error;
    }
    if (event.kind === 'exit') {
      operation.terminal = true;
    }
    if (operation.record) {
      this.deliverProcessEvent(operation.record, event);
      return;
    }
    if (operation.events.length >= MAX_PENDING_PROCESS_EVENTS) {
      const error = new Error(`Extension Host proxy event buffer overflow for ${event.operationId}`);
      this.failCloseEpoch(epoch, error);
      throw error;
    }
    operation.events.push(event);
  }

  private isValidProcessEvent(event: unknown): event is ExtHostProxyProcessEventV2 {
    if (!event || typeof event !== 'object') {
      return false;
    }
    const candidate = event as Record<string, unknown>;
    if (
      typeof candidate.operationId !== 'string' ||
      candidate.operationId.length === 0 ||
      !Number.isSafeInteger(candidate.sequence) ||
      (candidate.sequence as number) < 0 ||
      !this.isValidWireLeaseShape(candidate.lease)
    ) {
      return false;
    }
    switch (candidate.kind) {
      case 'exit':
        return Number.isSafeInteger(candidate.code) && typeof candidate.signal === 'string';
      case 'message':
        return Object.prototype.hasOwnProperty.call(candidate, 'message');
      case 'output': {
        const output = candidate.output as Partial<Output> | undefined;
        return Boolean(
          output &&
          typeof output === 'object' &&
          (output.type === OutputType.STDOUT || output.type === OutputType.STDERR) &&
          typeof output.data === 'string' &&
          Array.isArray(output.format) &&
          output.format.every((item) => typeof item === 'string'),
        );
      }
      default:
        return false;
    }
  }

  private isValidWireLeaseShape(lease: unknown): lease is ExtHostProxyProcessLeaseV2 {
    const candidate = lease as Partial<ExtHostProxyProcessLeaseV2> | undefined;
    return Boolean(
      candidate &&
      typeof candidate === 'object' &&
      typeof candidate.proxyInstanceId === 'string' &&
      candidate.proxyInstanceId.length > 0 &&
      Number.isSafeInteger(candidate.managerEpoch) &&
      candidate.managerEpoch! > 0 &&
      Number.isSafeInteger(candidate.leaseId) &&
      candidate.leaseId! > 0 &&
      Number.isSafeInteger(candidate.pid) &&
      candidate.pid! > 0,
    );
  }

  private deliverProcessEvent(record: ProxyProcessLeaseRecord, event: ExtHostProxyProcessEventV2): void {
    switch (event.kind) {
      case 'exit':
        record.registration.acceptExit(event.code, event.signal);
        for (const listener of record.exitListeners) {
          listener(record.lease, event.code, event.signal);
        }
        record.state = 'released';
        if (this.currentLeaseRecordByPid.get(record.lease.pid) === record) {
          this.currentLeaseRecordByPid.delete(record.lease.pid);
        }
        break;
      case 'message':
        record.registration.acceptMessage(event.message);
        for (const listener of record.messageListeners) {
          listener(record.lease, event.message);
        }
        break;
      case 'output':
        record.registration.acceptOutput(event.output);
        for (const listener of record.outputListeners) {
          listener(record.lease, event.output);
        }
        break;
    }
  }

  private matchesWireLease(expected: ExtHostProxyProcessLeaseV2, actual: ExtHostProxyProcessLeaseV2): boolean {
    return (
      expected.proxyInstanceId === actual.proxyInstanceId &&
      expected.managerEpoch === actual.managerEpoch &&
      expected.leaseId === actual.leaseId &&
      expected.pid === actual.pid
    );
  }

  fork(modulePath: string, ...args: any[]) {
    return this.extHostProxy.$fork(modulePath, ...args);
  }

  send(pid: number, message: string) {
    return this.extHostProxy.$send(pid, message);
  }

  sendLease(lease: ExtensionHostProcessLease, message: string): MaybePromise<void> {
    const record = this.getIssuedV2Record(lease, 'send');
    if (!record) {
      if (this.isIssuedV2Lease(lease)) {
        throw new ExtensionHostProcessLeaseError('send', 'stale');
      }
      return this.getLegacyLeaseManager(lease, 'send').sendLease(lease, message);
    }
    this.requireCurrentRecord(record, 'send');
    return this.extHostProxy.$sendLeaseV2!(record.wireLease, message);
  }

  isRunning(pid: number): MaybePromise<boolean> {
    return this.extHostProxy.$isRunning(pid);
  }

  isRunningLease(lease: ExtensionHostProcessLease): MaybePromise<boolean> {
    const record = this.getIssuedV2Record(lease, 'query');
    if (!record) {
      if (this.isIssuedV2Lease(lease)) {
        return false;
      }
      return this.getLegacyLeaseManager(lease, 'query').isRunningLease(lease);
    }
    if (!this.isCurrentRecord(record)) {
      return false;
    }
    return this.extHostProxy.$isRunningLeaseV2!(record.wireLease);
  }

  treeKill(pid: number): MaybePromise<void> {
    return this.extHostProxy.$treeKill(pid);
  }

  treeKillLease(lease: ExtensionHostProcessLease): MaybePromise<void> {
    const record = this.getIssuedV2Record(lease, 'tree-kill');
    if (!record) {
      if (this.isIssuedV2Lease(lease)) {
        throw new ExtensionHostProcessLeaseError('tree-kill', 'stale');
      }
      return this.getLegacyLeaseManager(lease, 'tree-kill').treeKillLease(lease);
    }
    this.requireCurrentRecord(record, 'tree-kill');
    return this.extHostProxy.$treeKillLeaseV2!(record.wireLease);
  }

  kill(pid: number, signal?: string): MaybePromise<void> {
    return this.extHostProxy.$kill(pid, signal);
  }

  killLease(lease: ExtensionHostProcessLease, signal?: string): MaybePromise<void> {
    const record = this.getIssuedV2Record(lease, 'kill');
    if (!record) {
      if (this.isIssuedV2Lease(lease)) {
        throw new ExtensionHostProcessLeaseError('kill', 'stale');
      }
      return this.getLegacyLeaseManager(lease, 'kill').killLease(lease, signal);
    }
    this.requireCurrentRecord(record, 'kill');
    return this.extHostProxy.$killLeaseV2!(record.wireLease, signal);
  }

  isKilled(pid: number): MaybePromise<boolean> {
    return this.extHostProxy.$isKilled(pid);
  }

  isKilledLease(lease: ExtensionHostProcessLease): MaybePromise<boolean> {
    const record = this.getIssuedV2Record(lease, 'query');
    if (!record) {
      if (this.isIssuedV2Lease(lease)) {
        return true;
      }
      return this.getLegacyLeaseManager(lease, 'query').isKilledLease(lease);
    }
    if (!this.isCurrentRecord(record)) {
      return true;
    }
    return this.extHostProxy.$isKilledLeaseV2!(record.wireLease);
  }

  findDebugPort(startPort: number, giveUpAfter: number, timeout: number): Promise<number> {
    return this.extHostProxy.$findDebugPort(startPort, giveUpAfter, timeout);
  }

  onOutput(pid: number, listener: (output: Output) => void): MaybePromise<void> {
    const callId = this.addNewCallback(pid, listener);
    return this.extHostProxy.$onOutput(callId, pid);
  }

  onOutputLease(
    lease: ExtensionHostProcessLease,
    listener: ProxyProcessEventListener<[Output]>,
  ): MaybePromise<IDisposable> {
    const record = this.getIssuedV2Record(lease, 'observe output');
    if (!record) {
      if (this.isIssuedV2Lease(lease)) {
        throw new ExtensionHostProcessLeaseError('observe output', 'stale');
      }
      return this.getLegacyLeaseManager(lease, 'observe output').onOutputLease(lease, listener);
    }
    this.requireCurrentRecord(record, 'observe output');
    return this.addLeaseListener(record.outputListeners, listener);
  }

  onExit(pid: number, listener: (code: number, signal: string) => void): MaybePromise<void> {
    const callId = this.addNewCallback(pid, (code, signal) => {
      try {
        listener(code, signal);
      } finally {
        this.disposeProcessCallbacks(pid);
      }
    });
    return this.extHostProxy.$onExit(callId, pid);
  }

  onExitLease(
    lease: ExtensionHostProcessLease,
    listener: ProxyProcessEventListener<[number, string]>,
  ): MaybePromise<IDisposable> {
    const record = this.getIssuedV2Record(lease, 'observe exit');
    if (!record) {
      if (this.isIssuedV2Lease(lease)) {
        throw new ExtensionHostProcessLeaseError('observe exit', 'stale');
      }
      return this.getLegacyLeaseManager(lease, 'observe exit').onExitLease(lease, listener);
    }
    this.requireCurrentRecord(record, 'observe exit');
    return this.addLeaseListener(record.exitListeners, listener);
  }

  onMessage(pid: number, listener: (msg: any) => void): MaybePromise<void> {
    const callId = this.addNewCallback(pid, listener);
    return this.extHostProxy.$onMessage(callId, pid);
  }

  onMessageLease(
    lease: ExtensionHostProcessLease,
    listener: ProxyProcessEventListener<[unknown]>,
  ): MaybePromise<IDisposable> {
    const record = this.getIssuedV2Record(lease, 'observe message');
    if (!record) {
      if (this.isIssuedV2Lease(lease)) {
        throw new ExtensionHostProcessLeaseError('observe message', 'stale');
      }
      return this.getLegacyLeaseManager(lease, 'observe message').onMessageLease(lease, listener);
    }
    this.requireCurrentRecord(record, 'observe message');
    return this.addLeaseListener(record.messageListeners, listener);
  }

  private addLeaseListener<T extends any[]>(
    listeners: Set<ProxyProcessEventListener<T>>,
    listener: ProxyProcessEventListener<T>,
  ): IDisposable {
    listeners.add(listener);
    return toDisposable(() => listeners.delete(listener));
  }

  disposeProcess(pid: number): MaybePromise<void> {
    this.disposeProcessCallbacks(pid);
    return this.extHostProxy.$disposeProcess(pid);
  }

  async disposeLease(lease: ExtensionHostProcessLease): Promise<void> {
    const record = this.getIssuedV2Record(lease, 'dispose');
    if (!record) {
      if (this.isIssuedV2Lease(lease)) {
        return;
      }
      await this.getLegacyLeaseManager(lease, 'dispose').disposeLease(lease);
      return;
    }
    record.registration.discard();
    try {
      await this.extHostProxy.$disposeLeaseV2!(record.wireLease);
    } finally {
      this.releaseV2Record(record);
    }
  }

  private getIssuedV2Record(lease: ExtensionHostProcessLease, operation: string): ProxyProcessLeaseRecord | undefined {
    if (!lease || typeof lease !== 'object' || !this.issuedLeases.has(lease)) {
      return undefined;
    }
    const record = this.processLeaseRecords.get(lease.leaseId);
    if (lease.managerEpoch !== this.currentLeaseManagerEpoch) {
      return undefined;
    }
    if (record && (record.lease !== lease || record.lease.pid !== lease.pid)) {
      throw new ExtensionHostProcessLeaseError(operation, 'identity-mismatch');
    }
    return record;
  }

  private isIssuedV2Lease(lease: ExtensionHostProcessLease): boolean {
    return Boolean(lease && typeof lease === 'object' && this.issuedLeases.has(lease));
  }

  private requireLegacyLeaseManager(operation: string): IExtensionHostProcessLeaseManager {
    if (!this.legacyLeaseManager) {
      throw new ExtensionHostProcessLeaseError(operation, 'stale');
    }
    return this.legacyLeaseManager;
  }

  private getLegacyLeaseManager(
    lease: ExtensionHostProcessLease,
    operation: string,
  ): IExtensionHostProcessLeaseManager {
    if (lease && typeof lease === 'object') {
      const issuedManager = this.legacyLeaseManagerByLease.get(lease);
      if (issuedManager) {
        return issuedManager;
      }
    }
    return this.requireLegacyLeaseManager(operation);
  }

  private requireCurrentRecord(record: ProxyProcessLeaseRecord, operation: string): void {
    if (!this.isCurrentRecord(record)) {
      throw new ExtensionHostProcessLeaseError(operation, 'stale');
    }
  }

  private isCurrentRecord(record: ProxyProcessLeaseRecord): boolean {
    return record.state === 'active' && this.currentLeaseRecordByPid.get(record.lease.pid) === record;
  }

  private releaseV2Record(record: ProxyProcessLeaseRecord): void {
    record.registration.discard();
    record.messageListeners.clear();
    record.outputListeners.clear();
    record.exitListeners.clear();
    record.state = 'released';
    if (this.processLeaseRecords.get(record.lease.leaseId) === record) {
      this.processLeaseRecords.delete(record.lease.leaseId);
    }
    if (this.currentLeaseRecordByPid.get(record.lease.pid) === record) {
      this.currentLeaseRecordByPid.delete(record.lease.pid);
    }
    if (this.pendingForks.get(record.operation.operationId) === record.operation) {
      this.pendingForks.delete(record.operation.operationId);
    }
    if (!this.processEpochLost && record.operation.epoch === this.processEpoch) {
      this.retiredOperationIds.add(record.operation.operationId);
      while (this.retiredOperationIds.size > MAX_RETIRED_PROCESS_OPERATIONS) {
        const oldestOperationId = this.retiredOperationIds.values().next().value;
        if (oldestOperationId === undefined) {
          break;
        }
        this.retiredOperationIds.delete(oldestOperationId);
      }
    }
  }

  async dispose() {
    if (!this.disposer.disposed) {
      this.logger.log(this.LOG_TAG, 'dispose ext host proxy');
      this.processEpochLost = true;
      this.protocolMode = 'lost';
      this.capabilityNegotiation = undefined;
      this.disposeAllProcessCallbacks();
      this.clearLeaseState();
      const legacyLeaseManager = this.legacyLeaseManager;
      this.legacyLeaseManager = undefined;
      void Promise.resolve(legacyLeaseManager?.dispose()).catch(() => undefined);
      try {
        await this.extHostProxy?.$dispose();
      } finally {
        this.disposer.dispose();
      }
    }
  }
}
