import { SumiConnectionMultiplexer } from '@opensumi/ide-connection';
import { SimpleConnection } from '@opensumi/ide-connection/drivers';
import { MethodTimeoutError } from '@opensumi/ide-connection/rpc';
import { Emitter } from '@opensumi/ide-core-common';

import {
  EXT_HOST_PROXY_IDENTIFIER,
  EXT_HOST_PROXY_PROCESS_WIRE_VERSION,
  ExtHostProxyCapabilitiesV2,
  ExtHostProxyProcessEventV2,
  ExtHostProxyProcessLeaseV2,
  IExtHostProxyRPCService,
  IExtensionHostManager,
  Output,
  OutputType,
} from '../../src/common';
import { ExtHostProxyRPCService } from '../../src/hosted/ext.host.proxy-base';
import {
  BufferedExtensionHostProcessRegistration,
  ExtensionHostProcessLeaseError,
  ExtensionHostProcessPendingEventLimit,
  ExtensionHostProcessRegistrationOverflowError,
  IExtensionHostProcessLeaseManager,
  allocateExtensionHostProcessManagerEpoch,
  createExtensionHostProcessLease,
  createExtensionHostProcessLeaseManager,
} from '../../src/node/extension-host-process-manager';
import { ExtensionHostProxyManager } from '../../src/node/extension.host.proxy.manager';

const PROXY_INSTANCE_ID = 'proxy-v2-test';
const REMOTE_MANAGER_EPOCH = 41;

function createCapabilities(): ExtHostProxyCapabilitiesV2 {
  return {
    protocolVersion: EXT_HOST_PROXY_PROCESS_WIRE_VERSION,
    proxyInstanceId: PROXY_INSTANCE_ID,
    managerEpoch: REMOTE_MANAGER_EPOCH,
    features: {
      atomicLifecycle: true,
      processLease: true,
      sequencedProcessEvents: true,
    },
  };
}

function createWireLease(leaseId = 73, pid = 7_073): ExtHostProxyProcessLeaseV2 {
  return {
    proxyInstanceId: PROXY_INSTANCE_ID,
    managerEpoch: REMOTE_MANAGER_EPOCH,
    leaseId,
    pid,
  };
}

function createRPCProxy(overrides: Partial<IExtHostProxyRPCService> = {}): IExtHostProxyRPCService {
  return {
    $dispose: jest.fn(async () => undefined),
    $disposeLeaseV2: jest.fn(async () => undefined),
    $disposeProcess: jest.fn(async () => undefined),
    $findDebugPort: jest.fn(async () => 0),
    $fork: jest.fn(async () => 8_080),
    $forkWithLifecycleV2: jest.fn(async () => createWireLease()),
    $getCapabilities: jest.fn(async () => createCapabilities()),
    $isKilled: jest.fn(async () => false),
    $isKilledLeaseV2: jest.fn(async () => false),
    $isRunning: jest.fn(async () => true),
    $isRunningLeaseV2: jest.fn(async () => true),
    $kill: jest.fn(async () => undefined),
    $killLeaseV2: jest.fn(async () => undefined),
    $onExit: jest.fn(async () => undefined),
    $onMessage: jest.fn(async () => undefined),
    $onOutput: jest.fn(async () => undefined),
    $send: jest.fn(async () => undefined),
    $sendLeaseV2: jest.fn(async () => undefined),
    $treeKill: jest.fn(async () => undefined),
    $treeKillLeaseV2: jest.fn(async () => undefined),
    ...overrides,
  };
}

