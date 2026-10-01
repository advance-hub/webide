import { ExtensionHostRuntimeHandle } from '../../src/node/extension-host-runtime';
import { ExtensionNodeServiceImpl } from '../../src/node/extension.service';

import { createTestProcessLeaseManager, createTestProcessRegistration } from './extension-host-process-test-utils';

import type { ExtensionHostSessionSlot } from '../../src/node/extension-host-session-slot';

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createService() {
  const service = Object.create(ExtensionNodeServiceImpl.prototype) as any;
  const manager = createTestProcessLeaseManager();
  Object.defineProperties(service, {
    appConfig: {
      value: {
        extHost: '',
        extensionHostShutdownTimeout: 1_000,
        extensionHostStartupTimeout: 1_000,
        maxExtProcessCount: 3,
        processCloseExitThreshold: 1_000,
      },
    },
    extensionHostManager: { value: manager },
    logger: {
      value: {
        debug: jest.fn(),
        error: jest.fn(),
        log: jest.fn(),
        verbose: jest.fn(),
        warn: jest.fn(),
      },
    },
  });
  service.nextRuntimeGeneration = 1;
  service.extensionHostCreationQueue = Promise.resolve();
  service.servicePhase = 'running';
  service.disposeAllPromise = undefined;
  service.extensionHostCounters = {
    created: 0,
    crashed: 0,
    disposed: 0,
    reclaimed: 0,
    rejected: 0,
    startupTimeouts: 0,
  };
  return { manager, service };
}

function installRuntime(
  service: any,
  clientId = 'client',
  generation = 1,
  processId: number | null = 123,
): ExtensionHostRuntimeHandle {
  const handle = new ExtensionHostRuntimeHandle(clientId, generation, service.extensionHostManager, service.logger);
  if (processId !== null) {
    handle.attachProcess(createTestProcessRegistration(processId, 1, generation));
  }
  Object.assign(service.getSessionSlotRegistry().getOrCreate(clientId), { _currentRuntime: handle });
  return handle;
}

