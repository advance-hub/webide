import { randomUUID } from 'crypto';
import net from 'net';

import { IRPCProtocol, NetSocketConnection, RPCService, SumiConnectionMultiplexer } from '@opensumi/ide-connection';
import { Disposable, Emitter, IDisposable, getDebugLogger } from '@opensumi/ide-core-node';

import { IExtensionHostManager, Output } from '../common';
import {
  EXT_HOST_PROXY_IDENTIFIER,
  EXT_HOST_PROXY_PROCESS_WIRE_VERSION,
  EXT_HOST_PROXY_SERVER_PROT,
  EXT_SERVER_IDENTIFIER,
  ExtHostProxyCapabilitiesV2,
  ExtHostProxyForkRequestV2,
  ExtHostProxyProcessEventV2,
  ExtHostProxyProcessLeaseV2,
  IExtHostProxy,
  IExtHostProxyOptions,
  IExtHostProxyRPCService,
  IExtServerProxyRPCService,
} from '../common/ext.host.proxy';
import {
  ExtensionHostProcessRegistration,
  IExtensionHostProcessLeaseManager,
  createExtensionHostProcessLeaseManager,
} from '../node/extension-host-process-manager';
import { ExtensionHostManager } from '../node/extension.host.manager';

import type { ForkOptions } from 'child_process';

interface HostedProcessLeaseRecord {
  readonly operationId: string;
  readonly registration: ExtensionHostProcessRegistration;
  readonly wireLease: ExtHostProxyProcessLeaseV2;
  acceptingEvents: boolean;
  delivery: Promise<void>;
  nextSequence: number;
  pendingDeliveries: number;
  terminalEventQueued: boolean;
}

type PendingHostedProcessEvent =
  | { kind: 'exit'; code: number; signal: string }
  | { kind: 'message'; message: unknown }
  | { kind: 'output'; output: Output };

const MAX_PENDING_PROXY_EVENT_DELIVERIES = 1024;
const MAX_COMPLETED_PROXY_OPERATIONS = 1024;

export class ExtHostProxyRPCService extends RPCService implements IExtHostProxyRPCService {
  private readonly extensionHostManager: IExtensionHostManager;

  private readonly processLeaseManager: IExtensionHostProcessLeaseManager;

  private readonly operationOutcomes = new Map<string, Promise<ExtHostProxyProcessLeaseV2>>();

  private readonly completedOperationOutcomes = new Map<string, ExtHostProxyProcessLeaseV2>();

  private readonly leaseRecords = new Map<number, HostedProcessLeaseRecord>();

  private disposed = false;

  LOG_TAG = '[ExtHostProxyRPCService]';

  constructor(
    private readonly extServerProxy: IExtServerProxyRPCService,
    private readonly proxyInstanceId: string = randomUUID(),
    private readonly managerEpoch: number = 1,
    extensionHostManager: IExtensionHostManager = new ExtensionHostManager(),
    private readonly onProtocolFault: (error: unknown) => void = () => undefined,
  ) {
    super();
    this.extensionHostManager = extensionHostManager;
    this.processLeaseManager = createExtensionHostProcessLeaseManager(extensionHostManager);
  }

  async $getCapabilities(): Promise<ExtHostProxyCapabilitiesV2> {
    return {
      protocolVersion: EXT_HOST_PROXY_PROCESS_WIRE_VERSION,
      proxyInstanceId: this.proxyInstanceId,
      managerEpoch: this.managerEpoch,
      features: {
        atomicLifecycle: true,
        processLease: true,
        sequencedProcessEvents: true,
      },
    };
  }

  $forkWithLifecycleV2(request: ExtHostProxyForkRequestV2): Promise<ExtHostProxyProcessLeaseV2> {
    if (typeof request?.operationId !== 'string' || request.operationId.length === 0) {
      return Promise.reject(new Error('Extension Host proxy operation id is required'));
    }
    const existing = this.operationOutcomes.get(request.operationId);
    if (existing) {
      return existing;
    }
    const completed = this.completedOperationOutcomes.get(request.operationId);
    if (completed) {
      this.completedOperationOutcomes.delete(request.operationId);
      this.completedOperationOutcomes.set(request.operationId, completed);
      return Promise.resolve(completed);
    }

    const outcome = this.forkWithLifecycleV2(request);
    this.operationOutcomes.set(request.operationId, outcome);
    return outcome;
  }

