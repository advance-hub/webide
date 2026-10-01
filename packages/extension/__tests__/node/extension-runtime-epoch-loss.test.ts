import { Emitter } from '@opensumi/ide-core-common';

import { ExtensionHostProcessEpochLoss } from '../../src/common';
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

function createManager() {
  const epochLossEmitter = new Emitter<ExtensionHostProcessEpochLoss>();
  const manager = {
    ...createTestProcessLeaseManager(),
    onDidLoseProcessEpoch: epochLossEmitter.event,
  };
  return { epochLossEmitter, manager };
}

function createService() {
  const service = Object.create(ExtensionNodeServiceImpl.prototype) as any;
  const { epochLossEmitter, manager } = createManager();
  const logger = {
    debug: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
    verbose: jest.fn(),
    warn: jest.fn(),
  };
  Object.defineProperties(service, {
    appConfig: {
      value: {
        extensionHostShutdownTimeout: 0,
        maxExtProcessCount: 3,
        processCloseExitThreshold: 1_000,
      },
    },
    extensionHostManager: { value: manager },
    logger: { value: logger },
  });
  service.nextRuntimeGeneration = 1;
  service.extensionHostCreationQueue = Promise.resolve();
  service.servicePhase = 'running';
  service.disposeAllPromise = undefined;
  service.managerEpochLossDisposable = undefined;
  service.extensionHostCounters = {
    created: 0,
    crashed: 0,
    disposed: 0,
    reclaimed: 0,
    rejected: 0,
    startupTimeouts: 0,
  };
  service.setExtProcessConnectionForward = jest.fn();
  service.reportExtensionHostStatus = jest.fn();
  return { epochLossEmitter, logger, manager, service };
}

function installRuntime(service: any, clientId: string, generation: number, processId: number) {
  const runtime = new ExtensionHostRuntimeHandle(clientId, generation, service.extensionHostManager, service.logger);
  runtime.attachProcess(createTestProcessRegistration(processId, 1, generation));
  Object.assign(service.getSessionSlotRegistry().getOrCreate(clientId), { _currentRuntime: runtime });
  return runtime;
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  throw new Error('Timed out waiting for Extension Host epoch-loss cleanup');
}

describe('ExtensionNodeServiceImpl manager process epoch loss', () => {
  it('subscribes during initialize and retires exactly the runtimes present at epoch loss', async () => {
    expect.hasAssertions();
    const { epochLossEmitter, logger, manager, service } = createService();
    const firstClient = { infoProcessCrash: jest.fn().mockResolvedValue(undefined) };
    const secondClient = { infoProcessCrash: jest.fn().mockResolvedValue(undefined) };

    await service.initialize();
    installRuntime(service, 'first', 1, 101);
    installRuntime(service, 'second', 2, 202);
    service.getSessionSlotRegistry().getOrCreate('first').attachFacade(firstClient);
    service.getSessionSlotRegistry().getOrCreate('second').attachFacade(secondClient);

    epochLossEmitter.fire({ epoch: 7, reason: 'connection-closed' });
    await waitFor(
      () =>
        service
          .getSessionSlotRegistry()
          .values()
          .filter((slot: ExtensionHostSessionSlot) => slot.currentRuntime).length === 0,
    );

    expect(manager.init).toHaveBeenCalledTimes(1);
    expect(service.setExtProcessConnectionForward).toHaveBeenCalledTimes(1);
    expect(service.extensionHostCounters.crashed).toBe(2);
    expect(service.extensionHostCounters.disposed).toBe(2);
    expect(manager.disposeLease).toHaveBeenCalledTimes(2);
    expect(manager.disposeLease).toHaveBeenCalledWith(expect.objectContaining({ pid: 101 }));
    expect(manager.disposeLease).toHaveBeenCalledWith(expect.objectContaining({ pid: 202 }));
    expect(manager.disposeProcess).not.toHaveBeenCalled();
    expect(firstClient.infoProcessCrash).toHaveBeenCalledTimes(1);
    expect(secondClient.infoProcessCrash).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(
      'Extension Host manager process epoch 7 was lost (connection-closed); retiring 2 runtime(s)',
    );

    await service.disposeAllClientExtProcess();
  });

  it('does not count or retire a stopping runtime twice', async () => {
    expect.hasAssertions();
    const { epochLossEmitter, manager, service } = createService();
    const client = { infoProcessCrash: jest.fn().mockResolvedValue(undefined) };
    const running = createDeferred<boolean>();
    service.appConfig.extensionHostShutdownTimeout = 1_000;
    manager.isRunningLease.mockReturnValueOnce(running.promise);

    await service.initialize();
    const runtime = installRuntime(service, 'stopping', 1, 303);
    service.getSessionSlotRegistry().getOrCreate('stopping').attachFacade(client);
    const retirement = service.disposeClientExtProcess('stopping', false, false);
    expect(runtime.phase).toBe('stopping');

    epochLossEmitter.fire({ epoch: 8, reason: 'connection-replaced' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(service.extensionHostCounters.crashed).toBe(0);
    expect(service.extensionHostCounters.disposed).toBe(0);

    running.resolve(false);
    await retirement;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(
      service
        .getSessionSlotRegistry()
        .values()
        .filter((slot: ExtensionHostSessionSlot) => slot.currentRuntime).length,
    ).toBe(0);
    expect(service.extensionHostCounters.crashed).toBe(0);
    expect(service.extensionHostCounters.disposed).toBe(1);
    expect(manager.disposeLease).toHaveBeenCalledTimes(1);
    expect(manager.disposeLease).toHaveBeenCalledWith(runtime.processLease);
    expect(manager.disposeProcess).not.toHaveBeenCalled();
    expect(client.infoProcessCrash).not.toHaveBeenCalled();

    await service.disposeAllClientExtProcess();
  });

  it('unsubscribes before manager disposal so a late epoch loss cannot re-enter the service', async () => {
    expect.hasAssertions();
    const { epochLossEmitter, manager, service } = createService();
    const epochLossHandler = jest.spyOn(service, 'handleManagerProcessEpochLoss');

    await service.initialize();
    expect(service.managerEpochLossDisposable).toBeDefined();
    await service.disposeAllClientExtProcess();
    expect(service.managerEpochLossDisposable).toBeUndefined();
    expect(service.servicePhase).toBe('disposed');

    epochLossEmitter.fire({ epoch: 9, reason: 'connection-closed' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(epochLossHandler).not.toHaveBeenCalled();
    expect(manager.dispose).toHaveBeenCalledTimes(1);
    expect(service.extensionHostCounters.crashed).toBe(0);
    expect(service.extensionHostCounters.disposed).toBe(0);
  });
});
