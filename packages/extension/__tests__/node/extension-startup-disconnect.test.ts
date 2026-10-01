import { ExtensionHostRuntimeHandle } from '../../src/node/extension-host-runtime';
import { ExtensionNodeServiceImpl } from '../../src/node/extension.service';

import { createTestProcessLeaseManager, createTestProcessRegistration } from './extension-host-process-test-utils';

import type { ExtensionHostSessionSlot } from '../../src/node/extension-host-session-slot';

function createService() {
  const service = Object.create(ExtensionNodeServiceImpl.prototype) as any;
  const manager = createTestProcessLeaseManager();
  Object.defineProperties(service, {
    appConfig: { value: { extHost: '', extensionHostShutdownTimeout: 0, maxExtProcessCount: 3 } },
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
  service.ensureExtensionHostCapacity = jest.fn().mockResolvedValue(undefined);
  service._createExtServer = jest.fn().mockResolvedValue(undefined);
  service._createExtHostProcess = jest.fn().mockResolvedValue(undefined);
  return { manager, service };
}

function installRuntime(service: any): ExtensionHostRuntimeHandle {
  const handle = new ExtensionHostRuntimeHandle('client', 1, service.extensionHostManager, service.logger);
  handle.attachProcess(createTestProcessRegistration(123));
  Object.assign(service.getSessionSlotRegistry().getOrCreate('client'), { _currentRuntime: handle });
  return handle;
}

describe('ExtensionNodeServiceImpl startup disconnect lifecycle', () => {
  it('preserves a disconnect that arrives while retiring the previous generation for replacement', async () => {
    expect.hasAssertions();
    const { manager, service } = createService();
    const old = installRuntime(service);
    const slot = service.getSessionSlotRegistry().get('client');
    slot.attachFacade({});
    manager.disposeLease.mockImplementation(async () => {
      slot.markDisconnected();
    });

    await expect(service.createProcess('client')).rejects.toMatchObject({
      name: 'ExtensionHostClientDisconnectedError',
    });
    expect(old.phase).toBe('stopped');
    expect(slot.disconnected).toBe(true);
    expect(slot.currentRuntime).toBeUndefined();
    expect(service._createExtHostProcess).not.toHaveBeenCalled();
  });

  it('does not retire a stale generation twice after its slot has been pruned and recreated', async () => {
    expect.hasAssertions();
    const { manager, service } = createService();
    const old = installRuntime(service);
    await service.disposeClientExtProcess('client', false, false);
    expect(service.getSessionSlotRegistry().get('client')).toBeUndefined();
    const replacement = installRuntime(service);

    await service.retireRuntime(old, false, false);
    expect(service.getSessionSlotRegistry().get('client').currentRuntime).toBe(replacement);
    expect(service.extensionHostCounters.disposed).toBe(1);
    expect(manager.disposeLease).toHaveBeenCalledTimes(1);
  });

  it('ignores stale main-thread setup after asynchronous process inspection', async () => {
    expect.hasAssertions();
    const { service } = createService();
    const handle = installRuntime(service);
    const slot = service.getSessionSlotRegistry().get('client');
    const facade = { restartExtProcessByClient: jest.fn() };
    slot.attachFacade(facade);
    handle.connectionReady.resolve({} as any);
    let resolveRunning!: (value: boolean) => void;
    const inspected = new Promise<boolean>((resolve) => {
      resolveRunning = resolve;
    });
    handle.isProcessRunning = jest.fn(() => inspected);
    handle.replaceMainThreadBridge = jest.fn();
    let setup: any;
    service._setMainThreadConnection = (handler: any) => {
      setup = handler;
    };
    service.setExtProcessConnectionForward();
    const channel = {} as any;
    const token = slot.beginMainThreadConnection(channel);
    const pending = setup({ clientId: 'client', slot, token, channel });
    await Promise.resolve();
    expect(handle.isProcessRunning).toHaveBeenCalledTimes(1);
    const current = slot.beginMainThreadConnection({} as any);
    resolveRunning(false);
    await pending;
    expect(facade.restartExtProcessByClient).not.toHaveBeenCalled();
    expect(handle.replaceMainThreadBridge).not.toHaveBeenCalled();
    expect(slot.mainThreadToken).toBe(current);
  });

  it('reports a committed main-thread bridge after asynchronous process inspection finishes', async () => {
    expect.hasAssertions();
    const { service } = createService();
    const handle = installRuntime(service);
    const slot = service.getSessionSlotRegistry().get('client');
    const report = jest.fn();
    service.appConfig.onDidChangeExtensionHostStatus = report;
    const subscribe = () => ({ dispose: jest.fn() });
    handle.attachConnection({ onMessage: subscribe, onceClose: subscribe, send: jest.fn() } as any);
    let resolveRunning!: (value: boolean) => void;
    handle.isProcessRunning = () =>
      new Promise<boolean>((resolve) => {
        resolveRunning = resolve;
      });
    let setup: any;
    service._setMainThreadConnection = (handler: any) => {
      setup = handler;
    };
    service.setExtProcessConnectionForward();
    const channel = { onBinary: subscribe, onceClose: subscribe, sendBinary: jest.fn() } as any;
    const token = slot.beginMainThreadConnection(channel);
    const pending = setup({ clientId: 'client', slot, token, channel });
    await Promise.resolve();
    expect(report).toHaveBeenLastCalledWith(expect.objectContaining({ mainThreadBridges: 0 }));
    resolveRunning(true);
    await pending;
    expect(handle.snapshot().hasMainThreadBridge).toBe(true);
    expect(report).toHaveBeenLastCalledWith(
      expect.objectContaining({ mainThreadConnections: 1, mainThreadBridges: 1 }),
    );
    handle.detachMainThreadBridge();
  });

  it('uses connection facade disposal as the fallback host disconnect signal', () => {
    expect.hasAssertions();
    const { service } = createService();
    installRuntime(service);
    service.closeExtProcessWhenConnectionClose = jest.fn();
    service.setConnectionServiceClient = ExtensionNodeServiceImpl.prototype['setConnectionServiceClient'].bind(service);
    const facade = { connection: 'client' };

    const release = service.registerConnectionServiceClient('client', facade);
    release();

    expect(Boolean(service.getSessionSlotRegistry().get('client')?.facade)).toBe(false);
    expect(Boolean(service.getSessionSlotRegistry().get('client')?.disconnected)).toBe(true);
    expect(service.closeExtProcessWhenConnectionClose).toHaveBeenCalledWith('client');
  });

  it('does not fork a host after the browser disconnects while the IPC server starts', async () => {
    expect.hasAssertions();
    const { service } = createService();
    let createdHandle: ExtensionHostRuntimeHandle | undefined;
    service._createExtServer.mockImplementation(async (handle: ExtensionHostRuntimeHandle) => {
      createdHandle = handle;
      service.getSessionSlotRegistry().getOrCreate(handle.clientId).markDisconnected();
    });

    await expect(service.createProcess('client')).rejects.toMatchObject({
      name: 'ExtensionHostClientDisconnectedError',
    });

    expect(service._createExtHostProcess).not.toHaveBeenCalled();
    expect(createdHandle?.generation).toBe(1);
    expect(createdHandle?.phase).toBe('stopped');
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
  });

  it('disposes the captured runtime whose browser disconnects while fork is in flight', async () => {
    expect.hasAssertions();
    const { manager, service } = createService();
    let createdHandle: ExtensionHostRuntimeHandle | undefined;
    service._createExtHostProcess.mockImplementation(async (handle: ExtensionHostRuntimeHandle) => {
      createdHandle = handle;
      handle.attachProcess(createTestProcessRegistration(123));
      service.getSessionSlotRegistry().getOrCreate(handle.clientId).markDisconnected();
    });

    await expect(service.createProcess('client')).rejects.toMatchObject({
      name: 'ExtensionHostClientDisconnectedError',
    });

    expect(createdHandle?.generation).toBe(1);
    expect(createdHandle?.phase).toBe('stopped');
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
    expect(manager.disposeLease).toHaveBeenCalledWith(expect.objectContaining({ pid: 123 }));
    expect(manager.disposeProcess).not.toHaveBeenCalled();
  });
});