  private async forkWithLifecycleV2(request: ExtHostProxyForkRequestV2): Promise<ExtHostProxyProcessLeaseV2> {
    const pendingEvents: PendingHostedProcessEvent[] = [];
    const forkState: { record?: HostedProcessLeaseRecord } = {};
    const acceptEvent = (event: PendingHostedProcessEvent) => {
      if (forkState.record) {
        this.publishProcessEvent(forkState.record, event);
      } else {
        pendingEvents.push(event);
      }
    };

    let registration: ExtensionHostProcessRegistration;
    try {
      registration = await this.processLeaseManager.forkWithLease(
        request.modulePath,
        request.args,
        this.createForkOptions(request.options),
        {
          onExit: (_lease, code, signal) => acceptEvent({ kind: 'exit', code, signal }),
          onMessage: (_lease, message) => acceptEvent({ kind: 'message', message }),
          onOutput: (_lease, output) => acceptEvent({ kind: 'output', output }),
        },
      );
    } catch (error) {
      this.operationOutcomes.delete(request.operationId);
      throw error;
    }

    const wireLease = Object.freeze({
      proxyInstanceId: this.proxyInstanceId,
      managerEpoch: this.managerEpoch,
      leaseId: registration.lease.leaseId,
      pid: registration.lease.pid,
    });
    if (this.leaseRecords.has(wireLease.leaseId)) {
      registration.discard();
      this.operationOutcomes.delete(request.operationId);
      await this.reclaimRegistration(registration);
      throw new Error(`Duplicate Extension Host proxy lease id ${wireLease.leaseId}`);
    }

    const record: HostedProcessLeaseRecord = {
      acceptingEvents: true,
      operationId: request.operationId,
      registration,
      wireLease,
      delivery: Promise.resolve(),
      nextSequence: 0,
      pendingDeliveries: 0,
      terminalEventQueued: false,
    };
    forkState.record = record;
    this.leaseRecords.set(wireLease.leaseId, record);
    try {
      for (const event of pendingEvents) {
        this.publishProcessEvent(record, event);
      }
      registration.activate();
    } catch (error) {
      await this.rollbackFailedFork(record);
      throw error;
    }
    return wireLease;
  }

  private publishProcessEvent(record: HostedProcessLeaseRecord, event: PendingHostedProcessEvent): void {
    if (!record.acceptingEvents) {
      return;
    }
    if (record.terminalEventQueued) {
      this.failProcessWire(
        record,
        new Error(`Extension Host proxy emitted an event after exit for ${record.operationId}`),
      );
      return;
    }
    if (record.pendingDeliveries >= MAX_PENDING_PROXY_EVENT_DELIVERIES) {
      this.failProcessWire(
        record,
        new Error(`Extension Host proxy event delivery queue overflow for ${record.operationId}`),
      );
      return;
    }
    const sequence = record.nextSequence++;
    if (event.kind === 'exit') {
      record.terminalEventQueued = true;
    }
    const envelope = {
      ...event,
      operationId: record.operationId,
      lease: record.wireLease,
      sequence,
    } as ExtHostProxyProcessEventV2;
    record.pendingDeliveries += 1;
    record.delivery = record.delivery
      .then(async () => {
        if (!record.acceptingEvents) {
          return;
        }
        if (!this.extServerProxy.$processEventV2) {
          throw new Error('Extension Host proxy V2 event sink is unavailable');
        }
        await this.extServerProxy.$processEventV2(envelope);
        if (event.kind === 'exit') {
          await this.completeExitedRecord(record);
        }
      })
      .catch((error) => {
        if (record.acceptingEvents) {
          this.failProcessWire(record, error);
        }
      })
      .finally(() => {
        record.pendingDeliveries -= 1;
      });
  }