function createNativeLeaseManager(
  overrides: Partial<IExtensionHostProcessLeaseManager> = {},
): IExtensionHostProcessLeaseManager {
  return {
    dispose: jest.fn(),
    disposeLease: jest.fn(),
    disposeProcess: jest.fn(),
    findDebugPort: jest.fn(async () => 0),
    fork: jest.fn(),
    forkWithLease: jest.fn(),
    init: jest.fn(),
    isKilled: jest.fn(),
    isKilledLease: jest.fn(() => false),
    isRunning: jest.fn(),
    isRunningLease: jest.fn(() => true),
    kill: jest.fn(),
    killLease: jest.fn(),
    onExit: jest.fn(),
    onExitLease: jest.fn(),
    onMessage: jest.fn(),
    onMessageLease: jest.fn(),
    onOutput: jest.fn(),
    onOutputLease: jest.fn(),
    processControlLocation: 'local',
    processLeaseVersion: 1,
    send: jest.fn(),
    sendLease: jest.fn(),
    treeKill: jest.fn(),
    treeKillLease: jest.fn(),
    ...overrides,
  } as unknown as IExtensionHostProcessLeaseManager;
}

function primeManager(proxy: IExtHostProxyRPCService, epoch = 7) {
  const manager = new ExtensionHostProxyManager();
  const protocolDispose = jest.fn();
  const connectionDestroy = jest.fn();
  Object.defineProperties(manager, {
    appConfig: { value: { rpcMessageTimeout: 100 } },
    logger: {
      value: {
        error: jest.fn(),
        log: jest.fn(),
        warn: jest.fn(),
      },
    },
  });
  Object.assign(manager as any, {
    connection: { destroy: connectionDestroy },
    currentLeaseManagerEpoch: allocateExtensionHostProcessManagerEpoch(),
    extHostProxy: proxy,
    extHostProxyProtocol: { dispose: protocolDispose },
    processEpoch: epoch,
    processEpochLost: false,
    protocolMode: 'negotiating',
  });
  const legacyManager = (manager as any).createLegacyManager(epoch, proxy) as IExtensionHostManager;
  (manager as any).legacyLeaseManager = createExtensionHostProcessLeaseManager(legacyManager);
  return { connectionDestroy, manager, protocolDispose };
}

