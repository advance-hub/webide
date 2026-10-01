import { Emitter } from '@opensumi/ide-core-common';

import { OutputType } from '../../src/common';
import {
  ExtensionHostProcessLeaseObserver,
  ExtensionHostProcessRegistrationOverflowError,
} from '../../src/node/extension-host-process-manager';
import { ExtensionHostRuntimeHandle } from '../../src/node/extension-host-runtime';
import { ExtensionNodeServiceImpl } from '../../src/node/extension.service';

import { createTestProcessLeaseManager, createTestProcessRegistration } from './extension-host-process-test-utils';

import type { ExtensionHostSessionSlot } from '../../src/node/extension-host-session-slot';

function createLogger() {
  return {
    debug: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
    verbose: jest.fn(),
    warn: jest.fn(),
  };
}

function createService() {
  const service = Object.create(ExtensionNodeServiceImpl.prototype) as any;
  const manager = createTestProcessLeaseManager();
  Object.defineProperties(service, {
    appConfig: {
      value: {
        extHost: '/test/extension-host',
        extensionHostShutdownTimeout: 100,
        extensionHostStartupTimeout: 1_000,
        maxExtProcessCount: 3,
      },
    },
    extensionHostManager: { value: manager },
    logger: { value: createLogger() },
    reporter: { value: { performance: jest.fn(), point: jest.fn() } },
    reporterService: {
      value: {
        point: jest.fn(),
        time: jest.fn(() => ({ timeEnd: jest.fn(() => 1) })),
      },
    },
  });
  service.onDidSetInspectPort = new Emitter<void>();
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

function expectLegacyPidOperationsUnused(manager: ReturnType<typeof createTestProcessLeaseManager>): void {
  expect(manager.fork).not.toHaveBeenCalled();
  expect(manager.send).not.toHaveBeenCalled();
  expect(manager.isRunning).not.toHaveBeenCalled();
  expect(manager.treeKill).not.toHaveBeenCalled();
  expect(manager.kill).not.toHaveBeenCalled();
  expect(manager.isKilled).not.toHaveBeenCalled();
  expect(manager.onOutput).not.toHaveBeenCalled();
  expect(manager.onExit).not.toHaveBeenCalled();
  expect(manager.onMessage).not.toHaveBeenCalled();
  expect(manager.disposeProcess).not.toHaveBeenCalled();
}

describe('ExtensionNodeServiceImpl local process lease path', () => {
  it('creates, readies, inspects, and stops a runtime while every legacy PID operation throws', async () => {
    expect.hasAssertions();
    const { manager, service } = createService();
    const registration = createTestProcessRegistration(515_151, 7, 11);
    let observer: ExtensionHostProcessLeaseObserver | undefined;
    manager.isRunningLease.mockResolvedValue(true);
    manager.findDebugPort.mockResolvedValue(9_889);
    manager.forkWithLease.mockImplementation((_modulePath, _args, _options, nextObserver) => {
      observer = nextObserver;
      registration.activate.mockImplementation(() => {
        observer?.onMessage?.(registration.lease, 'ready');
        observer?.onOutput?.(registration.lease, {
          type: OutputType.STDOUT,
          data: 'Debugger listening on ws://127.0.0.1:9555/runtime-id',
          format: [],
        });
      });
      return registration;
    });

    const handle = new ExtensionHostRuntimeHandle('client', 1, manager, service.logger);
    handle.setListenOptions({ path: '/tmp/opensumi-extension-host-lease-test.sock' });
    handle.attachConnection({
      destroy: jest.fn(),
      dispose: jest.fn(),
      onMessage: jest.fn(() => ({ dispose: jest.fn() })),
      onceClose: jest.fn(() => ({ dispose: jest.fn() })),
      send: jest.fn(),
    });
    Object.assign(service.getSessionSlotRegistry().getOrCreate('client'), { _currentRuntime: handle });

    await service._createExtHostProcess(handle);
    await expect(service.ensureProcessReady('client')).resolves.toBe(true);
    await expect(service.getProcessInspectPort('client')).resolves.toBe(9_555);
    expect(await service.getExtProcessId('client')).toBe(registration.lease.pid);

    expect(handle.markFinished(registration.lease)).toBe(true);
    await service.disposeClientExtProcess('client', false, true);

    expect(registration.activate).toHaveBeenCalledTimes(1);
    expect(registration.discard).not.toHaveBeenCalled();
    expect(manager.forkWithLease).toHaveBeenCalledTimes(1);
    expect(manager.isRunningLease).toHaveBeenCalledWith(registration.lease);
    expect(manager.sendLease).toHaveBeenCalledWith(registration.lease, 'close');
    expect(manager.treeKillLease).toHaveBeenCalledWith(registration.lease);
    expect(manager.disposeLease).toHaveBeenCalledWith(registration.lease);
    expectLegacyPidOperationsUnused(manager);
    expect(
      service
        .getSessionSlotRegistry()
        .values()
        .filter((slot: ExtensionHostSessionSlot) => slot.currentRuntime).length,
    ).toBe(0);
  });

  it('reclaims the exact lease when registration activation overflows before publication', async () => {
    expect.hasAssertions();
    const { manager, service } = createService();
    const registration = createTestProcessRegistration(616_161, 8, 12);
    const overflowError = new ExtensionHostProcessRegistrationOverflowError(registration.lease);
    registration.activate.mockImplementation(() => {
      throw overflowError;
    });
    manager.forkWithLease.mockReturnValue(registration);
    manager.isRunningLease.mockResolvedValue(true);
    manager.findDebugPort.mockResolvedValue(9_889);
    service._createExtServer = jest.fn(async (handle: ExtensionHostRuntimeHandle) => {
      handle.setListenOptions({ path: '/tmp/opensumi-extension-host-overflow-test.sock' });
    });

    await expect(service.createProcess('overflow-client')).rejects.toBe(overflowError);

    expect(registration.activate).toHaveBeenCalledTimes(1);
    expect(manager.forkWithLease).toHaveBeenCalledTimes(1);
    expect(manager.isRunningLease).toHaveBeenCalledWith(registration.lease);
    expect(manager.sendLease).toHaveBeenCalledWith(registration.lease, 'close');
    expect(manager.treeKillLease).toHaveBeenCalledWith(registration.lease);
    expect(manager.disposeLease).toHaveBeenCalledTimes(1);
    expect(manager.disposeLease).toHaveBeenCalledWith(registration.lease);
    expect(manager.isRunningLease.mock.calls.every(([lease]) => lease === registration.lease)).toBe(true);
    expectLegacyPidOperationsUnused(manager);
    expect(
      service
        .getSessionSlotRegistry()
        .values()
        .filter((slot: ExtensionHostSessionSlot) => slot.currentRuntime).length,
    ).toBe(0);
    expect(service.extensionHostCounters.disposed).toBe(1);
  });

  it('enables the inspector through the exact lease on non-Windows hosts', async () => {
    expect.hasAssertions();
    const { manager, service } = createService();
    const registration = createTestProcessRegistration(717_171, 9, 13);
    const handle = new ExtensionHostRuntimeHandle('inspect-client', 1, manager, service.logger);
    handle.attachProcess(registration);
    Object.assign(service.getSessionSlotRegistry().getOrCreate('inspect-client'), { _currentRuntime: handle });
    manager.isRunningLease.mockResolvedValue(true);
    manager.killLease.mockImplementation((lease, signal) => {
      expect(lease).toBe(registration.lease);
      expect(signal).toBe('SIGUSR1');
      setImmediate(() => {
        handle.setInspectPort(registration.lease, 9_666);
        service.onDidSetInspectPort.fire();
      });
      return Promise.resolve();
    });

    await expect(service.tryEnableInspectPort('inspect-client', 100)).resolves.toBe(true);

    expect(manager.isRunningLease).toHaveBeenCalledWith(registration.lease);
    expect(manager.killLease).toHaveBeenCalledTimes(1);
    expect(manager.killLease).toHaveBeenCalledWith(registration.lease, 'SIGUSR1');
    expect(manager.kill).not.toHaveBeenCalled();
    expect(handle.inspectPort).toBe(9_666);
  });
});