  private failProcessWire(record: HostedProcessLeaseRecord, error: unknown): void {
    if (!record.acceptingEvents) {
      return;
    }
    record.acceptingEvents = false;
    record.registration.discard();
    if (!this.disposed) {
      this.onProtocolFault(error);
    }
  }

  private async rollbackFailedFork(record: HostedProcessLeaseRecord): Promise<void> {
    record.acceptingEvents = false;
    record.registration.discard();
    this.leaseRecords.delete(record.wireLease.leaseId);
    this.operationOutcomes.delete(record.operationId);
    await this.reclaimRegistration(record.registration);
  }

  private async completeExitedRecord(record: HostedProcessLeaseRecord): Promise<void> {
    if (!record.acceptingEvents) {
      return;
    }
    record.acceptingEvents = false;
    record.registration.discard();
    if (this.leaseRecords.get(record.wireLease.leaseId) === record) {
      this.leaseRecords.delete(record.wireLease.leaseId);
    }
    this.operationOutcomes.delete(record.operationId);
    this.completedOperationOutcomes.delete(record.operationId);
    this.completedOperationOutcomes.set(record.operationId, record.wireLease);
    while (this.completedOperationOutcomes.size > MAX_COMPLETED_PROXY_OPERATIONS) {
      const oldestOperationId = this.completedOperationOutcomes.keys().next().value;
      if (oldestOperationId === undefined) {
        break;
      }
      this.completedOperationOutcomes.delete(oldestOperationId);
    }
    try {
      await this.processLeaseManager.disposeLease(record.registration.lease);
    } catch (error) {
      this.onProtocolFault(error);
    }
  }

  private async reclaimRegistration(registration: ExtensionHostProcessRegistration): Promise<void> {
    try {
      if (await this.processLeaseManager.isRunningLease(registration.lease)) {
        await this.processLeaseManager.treeKillLease(registration.lease);
      }
    } catch (error) {
      this.onProtocolFault(error);
    } finally {
      try {
        await this.processLeaseManager.disposeLease(registration.lease);
      } catch (error) {
        this.onProtocolFault(error);
      }
    }
  }

  private createForkOptions(options: ForkOptions): ForkOptions {
    const configuredHeapLimit = Number(process.env.EXTENSION_HOST_MAX_OLD_SPACE_SIZE);
    const hardHeapLimit =
      Number.isSafeInteger(configuredHeapLimit) && configuredHeapLimit > 0 ? configuredHeapLimit : 256;
    const sourceExecArgv = options.execArgv || process.execArgv;
    const requestedHeapLimit = sourceExecArgv
      .map((argument) => argument.match(/^--max[-_]old[-_]space[-_]size=(\d+)$/)?.[1])
      .filter(Boolean)
      .map(Number)
      .find((value) => Number.isSafeInteger(value) && value > 0);
    const heapLimit = Math.min(requestedHeapLimit || hardHeapLimit, hardHeapLimit);
    const inheritedExecArgv = sourceExecArgv.filter(
      (argument) => !argument.startsWith('--max-old-space-size=') && !argument.startsWith('--max_old_space_size='),
    );
    return {
      ...options,
      execArgv: [...inheritedExecArgv, `--max-old-space-size=${heapLimit}`],
      env: {
        ...process.env,
        ...options.env,
      },
    };
  }

  async $sendLeaseV2(lease: ExtHostProxyProcessLeaseV2, message: string): Promise<void> {
    const record = this.requireLeaseRecord(lease, 'send');
    await this.processLeaseManager.sendLease(record.registration.lease, message);
  }

  async $isRunningLeaseV2(lease: ExtHostProxyProcessLeaseV2): Promise<boolean> {
    const record = this.getLeaseRecord(lease);
    return record ? this.processLeaseManager.isRunningLease(record.registration.lease) : false;
  }

  async $treeKillLeaseV2(lease: ExtHostProxyProcessLeaseV2): Promise<void> {
    const record = this.requireLeaseRecord(lease, 'tree-kill');
    await this.processLeaseManager.treeKillLease(record.registration.lease);
  }