async function settleEvents(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('Extension Host proxy V2 wire', () => {
  it('uses the real multiplexer unknown-method text for the sole V1 downgrade condition', async () => {
    expect.hasAssertions();
    const leftMessages = new Emitter<Uint8Array>();
    const rightMessages = new Emitter<Uint8Array>();
    const left = new SumiConnectionMultiplexer(
      new SimpleConnection({ onMessage: leftMessages.event, send: (message) => rightMessages.fire(message) }),
    );
    const right = new SumiConnectionMultiplexer(
      new SimpleConnection({ onMessage: rightMessages.event, send: (message) => leftMessages.fire(message) }),
    );
    left.set(EXT_HOST_PROXY_IDENTIFIER, {});

    try {
      await expect(right.getProxy(EXT_HOST_PROXY_IDENTIFIER).$getCapabilities!()).rejects.toThrow(
        'Unknown method $getCapabilities on actor EXT_HOST_PROXY_IDENTIFIER',
      );
    } finally {
      left.dispose();
      right.dispose();
      leftMessages.dispose();
      rightMessages.dispose();
    }
  });

  it('forks idempotently and publishes one ordered lifecycle event stream from the hosted proxy', async () => {
    expect.hasAssertions();
    const output: Output = { data: 'booted', format: [], type: OutputType.STDOUT };
    const localLease = createExtensionHostProcessLease(11, 9_011, 19);
    let localRegistration: BufferedExtensionHostProcessRegistration;
    const forkWithLease = jest.fn((_modulePath, _args, _options, observer) => {
      const registration = new BufferedExtensionHostProcessRegistration(localLease, observer);
      localRegistration = registration;
      registration.acceptMessage('ready');
      registration.acceptOutput(output);
      return registration;
    });
    const sendLease = jest.fn();
    const disposeLease = jest.fn();
    const processLeaseManager = createNativeLeaseManager({
      disposeLease,
      forkWithLease,
      sendLease,
    });
    const events: ExtHostProxyProcessEventV2[] = [];
    const service = new ExtHostProxyRPCService(
      {
        $callback: jest.fn(async () => undefined),
        $processEventV2: jest.fn(async (event) => {
          events.push(event);
        }),
      },
      PROXY_INSTANCE_ID,
      REMOTE_MANAGER_EPOCH,
      processLeaseManager,
    );
    const request = { args: [], modulePath: '/extension-host', operationId: 'op-1', options: {} };

    const firstLease = await service.$forkWithLifecycleV2(request);
    const repeatedLease = await service.$forkWithLifecycleV2(request);
    await settleEvents();

    expect(forkWithLease).toHaveBeenCalledTimes(1);
    expect(repeatedLease).toBe(firstLease);
    expect(firstLease).toEqual({
      leaseId: localLease.leaseId,
      managerEpoch: REMOTE_MANAGER_EPOCH,
      pid: localLease.pid,
      proxyInstanceId: PROXY_INSTANCE_ID,
    });
    expect(events.map((event) => [event.sequence, event.kind])).toEqual([
      [0, 'message'],
      [1, 'output'],
    ]);
    expect(events.every((event) => event.operationId === request.operationId && event.lease === firstLease)).toBe(true);

    await service.$sendLeaseV2(firstLease, 'ping');
    expect(sendLease).toHaveBeenCalledWith(localLease, 'ping');
    await expect(service.$sendLeaseV2({ ...firstLease, pid: firstLease.pid + 1 }, 'stale')).rejects.toThrow(
      'stale proxy lease',
    );
    await expect(service.$isRunningLeaseV2({ ...firstLease, leaseId: firstLease.leaseId + 1 })).resolves.toBe(false);
    localRegistration!.acceptExit(0, 'SIGTERM');
    await settleEvents();
    expect(events.map((event) => [event.sequence, event.kind])).toEqual([
      [0, 'message'],
      [1, 'output'],
      [2, 'exit'],
    ]);
    await service.$disposeLeaseV2(firstLease);
    expect(disposeLease).toHaveBeenCalledWith(localLease);
    expect((service as any).leaseRecords.size).toBe(0);
    expect((service as any).operationOutcomes.size).toBe(0);
    expect((service as any).completedOperationOutcomes.size).toBe(1);
    await service.$dispose();
  });

  it('rolls back the hosted process when registration activation overflows', async () => {
    expect.hasAssertions();
    const localLease = createExtensionHostProcessLease(12, 9_012, 20);
    const treeKillLease = jest.fn();
    const disposeLease = jest.fn();
    const processLeaseManager = createNativeLeaseManager({
      disposeLease,
      forkWithLease: jest.fn((_modulePath, _args, _options, observer) => {
        const registration = new BufferedExtensionHostProcessRegistration(localLease, observer);
        for (let index = 0; index <= ExtensionHostProcessPendingEventLimit; index++) {
          registration.acceptMessage(index);
        }
        return registration;
      }),
      treeKillLease,
    });
    const processEvent = jest.fn(async () => undefined);
    const service = new ExtHostProxyRPCService(
      { $callback: jest.fn(async () => undefined), $processEventV2: processEvent },
      PROXY_INSTANCE_ID,
      REMOTE_MANAGER_EPOCH,
      processLeaseManager,
    );

    await expect(
      service.$forkWithLifecycleV2({ args: [], modulePath: '/overflow-host', operationId: 'overflow', options: {} }),
    ).rejects.toBeInstanceOf(ExtensionHostProcessRegistrationOverflowError);
    expect(treeKillLease).toHaveBeenCalledWith(localLease);
    expect(disposeLease).toHaveBeenCalledWith(localLease);
    expect(processEvent).not.toHaveBeenCalled();
    expect((service as any).leaseRecords.size).toBe(0);
    expect((service as any).operationOutcomes.size).toBe(0);
    await service.$dispose();
  });

  it('bounds completed hosted outcomes across many short-lived forks without explicit lease disposal', async () => {
    expect.hasAssertions();
    let nextLeaseId = 1;
    const disposeLease = jest.fn();
    const forkWithLease = jest.fn((_modulePath, _args, _options, observer) => {
      const leaseId = nextLeaseId++;
      const registration = new BufferedExtensionHostProcessRegistration(
        createExtensionHostProcessLease(22, 30_000 + leaseId, leaseId),
        observer,
      );
      registration.acceptExit(0, 'SIGTERM');
      return registration;
    });
    const processLeaseManager = createNativeLeaseManager({ disposeLease, forkWithLease });
    const service = new ExtHostProxyRPCService(
      {
        $callback: jest.fn(async () => undefined),
        $processEventV2: jest.fn(async () => undefined),
      },
      PROXY_INSTANCE_ID,
      REMOTE_MANAGER_EPOCH,
      processLeaseManager,
    );
    const lifecycleCount = 1_100;
    let lastLease: ExtHostProxyProcessLeaseV2 | undefined;

    for (let index = 0; index < lifecycleCount; index++) {
      lastLease = await service.$forkWithLifecycleV2({
        args: [],
        modulePath: '/short-lived-host',
        operationId: `short-${index}`,
        options: {},
      });
    }
    await settleEvents();

    expect(forkWithLease).toHaveBeenCalledTimes(lifecycleCount);
    expect(disposeLease).toHaveBeenCalledTimes(lifecycleCount);
    expect((service as any).leaseRecords.size).toBe(0);
    expect((service as any).operationOutcomes.size).toBe(0);
    expect((service as any).completedOperationOutcomes.size).toBe(1_024);
    await expect(
      service.$forkWithLifecycleV2({
        args: [],
        modulePath: '/short-lived-host',
        operationId: `short-${lifecycleCount - 1}`,
        options: {},
      }),
    ).resolves.toBe(lastLease);
    expect(forkWithLease).toHaveBeenCalledTimes(lifecycleCount);
    await service.$dispose();
  });

  it('stops an already queued hosted event stream after the first reverse delivery fails', async () => {
    expect.hasAssertions();
    const registration = new BufferedExtensionHostProcessRegistration(
      createExtensionHostProcessLease(23, 31_000, 31),
      {},
    );
    const processLeaseManager = createNativeLeaseManager({
      forkWithLease: jest.fn((_modulePath, _args, _options, observer) => {
        const observedRegistration = new BufferedExtensionHostProcessRegistration(registration.lease, observer);
        observedRegistration.acceptMessage('first');
        observedRegistration.acceptMessage('second');
        return observedRegistration;
      }),
    });
    const deliveryError = new Error('reverse delivery failed');
    const processEvent = jest.fn(async () => {
      throw deliveryError;
    });
    const protocolFault = jest.fn();
    const service = new ExtHostProxyRPCService(
      { $callback: jest.fn(async () => undefined), $processEventV2: processEvent },
      PROXY_INSTANCE_ID,
      REMOTE_MANAGER_EPOCH,
      processLeaseManager,
      protocolFault,
    );

    await service.$forkWithLifecycleV2({
      args: [],
      modulePath: '/reverse-failure-host',
      operationId: 'reverse-failure',
      options: {},
    });
    await settleEvents();

    expect(processEvent).toHaveBeenCalledTimes(1);
    expect(protocolFault).toHaveBeenCalledTimes(1);
    expect(protocolFault).toHaveBeenCalledWith(deliveryError);
    await service.$dispose();
  });

  it('buffers V2 events until activation and tombstones the lease when its transport epoch is lost', async () => {
    expect.hasAssertions();
    const epoch = 13;
    const wireLease = createWireLease();
    const state: { manager?: ExtensionHostProxyManager } = {};
    const proxy = createRPCProxy({
      $forkWithLifecycleV2: jest.fn(async (request) => {
        (state.manager as any).acceptProcessEvent(epoch, {
          kind: 'message',
          lease: wireLease,
          message: 'ready',
          operationId: request.operationId,
          sequence: 0,
        });
        return wireLease;
      }),
    });
    const primed = primeManager(proxy, epoch);
    const manager = primed.manager;
    state.manager = manager;
    const onMessage = jest.fn();
    const onExit = jest.fn();
    const losses: unknown[] = [];
    const lossListener = manager.onDidLoseProcessEpoch?.((loss) => losses.push(loss));

    try {
      const registration = await manager.forkWithLease('/extension-host', [], {}, { onExit, onMessage });
      expect(manager.processLeaseProtocolMode).toBe('v2');
      expect(Object.isFrozen(registration.lease)).toBe(true);
      expect(onMessage).not.toHaveBeenCalled();
      registration.activate();
      expect(onMessage).toHaveBeenCalledWith(registration.lease, 'ready');

      await manager.sendLease(registration.lease, 'ping');
      expect(proxy.$sendLeaseV2).toHaveBeenCalledWith(wireLease, 'ping');
      expect(await manager.isRunningLease(registration.lease)).toBe(true);

      const request = (proxy.$forkWithLifecycleV2 as jest.Mock).mock.calls[0][0];
      (manager as any).acceptProcessEvent(epoch, {
        code: 0,
        kind: 'exit',
        lease: wireLease,
        operationId: request.operationId,
        sequence: 1,
        signal: 'SIGTERM',
      });
      expect(onExit).toHaveBeenCalledWith(registration.lease, 0, 'SIGTERM');
      await manager.disposeLease(registration.lease);
      expect(proxy.$disposeLeaseV2).toHaveBeenCalledWith(wireLease);
      expect((manager as any).processLeaseRecords.size).toBe(0);
      expect((manager as any).pendingForks.size).toBe(0);

      (manager as any).loseProcessEpoch(epoch, 'connection-closed');
      expect(manager.processLeaseProtocolMode).toBe('lost');
      expect(losses).toEqual([{ epoch, reason: 'connection-closed' }]);
      expect(await manager.isRunningLease(registration.lease)).toBe(false);
      expect(await manager.isKilledLease(registration.lease)).toBe(true);
      await expect(manager.disposeLease(registration.lease)).resolves.toBeUndefined();
      let mutationError: unknown;
      try {
        manager.sendLease(registration.lease, 'late');
      } catch (error) {
        mutationError = error;
      }
      expect(mutationError).toBeInstanceOf(ExtensionHostProcessLeaseError);
      expect(mutationError).toMatchObject({ reason: 'stale' });
      expect(proxy.$send).not.toHaveBeenCalled();
      expect(proxy.$disposeLeaseV2).toHaveBeenCalledTimes(1);
      expect(primed.protocolDispose).not.toHaveBeenCalled();
      expect(primed.connectionDestroy).not.toHaveBeenCalled();
    } finally {
      lossListener?.dispose();
      await manager.dispose();
    }
  });

  it('bounds retired operation tombstones across many sequential exit and dispose lifecycles', async () => {
    expect.hasAssertions();
    const epoch = 15;
    const requests: Array<{ operationId: string; wireLease: ExtHostProxyProcessLeaseV2 }> = [];
    let nextLeaseId = 1;
    const proxy = createRPCProxy({
      $forkWithLifecycleV2: jest.fn(async (request) => {
        const wireLease = createWireLease(nextLeaseId, 20_000 + nextLeaseId);
        nextLeaseId += 1;
        requests.push({ operationId: request.operationId, wireLease });
        return wireLease;
      }),
    });
    const { manager } = primeManager(proxy, epoch);
    const lifecycleCount = 1_100;

    try {
      for (let index = 0; index < lifecycleCount; index++) {
        const registration = await manager.forkWithLease('/sequential-host', [], {}, {});
        const request = requests[index];
        (manager as any).acceptProcessEvent(epoch, {
          code: 0,
          kind: 'exit',
          lease: request.wireLease,
          operationId: request.operationId,
          sequence: 0,
          signal: 'SIGTERM',
        });
        registration.activate();
        await manager.disposeLease(registration.lease);
      }

      expect(proxy.$getCapabilities).toHaveBeenCalledTimes(1);
      expect(proxy.$forkWithLifecycleV2).toHaveBeenCalledTimes(lifecycleCount);
      expect(proxy.$disposeLeaseV2).toHaveBeenCalledTimes(lifecycleCount);
      expect((manager as any).processLeaseRecords.size).toBe(0);
      expect((manager as any).pendingForks.size).toBe(0);
      expect((manager as any).retiredOperationIds.size).toBe(1_024);
    } finally {
      await manager.dispose();
    }
  });

  it('downgrades once on the exact missing capability method and keeps V1 explicit', async () => {
    expect.hasAssertions();
    const getCapabilities = jest.fn(async () => {
      throw new Error('Unknown method $getCapabilities on actor EXT_HOST_PROXY_IDENTIFIER');
    });
    const proxy = createRPCProxy({ $getCapabilities: getCapabilities });
    const epoch = 7;
    const { manager } = primeManager(proxy, epoch);

    try {
      const registration = await manager.forkWithLease('/legacy-host', [], {}, {});
      expect(manager.processLeaseProtocolMode).toBe('v1');
      expect(getCapabilities).toHaveBeenCalledTimes(1);
      expect(proxy.$fork).toHaveBeenCalledWith('/legacy-host', [], {});
      await manager.sendLease(registration.lease, 'legacy-message');
      expect(proxy.$send).toHaveBeenCalledWith(registration.lease.pid, 'legacy-message');

      await manager.forkWithLease('/second-legacy-host', [], {}, {});
      expect(getCapabilities).toHaveBeenCalledTimes(1);
      expect(proxy.$fork).toHaveBeenCalledTimes(2);

      (manager as any).loseProcessEpoch(epoch, 'connection-closed');
      expect(await manager.isRunningLease(registration.lease)).toBe(false);
      expect(await manager.isKilledLease(registration.lease)).toBe(true);
      let mutationError: unknown;
      try {
        manager.sendLease(registration.lease, 'late-legacy-message');
      } catch (error) {
        mutationError = error;
      }
      expect(mutationError).toMatchObject({ reason: 'stale' });
      expect(proxy.$send).toHaveBeenCalledTimes(1);
    } finally {
      await manager.dispose();
    }
  });

  it('fail-closes the epoch on the real MethodTimeoutError without retrying a V1 fork', async () => {
    expect.hasAssertions();
    const timeout = new MethodTimeoutError('EXT_HOST_PROXY_IDENTIFIER/$forkWithLifecycleV2');
    const proxy = createRPCProxy({
      $forkWithLifecycleV2: jest.fn(async () => {
        throw timeout;
      }),
    });
    const epoch = 17;
    const { connectionDestroy, manager, protocolDispose } = primeManager(proxy, epoch);
    const losses: unknown[] = [];
    const listener = manager.onDidLoseProcessEpoch?.((loss) => losses.push(loss));

    try {
      expect(timeout.name).toBe('Error');
      await expect(manager.forkWithLease('/timed-out-host', [], {}, {})).rejects.toBe(timeout);
      expect(manager.processLeaseProtocolMode).toBe('lost');
      expect(losses).toEqual([{ epoch, reason: 'connection-closed' }]);
      expect(protocolDispose).toHaveBeenCalledTimes(1);
      expect(connectionDestroy).toHaveBeenCalledTimes(1);
      expect(proxy.$forkWithLifecycleV2).toHaveBeenCalledTimes(1);
      expect(proxy.$fork).not.toHaveBeenCalled();
    } finally {
      listener?.dispose();
      await manager.dispose();
    }
  });

  it('fail-closes malformed process event envelopes before lease lookup', async () => {
    expect.hasAssertions();
    const epoch = 19;
    const proxy = createRPCProxy();
    const { connectionDestroy, manager, protocolDispose } = primeManager(proxy, epoch);

    try {
      expect(() =>
        (manager as any).acceptProcessEvent(epoch, {
          kind: 'unknown',
          lease: null,
          operationId: 42,
          sequence: -1,
        }),
      ).toThrow('Malformed Extension Host proxy process event');
      expect(manager.processLeaseProtocolMode).toBe('lost');
      expect(protocolDispose).toHaveBeenCalledTimes(1);
      expect(connectionDestroy).toHaveBeenCalledTimes(1);
    } finally {
      await manager.dispose();
    }
  });
});