async function flushAsyncWork(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('ExtensionNodeServiceImpl memory lifecycle', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('releases only the facade instance that owns the connection registration', () => {
    expect.hasAssertions();
    const { service } = createService();
    service.setConnectionServiceClient = ExtensionNodeServiceImpl.prototype['setConnectionServiceClient'].bind(service);
    const staleFacade = { connection: 'stale' };
    const currentFacade = { connection: 'current' };

    const releaseStaleFacade = service.registerConnectionServiceClient('client', staleFacade);
    const releaseCurrentFacade = service.registerConnectionServiceClient('client', currentFacade);
    releaseStaleFacade();

    expect(service.getSessionSlotRegistry().get('client')?.facade).toBe(currentFacade);
    releaseCurrentFacade();
    expect(Boolean(service.getSessionSlotRegistry().get('client')?.facade)).toBe(false);
  });

  it('does not treat facade attachment as a transport reconnect', () => {
    expect.hasAssertions();
    const { service } = createService();
    service.setConnectionServiceClient = ExtensionNodeServiceImpl.prototype['setConnectionServiceClient'].bind(service);
    const disconnectTimer = setTimeout(() => undefined, 1_000);
    service.getSessionSlotRegistry().getOrCreate('client').markDisconnected();
    service
      .getSessionSlotRegistry()
      .getOrCreate('client')
      .armDisconnectLease(
        service.getSessionSlotRegistry().getOrCreate('client').markDisconnected(),
        disconnectTimer,
        undefined,
      );

    service.setConnectionServiceClient('client', { connection: 'replacement' });

    expect(Boolean(service.getSessionSlotRegistry().get('client')?.disconnected)).toBe(true);
    expect(service.getSessionSlotRegistry().get('client')?.disconnectLease?.timer).toBe(disconnectTimer);
  });

  it('reclaims the current runtime after its client stays disconnected', async () => {
    expect.hasAssertions();
    const { manager, service } = createService();
    installRuntime(service);
    service.getSessionSlotRegistry().getOrCreate('client').markDisconnected();

    service.closeExtProcessWhenConnectionClose('client');
    await jest.advanceTimersByTimeAsync(1_000);
    await flushAsyncWork();

    expect(
      service
        .getSessionSlotRegistry()
        .values()
        .filter((slot: ExtensionHostSessionSlot) => slot.currentRuntime).length,
    ).toBe(0);
    expect(
      service
        .getSessionSlotRegistry()
        .values()
        .filter((slot: ExtensionHostSessionSlot) => slot.disconnectLease).length,
    ).toBe(0);
    expect(
      service
        .getSessionSlotRegistry()
        .values()
        .filter((slot: ExtensionHostSessionSlot) => slot.disconnected).length,
    ).toBe(0);
    expect(manager.disposeLease).toHaveBeenCalledWith(expect.objectContaining({ pid: 123 }));
  });

  it('cancels a pending runtime disposal when the client reconnects', async () => {
    expect.hasAssertions();
    const { manager, service } = createService();
    const handle = installRuntime(service);
    service.getSessionSlotRegistry().getOrCreate('client').markDisconnected();

    service.closeExtProcessWhenConnectionClose('client');
    service.cancelExtProcessDisposal('client');
    await jest.advanceTimersByTimeAsync(1_000);

    expect(service.getSessionSlotRegistry().get('client')?.currentRuntime).toBe(handle);
    expect(
      service
        .getSessionSlotRegistry()
        .values()
        .filter((slot: ExtensionHostSessionSlot) => slot.disconnectLease).length,
    ).toBe(0);
    expect(manager.disposeLease).not.toHaveBeenCalled();
  });

  it('fences a disconnect timer to the runtime generation it captured', async () => {
    expect.hasAssertions();
    const { manager, service } = createService();
    const staleHandle = installRuntime(service, 'client', 1, 123);
    service.getSessionSlotRegistry().getOrCreate('client').markDisconnected();
    service.closeExtProcessWhenConnectionClose('client');

    const replacement = installRuntime(service, 'client', 2, 456);
    await jest.advanceTimersByTimeAsync(1_000);
    await flushAsyncWork();

    expect(service.getSessionSlotRegistry().get('client')?.currentRuntime).toBe(replacement);
    expect(service.getSessionSlotRegistry().get('client')?.currentRuntime).not.toBe(staleHandle);
    expect(
      service
        .getSessionSlotRegistry()
        .values()
        .filter((slot: ExtensionHostSessionSlot) => slot.disconnectLease).length,
    ).toBe(0);
    expect(manager.disposeLease).not.toHaveBeenCalled();
  });

  it('releases a created generation after disconnect even when it has no process', async () => {
    expect.hasAssertions();
    const { manager, service } = createService();
    installRuntime(service, 'client', 1, null);
    service.getSessionSlotRegistry().getOrCreate('client').markDisconnected();

    service.closeExtProcessWhenConnectionClose('client');
    await jest.advanceTimersByTimeAsync(1_000);
    await flushAsyncWork();

    expect(
      service
        .getSessionSlotRegistry()
        .values()
        .filter((slot: ExtensionHostSessionSlot) => slot.currentRuntime).length,
    ).toBe(0);
    expect(
      service
        .getSessionSlotRegistry()
        .values()
        .filter((slot: ExtensionHostSessionSlot) => slot.disconnected).length,
    ).toBe(0);
    expect(manager.disposeLease).not.toHaveBeenCalled();
  });

  it('bounds the wait for an unresponsive runtime to finish', async () => {
    expect.hasAssertions();
    const { manager, service } = createService();
    manager.isRunningLease.mockResolvedValue(true);
    const handle = installRuntime(service);
    const lease = handle.processLease!;

    const shutdown = service.disposeClientExtProcess('client', false);
    await jest.advanceTimersByTimeAsync(1_000);
    await shutdown;

    expect(manager.sendLease).toHaveBeenCalledWith(lease, 'close');
    expect(manager.treeKillLease).toHaveBeenCalledWith(lease);
    expect(manager.disposeLease).toHaveBeenCalledWith(lease);
    expect(manager.send).not.toHaveBeenCalled();
    expect(manager.treeKill).not.toHaveBeenCalled();
    expect(manager.disposeProcess).not.toHaveBeenCalled();
    expect(
      service
        .getSessionSlotRegistry()
        .values()
        .filter((slot: ExtensionHostSessionSlot) => slot.currentRuntime).length,
    ).toBe(0);
  });

  it('does not let a timed-out generation cleanup delete its replacement', async () => {
    expect.hasAssertions();
    const { service } = createService();
    const staleHandle = installRuntime(service, 'client', 1, 123);
    const stopDeferred = createDeferred<{ hadProcess: boolean; processId: number }>();
    const stop = jest.spyOn(staleHandle, 'stop').mockReturnValue(stopDeferred.promise);

    const readiness = service.ensureProcessReady('client').catch((error: Error) => error);
    jest.advanceTimersByTime(1_000);
    await flushAsyncWork();
    expect(stop).toHaveBeenCalledTimes(1);

    const replacement = installRuntime(service, 'client', 2, 456);
    stopDeferred.resolve({ hadProcess: true, processId: 123 });

    await expect(readiness).resolves.toMatchObject({
      name: 'ExtensionHostStartupTimeoutError',
      message: expect.stringContaining('startup timed out after 1000 ms'),
    });
    expect(service.getSessionSlotRegistry().get('client')?.currentRuntime).toBe(replacement);
    expect(service.extensionHostCounters.startupTimeouts).toBe(1);
  });

  it('does not let a crashed generation cleanup delete its replacement', async () => {
    expect.hasAssertions();
    const { service } = createService();
    const staleHandle = installRuntime(service, 'client', 1, 123);
    const stopDeferred = createDeferred<{ hadProcess: boolean; processId: number }>();
    const stop = jest.spyOn(staleHandle, 'stop').mockReturnValue(stopDeferred.promise);
    expect(staleHandle.markCrashed(staleHandle.processLease!, new Error('old generation crashed'))).toBe(true);

    const cleanup = service.retireRuntime(staleHandle, false, false);
    await flushAsyncWork();
    const replacement = installRuntime(service, 'client', 2, 456);
    stopDeferred.resolve({ hadProcess: true, processId: 123 });
    await cleanup;

    expect(stop).toHaveBeenCalledTimes(1);
    expect(service.getSessionSlotRegistry().get('client')?.currentRuntime).toBe(replacement);
  });

  it('retires a stale Handle by lease without touching a same-PID replacement', async () => {
    expect.hasAssertions();
    const { manager, service } = createService();
    const staleHandle = installRuntime(service, 'client', 1, 123);
    const staleLease = staleHandle.processLease!;
    const replacement = installRuntime(service, 'client', 2, 123);
    const replacementLease = replacement.processLease!;
    manager.isRunningLease.mockImplementation((lease) => lease === replacementLease);

    await service.retireRuntime(staleHandle, false, true);

    expect(manager.isRunningLease).toHaveBeenCalledWith(staleLease);
    expect(manager.sendLease).not.toHaveBeenCalled();
    expect(manager.treeKillLease).not.toHaveBeenCalled();
    expect(manager.disposeLease).toHaveBeenCalledTimes(1);
    expect(manager.disposeLease).toHaveBeenCalledWith(staleLease);
    expect(manager.disposeLease).not.toHaveBeenCalledWith(replacementLease);
    expect(service.getSessionSlotRegistry().get('client')?.currentRuntime).toBe(replacement);
    expect(replacement.phase).toBe('starting');
  });

  it('rejects a new client at capacity without evicting an active runtime', async () => {
    expect.hasAssertions();
    const { manager, service } = createService();
    installRuntime(service, 'first', 1, 123);
    installRuntime(service, 'second', 2, 456);
    installRuntime(service, 'third', 3, 789);
    manager.isRunningLease.mockResolvedValue(true);

    await expect(service.ensureExtensionHostCapacity('fourth')).rejects.toMatchObject({
      name: 'ExtensionHostCapacityError',
    });

    expect(
      service
        .getSessionSlotRegistry()
        .values()
        .filter((slot: ExtensionHostSessionSlot) => slot.currentRuntime).length,
    ).toBe(3);
    expect(manager.disposeLease).not.toHaveBeenCalled();
    expect(manager.isRunningLease).toHaveBeenCalledTimes(3);
  });

  it('reclaims a disconnected runtime before admitting a new client', async () => {
    expect.hasAssertions();
    const { manager, service } = createService();
    installRuntime(service, 'first', 1, 123);
    installRuntime(service, 'second', 2, 456);
    installRuntime(service, 'third', 3, 789);
    service.getSessionSlotRegistry().getOrCreate('first').markDisconnected();

    await service.ensureExtensionHostCapacity('fourth');

    expect(Boolean(service.getSessionSlotRegistry().get('first')?.currentRuntime)).toBe(false);
    expect(
      service
        .getSessionSlotRegistry()
        .values()
        .filter((slot: ExtensionHostSessionSlot) => slot.currentRuntime).length,
    ).toBe(2);
    expect(service.extensionHostCounters.reclaimed).toBe(1);
    expect(manager.disposeLease).toHaveBeenCalledWith(expect.objectContaining({ pid: 123 }));
  });

  it('coalesces concurrent creation requests for the same client', async () => {
    expect.hasAssertions();
    const { service } = createService();
    const finishCreation = createDeferred<void>();
    service.createProcessWithCapacity = jest.fn(() => finishCreation.promise);

    const first = service.createProcess('same-client');
    const second = service.createProcess('same-client');

    expect(first).toBe(second);
    await Promise.resolve();
    expect(service.createProcessWithCapacity).toHaveBeenCalledTimes(1);
    finishCreation.resolve(undefined);
    await first;
    expect(
      service
        .getSessionSlotRegistry()
        .values()
        .filter((slot: ExtensionHostSessionSlot) => slot.creationPromise).length,
    ).toBe(0);
  });

  it('reports bounded runtime capacity without exposing client identifiers', () => {
    expect.hasAssertions();
    const { service } = createService();
    const onDidChangeExtensionHostStatus = jest.fn();
    service.appConfig.onDidChangeExtensionHostStatus = onDidChangeExtensionHostStatus;
    installRuntime(service, 'first', 1, 123);
    installRuntime(service, 'second', 2, 456);
    installRuntime(service, 'third', 3, 789);
    service.getSessionSlotRegistry().getOrCreate('second').markDisconnected();
    service.extensionHostCounters.created = 3;

    service.reportExtensionHostStatus();

    expect(onDidChangeExtensionHostStatus).toHaveBeenCalledWith(
      expect.objectContaining({
        servicePhase: 'running',
        active: 3,
        pendingCreations: 0,
        disconnected: 1,
        clientServiceProxies: 0,
        mainThreadConnections: 0,
        mainThreadBridges: 0,
        limit: 3,
        saturated: true,
        phaseCounts: {
          created: 0,
          listening: 0,
          starting: 3,
          ready: 0,
          stopping: 0,
          stopped: 0,
          failed: 0,
          crashed: 0,
        },
        counters: {
          created: 3,
          crashed: 0,
          disposed: 0,
          reclaimed: 0,
          rejected: 0,
          startupTimeouts: 0,
        },
      }),
    );
    expect(JSON.stringify(onDidChangeExtensionHostStatus.mock.calls[0][0])).not.toContain('second');
  });

  it('aggregates bounded extension activation diagnostics without exposing client identifiers', () => {
    expect.hasAssertions();
    const { service } = createService();
    service.appConfig.extensionHostActivationDiagnostics = true;
    const onDidChangeExtensionHostStatus = jest.fn();
    service.appConfig.onDidChangeExtensionHostStatus = onDidChangeExtensionHostStatus;
    const firstHandle = installRuntime(service, 'client', 1, 123);
    const secondHandle = installRuntime(service, 'second-client', 2, 456);
    const firstSample = {
      extensionId: 'publisher.heavy-extension',
      failed: false,
      durationMs: 25,
      moduleCount: 18,
      subscriptionCount: 7,
      heapUsedBytes: 40_000_000,
      heapUsedDeltaBytes: 5_000_000,
      rssBytes: 70_000_000,
      rssDeltaBytes: 8_000_000,
    };

    service.recordExtensionActivationDiagnostic(firstHandle, firstSample);
    service.recordExtensionActivationDiagnostic(firstHandle, {
      ...firstSample,
      failed: true,
      durationMs: 30,
      heapUsedDeltaBytes: -1_000_000,
    });
    service.recordExtensionActivationDiagnostic(secondHandle, {
      ...firstSample,
      durationMs: 20,
      moduleCount: 20,
    });

    const status = onDidChangeExtensionHostStatus.mock.calls.at(-1)[0];
    expect(status.activationDiagnostics).toEqual({
      reportedHosts: 2,
      topExtensions: [
        {
          extensionId: 'publisher.heavy-extension',
          reportingHosts: 2,
          activationCount: 3,
          failureCount: 1,
          maxActivationDurationMs: 30,
          maxModuleCount: 20,
          maxSubscriptionCount: 7,
          maxObservedHeapUsedBytes: 40_000_000,
          maxObservedRssBytes: 70_000_000,
          maxPositiveHeapUsedDeltaBytes: 5_000_000,
          maxPositiveRssDeltaBytes: 8_000_000,
        },
      ],
    });
    expect(JSON.stringify(status)).not.toContain('second-client');

    const reportsBeforeInvalidSample = onDidChangeExtensionHostStatus.mock.calls.length;
    service.recordExtensionActivationDiagnostic(firstHandle, { ...firstSample, extensionId: '../../invalid' });
    expect(onDidChangeExtensionHostStatus).toHaveBeenCalledTimes(reportsBeforeInvalidSample);
  });

  it('does not retain extension activation diagnostics when diagnostics are disabled', () => {
    expect.hasAssertions();
    const previousSetting = process.env.EXTENSION_HOST_ACTIVATION_DIAGNOSTICS;
    delete process.env.EXTENSION_HOST_ACTIVATION_DIAGNOSTICS;
    try {
      const { service } = createService();
      const onDidChangeExtensionHostStatus = jest.fn();
      service.appConfig.onDidChangeExtensionHostStatus = onDidChangeExtensionHostStatus;
      const handle = installRuntime(service);

      service.recordExtensionActivationDiagnostic(handle, {
        extensionId: 'publisher.extension',
        failed: false,
        durationMs: 25,
        moduleCount: 18,
        subscriptionCount: 7,
        heapUsedBytes: 40_000_000,
        heapUsedDeltaBytes: 5_000_000,
        rssBytes: 70_000_000,
        rssDeltaBytes: 8_000_000,
      });

      expect(handle.activationDiagnostics.size).toBe(0);
      expect(onDidChangeExtensionHostStatus).not.toHaveBeenCalled();
    } finally {
      if (previousSetting === undefined) {
        delete process.env.EXTENSION_HOST_ACTIVATION_DIAGNOSTICS;
      } else {
        process.env.EXTENSION_HOST_ACTIVATION_DIAGNOSTICS = previousSetting;
      }
    }
  });

  it('releases the runtime handle without owning the connection facade lifecycle', async () => {
    expect.hasAssertions();
    const { manager, service } = createService();
    const handle = installRuntime(service);
    handle.setInspectPort(handle.processLease!, 9_889);
    service.getIPCHandlerPath = jest.fn().mockResolvedValue('/tmp/main-thread-test.sock');
    await service.getElectronMainThreadListenPath('client');
    const facade = { connected: true };
    service.getSessionSlotRegistry().getOrCreate('client').attachFacade(facade);
    service.getSessionSlotRegistry().getOrCreate('client').markDisconnected();

    await service.disposeClientExtProcess('client', false);

    expect(
      service
        .getSessionSlotRegistry()
        .values()
        .filter((slot: ExtensionHostSessionSlot) => slot.currentRuntime).length,
    ).toBe(0);
    expect(service.sessionSlots.size).toBe(1);
    expect(service.getSessionSlotRegistry().get('client')?.facade).toBe(facade);
    expect(
      service
        .getSessionSlotRegistry()
        .values()
        .filter((slot: ExtensionHostSessionSlot) => slot.disconnected).length,
    ).toBe(1);
    expect(manager.disposeLease).toHaveBeenCalledWith(handle.processLease);
  });

  it('coalesces concurrent client disposal onto one runtime retirement', async () => {
    expect.hasAssertions();
    const { service } = createService();
    const handle = installRuntime(service);
    const stopDeferred = createDeferred<{ hadProcess: boolean; processId: number }>();
    const stop = jest.spyOn(handle, 'stop').mockReturnValue(stopDeferred.promise);

    const first = service.disposeClientExtProcess('client', false);
    const second = service.disposeClientExtProcess('client', false);
    await flushAsyncWork();

    expect(stop).toHaveBeenCalledTimes(1);
    stopDeferred.resolve({ hadProcess: true, processId: 123 });
    await Promise.all([first, second]);

    expect(
      service
        .getSessionSlotRegistry()
        .values()
        .filter((slot: ExtensionHostSessionSlot) => slot.currentRuntime).length,
    ).toBe(0);
    expect(service.extensionHostCounters.disposed).toBe(1);
  });

  it('disposes tracked runtimes before the host manager shuts down', async () => {
    expect.hasAssertions();
    const { manager, service } = createService();
    installRuntime(service, 'first', 1, 123);
    installRuntime(service, 'second', 2, 456);
    service.getSessionSlotRegistry().getOrCreate('first').attachFacade({ connected: true });
    service.getSessionSlotRegistry().getOrCreate('second').attachFacade({ connected: true });

    await service.disposeAllClientExtProcess();

    expect(manager.disposeLease).toHaveBeenCalledWith(expect.objectContaining({ pid: 123 }));
    expect(manager.disposeLease).toHaveBeenCalledWith(expect.objectContaining({ pid: 456 }));
    expect(Math.max(...manager.disposeLease.mock.invocationCallOrder)).toBeLessThan(
      manager.dispose.mock.invocationCallOrder[0],
    );
    expect(
      service
        .getSessionSlotRegistry()
        .values()
        .filter((slot: ExtensionHostSessionSlot) => slot.currentRuntime).length,
    ).toBe(0);
    expect(
      service
        .getSessionSlotRegistry()
        .values()
        .filter((slot: ExtensionHostSessionSlot) => slot.facade).length,
    ).toBe(0);
    expect(manager.dispose).toHaveBeenCalledTimes(1);
  });

  it('closes admission and waits for an in-flight creation before disposing all runtimes', async () => {
    expect.hasAssertions();
    const { manager, service } = createService();
    const pendingCreation = createDeferred<void>();
    const trackedCreation = pendingCreation.promise;
    service
      .getSessionSlotRegistry()
      .getOrCreate('creating-client')
      .runCreation(() => trackedCreation);

    const firstDisposal = service.disposeAllClientExtProcess();
    const secondDisposal = service.disposeAllClientExtProcess();
    let admissionError: Error | undefined;
    try {
      service.createProcess('late-client');
    } catch (error) {
      admissionError = error as Error;
    }

    expect(service.servicePhase).toBe('draining');
    expect(admissionError).toMatchObject({ name: 'ExtensionHostServiceDrainingError' });
    expect(manager.dispose).not.toHaveBeenCalled();

    installRuntime(service, 'creating-client', 1, 321);
    pendingCreation.resolve(undefined);
    await Promise.all([firstDisposal, secondDisposal]);

    expect(manager.disposeLease).toHaveBeenCalledWith(expect.objectContaining({ pid: 321 }));
    expect(manager.dispose).toHaveBeenCalledTimes(1);
    expect(
      service
        .getSessionSlotRegistry()
        .values()
        .filter((slot: ExtensionHostSessionSlot) => slot.currentRuntime).length,
    ).toBe(0);
    expect(
      service
        .getSessionSlotRegistry()
        .values()
        .filter((slot: ExtensionHostSessionSlot) => slot.creationPromise).length,
    ).toBe(0);
    expect(service.servicePhase).toBe('disposed');
  });

  it('contains a rejected browser notification during runtime cleanup', async () => {
    expect.hasAssertions();
    const { service } = createService();
    const notificationError = new Error('connection already closed');
    const infoProcessNotExist = jest.fn().mockRejectedValue(notificationError);
    service.getSessionSlotRegistry().getOrCreate('client').attachFacade({ infoProcessNotExist });

    await service.infoProcessNotExist('client');

    expect(infoProcessNotExist).toHaveBeenCalledTimes(1);
    expect(Boolean(service.getSessionSlotRegistry().get('client')?.facade)).toBe(true);
    expect(service.logger.warn).toHaveBeenCalledWith(
      'Notify missing extension host failed for client',
      notificationError,
    );
  });

  it('keeps the browser service proxy across a host-only restart', async () => {
    expect.hasAssertions();
    const { service } = createService();
    const facade = { connected: true };
    service.getSessionSlotRegistry().getOrCreate('client').attachFacade(facade);
    installRuntime(service);

    await service.disposeClientExtProcess('client', false);

    expect(
      service
        .getSessionSlotRegistry()
        .values()
        .filter((slot: ExtensionHostSessionSlot) => slot.currentRuntime).length,
    ).toBe(0);
    expect(service.getSessionSlotRegistry().get('client')?.facade).toBe(facade);
    expect(
      service
        .getSessionSlotRegistry()
        .values()
        .filter((slot: ExtensionHostSessionSlot) => slot.disconnected).length,
    ).toBe(0);
  });

  it('uses the latest disconnect state when the browser closes during runtime shutdown', async () => {
    expect.hasAssertions();
    const { service } = createService();
    const facade = { connected: true };
    service.getSessionSlotRegistry().getOrCreate('client').attachFacade(facade);
    const handle = installRuntime(service);
    const stopDeferred = createDeferred<{ hadProcess: boolean; processId: number }>();
    jest.spyOn(handle, 'stop').mockReturnValue(stopDeferred.promise);

    const disposal = service.disposeClientExtProcess('client', false);
    await flushAsyncWork();
    service.getSessionSlotRegistry().getOrCreate('client').markDisconnected();
    stopDeferred.resolve({ hadProcess: true, processId: 123 });
    await disposal;

    expect(service.getSessionSlotRegistry().get('client')?.facade).toBe(facade);
    expect(
      service
        .getSessionSlotRegistry()
        .values()
        .filter((slot: ExtensionHostSessionSlot) => slot.disconnected).length,
    ).toBe(1);
    expect(
      service
        .getSessionSlotRegistry()
        .values()
        .filter((slot: ExtensionHostSessionSlot) => slot.currentRuntime).length,
    ).toBe(0);
  });

  it('contains rejected crash and reconnect notifications', async () => {
    expect.hasAssertions();
    const { service } = createService();
    const crashError = new Error('crash notification disconnected');
    const reconnectError = new Error('reconnect notification disconnected');
    const infoProcessCrash = jest.fn().mockRejectedValue(crashError);
    const restartExtProcessByClient = jest.fn().mockRejectedValue(reconnectError);
    service
      .getSessionSlotRegistry()
      .getOrCreate('client')
      .attachFacade({ infoProcessCrash, restartExtProcessByClient });

    await service.infoProcessCrash('client');
    await service.restartExtProcessByClient('client');

    expect(infoProcessCrash).toHaveBeenCalledTimes(1);
    expect(restartExtProcessByClient).toHaveBeenCalledTimes(1);
    expect(service.logger.warn).toHaveBeenCalledWith('Extension host crash notification failed for client', crashError);
    expect(service.logger.warn).toHaveBeenCalledWith(
      'Restart missing extension host notification failed for client',
      reconnectError,
    );
  });
});