  async $killLeaseV2(lease: ExtHostProxyProcessLeaseV2, signal?: string): Promise<void> {
    const record = this.requireLeaseRecord(lease, 'kill');
    await this.processLeaseManager.killLease(record.registration.lease, signal);
  }

  async $isKilledLeaseV2(lease: ExtHostProxyProcessLeaseV2): Promise<boolean> {
    const record = this.getLeaseRecord(lease);
    return record ? this.processLeaseManager.isKilledLease(record.registration.lease) : true;
  }

  async $disposeLeaseV2(lease: ExtHostProxyProcessLeaseV2): Promise<void> {
    const record = this.getLeaseRecord(lease);
    if (!record) {
      return;
    }
    record.acceptingEvents = false;
    record.registration.discard();
    this.leaseRecords.delete(record.wireLease.leaseId);
    this.operationOutcomes.delete(record.operationId);
    this.completedOperationOutcomes.delete(record.operationId);
    await this.processLeaseManager.disposeLease(record.registration.lease);
  }

  private getLeaseRecord(lease: ExtHostProxyProcessLeaseV2): HostedProcessLeaseRecord | undefined {
    if (
      !lease ||
      lease.proxyInstanceId !== this.proxyInstanceId ||
      lease.managerEpoch !== this.managerEpoch ||
      !Number.isSafeInteger(lease.leaseId) ||
      lease.leaseId <= 0 ||
      !Number.isSafeInteger(lease.pid) ||
      lease.pid <= 0
    ) {
      return undefined;
    }
    const record = this.leaseRecords.get(lease.leaseId);
    if (!record || record.wireLease.pid !== lease.pid) {
      return undefined;
    }
    return record;
  }

  private requireLeaseRecord(lease: ExtHostProxyProcessLeaseV2, operation: string): HostedProcessLeaseRecord {
    const record = this.getLeaseRecord(lease);
    if (!record) {
      const error = new Error(`Cannot ${operation} Extension Host process: stale proxy lease`);
      error.name = 'ExtensionHostProxyProcessLeaseError';
      throw error;
    }
    return record;
  }

  async $send(pid: number, message: string): Promise<void> {
    return this.extensionHostManager.send(pid, message);
  }
  async $isRunning(pid: number): Promise<boolean> {
    return this.extensionHostManager.isRunning(pid);
  }
  async $treeKill(pid: number): Promise<void> {
    return this.extensionHostManager.treeKill(pid);
  }
  async $kill(pid: number, signal?: string | undefined) {
    return this.extensionHostManager.kill(pid, signal);
  }

  async $isKilled(pid: number): Promise<boolean> {
    return this.extensionHostManager.isKilled(pid);
  }

  async $fork(modulePath: string, args: string[] = [], options: ForkOptions = {}) {
    return this.extensionHostManager.fork(modulePath, args, this.createForkOptions(options));
  }

  async $onExit(callId: number, pid: number): Promise<void> {
    this.extensionHostManager.onExit(pid, (code, signal) => this.extServerProxy.$callback(callId, code, signal));
  }

  async $onOutput(callId: number, pid: number): Promise<void> {
    this.extensionHostManager.onOutput(pid, (output) => this.extServerProxy.$callback(callId, output));
  }

  async $findDebugPort(startPort: number, giveUpAfter: number, timeout: number) {
    return this.extensionHostManager.findDebugPort(startPort, giveUpAfter, timeout);
  }

  async $onMessage(callId: number, pid: number): Promise<void> {
    this.extensionHostManager.onMessage(pid, (msg) => this.extServerProxy.$callback(callId, msg));
  }

  async $disposeProcess(pid: number): Promise<void> {
    this.extensionHostManager.disposeProcess(pid);
  }

  async $dispose(): Promise<void> {
    this.disposed = true;
    for (const record of this.leaseRecords.values()) {
      record.acceptingEvents = false;
      record.registration.discard();
    }
    this.leaseRecords.clear();
    this.operationOutcomes.clear();
    this.completedOperationOutcomes.clear();
    await this.processLeaseManager.dispose();
  }
}

export class ExtHostProxy extends Disposable implements IExtHostProxy {
  private readonly proxyInstanceId = randomUUID();

  private nextManagerEpoch = 1;

  private socket: net.Socket;

  private protocol: IRPCProtocol;

  private options: IExtHostProxyOptions;

  private reconnectingTimer: NodeJS.Timeout;

  private extServerProxy: IExtServerProxyRPCService;

  private previouslyDisposer: IDisposable;

  private connectedEmitter = this.registerDispose(new Emitter<void>());

  private readonly logger = getDebugLogger();

  public readonly onConnected = this.connectedEmitter.event;

  LOG_TAG = '[ExtHostProxy]';
  disposer: Disposable;

  private stopping = false;

  constructor(options?: IExtHostProxyOptions) {
    super();
    this.options = {
      retryTime: 1000,
      socketConnectOpts: {
        port: EXT_HOST_PROXY_SERVER_PROT,
      },
      ...options,
    };
  }

  init() {
    this.createSocket();
  }

  private createSocket() {
    if (this.stopping) {
      return;
    }
    if (this.previouslyDisposer) {
      this.previouslyDisposer.dispose();
    }
    this.disposer = new Disposable();

    // 每次断连后重新生成 Socket 实例
    this.socket = new net.Socket();
    this.disposer.addDispose(this.bindEvent());
    this.disposer.addDispose(this.connect());

    this.previouslyDisposer = this.disposer;
  }

  private setRPCMethods() {
    const protocolSocket = this.socket;
    const connection = new NetSocketConnection(protocolSocket);

    this.protocol = new SumiConnectionMultiplexer(connection, {
      logger: this.logger,
      timeout: this.options.rpcMessageTimeout,
    });

    this.disposer.addDispose(connection);

    this.extServerProxy = this.protocol.getProxy(EXT_SERVER_IDENTIFIER);
    const extHostProxyRPCService = new ExtHostProxyRPCService(
      this.extServerProxy,
      this.proxyInstanceId,
      this.nextManagerEpoch++,
      undefined,
      (error) => {
        this.logger.error(this.LOG_TAG, 'process wire fault', error);
        protocolSocket.destroy();
      },
    );
    this.protocol.set(EXT_HOST_PROXY_IDENTIFIER, extHostProxyRPCService);
    this.disposer.addDispose({
      dispose: () => extHostProxyRPCService.$dispose(),
    });
  }

  private reconnectOnEvent = () => {
    if (this.stopping) {
      return;
    }
    clearTimeout(this.reconnectingTimer);
    this.reconnectingTimer = setTimeout(() => {
      this.logger.warn(this.LOG_TAG, 'reconnecting ext host server');
      this.createSocket();
    }, this.options.retryTime!);
  };

  private connectOnEvent = () => {
    this.logger.info(this.LOG_TAG, 'connect success');
    // this.previouslyConnected = true;
    clearTimeout(this.reconnectingTimer);
    this.setRPCMethods();
    this.connectedEmitter.fire();
  };

  private bindEvent(): IDisposable {
    // connect
    this.socket.on('connect', this.connectOnEvent);
    // reconnect
    this.socket.on('end', this.reconnectOnEvent);
    this.socket.on('error', this.reconnectOnEvent);
    this.socket.on('timeout', this.reconnectOnEvent);
    this.socket.on('close', this.reconnectOnEvent);

    return {
      dispose: () => {
        // connect
        this.socket.off('connect', this.connectOnEvent);
        // reconnect
        this.socket.off('end', this.reconnectOnEvent);
        this.socket.off('error', this.reconnectOnEvent);
        this.socket.off('timeout', this.reconnectOnEvent);
        this.socket.off('close', this.reconnectOnEvent);
      },
    };
  }

  private connect = (): IDisposable => {
    this.socket.connect(this.options.socketConnectOpts!);
    return {
      dispose: () => {
        this.socket.destroy();
      },
    };
  };

  override dispose() {
    this.stopping = true;
    clearTimeout(this.reconnectingTimer);
    this.previouslyDisposer?.dispose();
    super.dispose();
  }
}
