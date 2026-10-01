import cp from 'child_process';
import { EventEmitter } from 'events';
import path from 'path';
import { PassThrough } from 'stream';

import { Emitter } from '@opensumi/ide-core-common';

import { ExtensionHostProcessEpochLoss, IExtensionHostManager } from '../../src';
import {
  ExtensionHostProcessLeaseError,
  ExtensionHostProcessPendingEventLimit,
  ExtensionHostProcessRegistrationOverflowError,
  createExtensionHostProcessLeaseManager,
} from '../../src/node/extension-host-process-manager';
import { ExtensionHostManager } from '../../src/node/extension.host.manager';

import { extensionHostManagerTester } from './extension.host.manager.common-tester';

extensionHostManagerTester({
  name: 'ext host manager',
  providers: [
    {
      token: IExtensionHostManager,
      useClass: ExtensionHostManager,
    },
  ],
  init: () => {
    // noop
  },
  dispose: () => {
    // noop
  },
});

describe('ExtensionHostManager resource cleanup', () => {
  it('refuses to fork beyond the managed process hard limit', async () => {
    expect.hasAssertions();
    const manager = new ExtensionHostManager();
    const extHostPath = path.join(__dirname, '../../__mocks__/ext.host.js');
    (manager as any).maxProcessCount = 1;
    manager.fork(extHostPath, [], { silent: true });

    expect(() => manager.fork(extHostPath, [], { silent: true })).toThrow(
      'Managed extension child process limit (1) reached',
    );
    expect((manager as any).processMap.size).toBe(1);
    await manager.dispose();
  });

  it('drops process and listener references after a child exits', async () => {
    expect.hasAssertions();
    const manager = new ExtensionHostManager();
    const extHostPath = path.join(__dirname, '../../__mocks__/ext.host.js');
    const pid = manager.fork(extHostPath, [], { silent: true });
    manager.onOutput(pid, () => undefined);
    manager.onMessage(pid, () => undefined);
    const exited = new Promise<void>((resolve) => manager.onExit(pid, () => resolve()));

    manager.kill(pid, 'SIGTERM');
    await exited;

    expect((manager as any).processMap.size).toBe(0);
    expect((manager as any).processDisposables.size).toBe(0);
    await manager.dispose();
  });

  it('closes fork admission and disposes each process only once', async () => {
    expect.hasAssertions();
    const manager = new ExtensionHostManager();
    const extHostPath = path.join(__dirname, '../../__mocks__/ext.host.js');
    const pid = manager.fork(extHostPath, [], { silent: true });
    const treeKill = jest.spyOn(manager, 'treeKill');

    const firstDisposal = manager.dispose();
    const secondDisposal = manager.dispose();

    expect(secondDisposal).toBe(firstDisposal);
    expect(() => manager.fork(extHostPath, [], { silent: true })).toThrow(
      'Extension host manager is draining and does not accept new processes',
    );

    await firstDisposal;
    expect(treeKill).toHaveBeenCalledTimes(1);
    expect(treeKill).toHaveBeenCalledWith(pid);
    expect(manager.dispose()).toBe(firstDisposal);
    expect((manager as any).processMap.size).toBe(0);
  });

  it('attaches lifecycle observers before forkWithLifecycle returns', async () => {
    expect.hasAssertions();
    const manager = new ExtensionHostManager();
    const fakeProcess = new EventEmitter() as any;
    fakeProcess.pid = 404_101;
    fakeProcess.stdout = new PassThrough();
    fakeProcess.stderr = new PassThrough();
    fakeProcess.kill = jest.fn();
    const fork = jest.spyOn(cp, 'fork').mockReturnValue(fakeProcess);
    const onMessage = jest.fn();
    const onOutput = jest.fn();
    const onExit = jest.fn();

    try {
      const pid = manager.forkWithLifecycle(
        '/observed-extension-host',
        [],
        { silent: true },
        {
          onMessage,
          onOutput,
          onExit,
        },
      );

      expect(pid).toBe(fakeProcess.pid);
      expect(fakeProcess.listenerCount('message')).toBe(1);
      expect(fakeProcess.stdout.listenerCount('data')).toBeGreaterThan(0);
      expect(fakeProcess.stderr.listenerCount('data')).toBeGreaterThan(0);

      fakeProcess.emit('message', 'ready');
      fakeProcess.emit('exit', 0, 'SIGTERM');
      expect(onMessage).toHaveBeenCalledWith(fakeProcess.pid, 'ready');
      expect(onExit).toHaveBeenCalledWith(fakeProcess.pid, 0, 'SIGTERM');
      expect((manager as any).processMap.size).toBe(0);
      expect((manager as any).processDisposables.size).toBe(0);
    } finally {
      fork.mockRestore();
      await manager.dispose();
    }
  });

  it('does not let a late exit from an older child release a same-PID replacement', async () => {
    expect.hasAssertions();
    const manager = new ExtensionHostManager();
    const pid = 414_141;
    const createProcess = () => {
      const process = new EventEmitter() as any;
      process.pid = pid;
      process.stdout = new PassThrough();
      process.stderr = new PassThrough();
      process.kill = jest.fn();
      return process;
    };
    const firstProcess = createProcess();
    const replacementProcess = createProcess();
    const fork = jest.spyOn(cp, 'fork').mockReturnValueOnce(firstProcess).mockReturnValueOnce(replacementProcess);

    try {
      expect(manager.fork('/first-extension-host')).toBe(pid);
      expect(manager.fork('/replacement-extension-host')).toBe(pid);
      expect((manager as any).processMap.get(pid)).toBe(replacementProcess);

      firstProcess.emit('exit', 0, 'SIGTERM');
      expect((manager as any).processMap.get(pid)).toBe(replacementProcess);
      expect((manager as any).processMap.size).toBe(1);

      replacementProcess.emit('exit', 0, 'SIGTERM');
      expect((manager as any).processMap.size).toBe(0);
      expect((manager as any).processDisposables.size).toBe(0);
    } finally {
      fork.mockRestore();
      await manager.dispose();
    }
  });

  it('waits for a fork admitted before draining and reclaims its late child', async () => {
    expect.hasAssertions();
    const manager = new ExtensionHostManager();
    const pid = 424_242;
    let disposal: Promise<void> | undefined;
    const fakeProcess = {
      pid,
      once: jest.fn(),
    } as any;
    const fork = jest.spyOn(cp, 'fork').mockImplementation(() => {
      disposal = manager.dispose();
      return fakeProcess;
    });
    const isRunning = jest.spyOn(manager, 'isRunning').mockReturnValue(true);
    const treeKill = jest.spyOn(manager, 'treeKill').mockResolvedValue(undefined);

    expect(manager.fork('/late-extension-host')).toBe(pid);
    expect(disposal).toBeDefined();
    expect(() => manager.fork('/rejected-extension-host')).toThrow(
      'Extension host manager is draining and does not accept new processes',
    );

    await disposal;
    expect(fork).toHaveBeenCalledTimes(1);
    expect(isRunning).toHaveBeenCalledWith(pid);
    expect(treeKill).toHaveBeenCalledTimes(1);
    expect(treeKill).toHaveBeenCalledWith(pid);
    expect((manager as any).processMap.size).toBe(0);
    expect((manager as any).processDisposables.size).toBe(0);
  });

  it('issues an immutable lease and buffers lifecycle events until registration activation', async () => {
    expect.hasAssertions();
    const manager = new ExtensionHostManager();
    const fakeProcess = new EventEmitter() as any;
    fakeProcess.pid = 434_343;
    fakeProcess.stdout = new PassThrough();
    fakeProcess.stderr = new PassThrough();
    fakeProcess.kill = jest.fn();
    const fork = jest.spyOn(cp, 'fork').mockReturnValue(fakeProcess);
    const onMessage = jest.fn();
    const onExit = jest.fn();

    try {
      const registration = manager.forkWithLease('/leased-extension-host', [], { silent: true }, { onExit, onMessage });
      expect(Object.isFrozen(registration.lease)).toBe(true);
      expect(registration.lease).toEqual({
        managerEpoch: expect.any(Number),
        pid: fakeProcess.pid,
        leaseId: expect.any(Number),
      });

      fakeProcess.emit('message', 'ready');
      fakeProcess.emit('exit', 0, 'SIGTERM');
      expect(onMessage).not.toHaveBeenCalled();
      expect(onExit).not.toHaveBeenCalled();

      registration.activate();
      expect(onMessage).toHaveBeenCalledWith(registration.lease, 'ready');
      expect(onExit).toHaveBeenCalledWith(registration.lease, 0, 'SIGTERM');
      expect((manager as any).processRecords.size).toBe(0);
    } finally {
      fork.mockRestore();
      await manager.dispose();
    }
  });

  it('discards only buffered publication and leaves process cleanup explicit', async () => {
    expect.hasAssertions();
    const manager = new ExtensionHostManager();
    const fakeProcess = new EventEmitter() as any;
    fakeProcess.pid = 444_444;
    fakeProcess.stdout = new PassThrough();
    fakeProcess.stderr = new PassThrough();
    fakeProcess.kill = jest.fn();
    const fork = jest.spyOn(cp, 'fork').mockReturnValue(fakeProcess);
    jest.spyOn(manager, 'isRunning').mockReturnValue(true);
    const onMessage = jest.fn();

    try {
      const registration = manager.forkWithLease('/discarded-extension-host', [], { silent: true }, { onMessage });
      fakeProcess.emit('message', 'ready');
      registration.discard();
      registration.activate();
      fakeProcess.emit('message', 'late');

      expect(onMessage).not.toHaveBeenCalled();
      expect(fakeProcess.kill).not.toHaveBeenCalled();
      expect(manager.isRunningLease(registration.lease)).toBe(true);

      manager.disposeLease(registration.lease);
      expect(fakeProcess.kill).toHaveBeenCalledTimes(1);
      expect((manager as any).processRecords.size).toBe(0);
    } finally {
      fork.mockRestore();
      await manager.dispose();
    }
  });

  it('rejects stale same-PID mutations without touching the replacement lease', async () => {
    expect.hasAssertions();
    const manager = new ExtensionHostManager();
    const pid = 454_545;
    const createProcess = () => {
      const process = new EventEmitter() as any;
      process.pid = pid;
      process.stdout = new PassThrough();
      process.stderr = new PassThrough();
      process.kill = jest.fn();
      process.send = jest.fn((_message, callback) => callback?.());
      return process;
    };
    const firstProcess = createProcess();
    const replacementProcess = createProcess();
    const fork = jest.spyOn(cp, 'fork').mockReturnValueOnce(firstProcess).mockReturnValueOnce(replacementProcess);
    const treeKill = jest.spyOn(manager, 'treeKill').mockResolvedValue(undefined);
    jest.spyOn(manager, 'isRunning').mockReturnValue(true);

    try {
      const first = manager.forkWithLease('/first-leased-host', [], { silent: true }, {});
      manager.onMessageLease(first.lease, () => undefined);
      const replacement = manager.forkWithLease('/replacement-leased-host', [], { silent: true }, {});

      expect(first.lease.pid).toBe(replacement.lease.pid);
      expect(first.lease.leaseId).not.toBe(replacement.lease.leaseId);
      expect(manager.isRunningLease(first.lease)).toBe(false);
      expect(manager.isKilledLease(first.lease)).toBe(true);
      expect(() => manager.sendLease(first.lease, 'close')).toThrow(ExtensionHostProcessLeaseError);
      expect(() => manager.treeKillLease(first.lease)).toThrow(ExtensionHostProcessLeaseError);
      expect(() => manager.killLease(first.lease)).toThrow(ExtensionHostProcessLeaseError);
      expect(() => manager.onMessageLease(first.lease, () => undefined)).toThrow(ExtensionHostProcessLeaseError);

      expect(() => manager.disposeLease(first.lease)).not.toThrow();
      expect(replacementProcess.kill).not.toHaveBeenCalled();
      expect(treeKill).not.toHaveBeenCalled();

      await manager.sendLease(replacement.lease, 'current');
      expect(replacementProcess.send).toHaveBeenCalledWith('current', expect.any(Function));
      expect(firstProcess.listenerCount('message')).toBe(0);
      firstProcess.emit('exit', 0, 'SIGTERM');
      expect(firstProcess.listenerCount('message')).toBe(0);
      expect((manager as any).processMap.get(pid)).toBe(replacementProcess);

      manager.disposeLease(replacement.lease);
      expect(replacementProcess.kill).toHaveBeenCalledTimes(1);
    } finally {
      fork.mockRestore();
      await manager.dispose();
    }
  });

  it('rejects cloned leases and returns one stable adapter for a legacy manager', async () => {
    expect.hasAssertions();
    let messageListener: ((message: unknown) => void) | undefined;
    const legacyManager = {
      dispose: jest.fn().mockResolvedValue(undefined),
      disposeProcess: jest.fn(),
      findDebugPort: jest.fn(),
      fork: jest.fn().mockResolvedValue(464_646),
      init: jest.fn(),
      isKilled: jest.fn().mockReturnValue(false),
      isRunning: jest.fn().mockReturnValue(true),
      kill: jest.fn(),
      onExit: jest.fn(),
      onMessage: jest.fn((_pid, listener) => {
        messageListener = listener;
      }),
      onOutput: jest.fn(),
      send: jest.fn(),
      treeKill: jest.fn(),
    } as unknown as IExtensionHostManager;
    const firstAdapter = createExtensionHostProcessLeaseManager(legacyManager);
    const secondAdapter = createExtensionHostProcessLeaseManager(legacyManager);
    const onMessage = jest.fn();

    const registration = await firstAdapter.forkWithLease('/legacy-host', [], {}, { onMessage });
    const clonedLease = { ...registration.lease };
    messageListener?.('ready');

    expect(secondAdapter).toBe(firstAdapter);
    expect(Object.isFrozen(registration.lease)).toBe(true);
    expect(onMessage).not.toHaveBeenCalled();
    registration.activate();
    expect(onMessage).toHaveBeenCalledWith(registration.lease, 'ready');
    expect(() => firstAdapter.sendLease(clonedLease, 'close')).toThrow(ExtensionHostProcessLeaseError);
    expect(() => firstAdapter.disposeLease(clonedLease)).toThrow(ExtensionHostProcessLeaseError);

    await firstAdapter.disposeLease(registration.lease);
    expect(legacyManager.disposeProcess).toHaveBeenCalledWith(registration.lease.pid);
    await firstAdapter.dispose();
  });

  it('does not let a legacy-adapter lease rebind to a same-PID replacement', async () => {
    expect.hasAssertions();
    const pid = 474_747;
    const messageListeners: Array<(message: unknown) => void> = [];
    const legacyManager = {
      dispose: jest.fn().mockResolvedValue(undefined),
      disposeProcess: jest.fn(),
      findDebugPort: jest.fn(),
      fork: jest.fn().mockResolvedValue(pid),
      init: jest.fn(),
      isKilled: jest.fn().mockReturnValue(false),
      isRunning: jest.fn().mockReturnValue(true),
      kill: jest.fn(),
      onExit: jest.fn(),
      onMessage: jest.fn((_pid, listener) => messageListeners.push(listener)),
      onOutput: jest.fn(),
      send: jest.fn(),
      treeKill: jest.fn(),
    } as unknown as IExtensionHostManager;
    const adapter = createExtensionHostProcessLeaseManager(legacyManager);
    const firstOnMessage = jest.fn();
    const first = await adapter.forkWithLease('/first-legacy-host', [], {}, { onMessage: firstOnMessage });
    first.activate();
    const replacement = await adapter.forkWithLease('/replacement-legacy-host', [], {}, {});

    expect(first.lease.pid).toBe(replacement.lease.pid);
    expect(first.lease.leaseId).not.toBe(replacement.lease.leaseId);
    expect(adapter.isRunningLease(first.lease)).toBe(false);
    expect(adapter.isKilledLease(first.lease)).toBe(true);
    expect(() => adapter.sendLease(first.lease, 'close')).toThrow(ExtensionHostProcessLeaseError);
    expect(() => adapter.treeKillLease(first.lease)).toThrow(ExtensionHostProcessLeaseError);
    expect(() => adapter.killLease(first.lease)).toThrow(ExtensionHostProcessLeaseError);
    expect(() => adapter.onExitLease(first.lease, () => undefined)).toThrow(ExtensionHostProcessLeaseError);
    expect(() => adapter.disposeLease(first.lease)).not.toThrow();
    expect(legacyManager.disposeProcess).not.toHaveBeenCalled();
    messageListeners[0]('replacement-message');
    expect(firstOnMessage).not.toHaveBeenCalled();

    await adapter.sendLease(replacement.lease, 'current');
    expect(legacyManager.send).toHaveBeenCalledWith(pid, 'current');
    await adapter.disposeLease(replacement.lease);
    expect(legacyManager.disposeProcess).toHaveBeenCalledWith(pid);
    await adapter.dispose();
  });

  it('fails activation after the bounded pre-activation event buffer overflows', async () => {
    expect.hasAssertions();
    const manager = new ExtensionHostManager();
    const fakeProcess = new EventEmitter() as any;
    fakeProcess.pid = 484_848;
    fakeProcess.stdout = new PassThrough();
    fakeProcess.stderr = new PassThrough();
    fakeProcess.kill = jest.fn();
    const fork = jest.spyOn(cp, 'fork').mockReturnValue(fakeProcess);
    const onMessage = jest.fn();

    try {
      const registration = manager.forkWithLease('/overflowing-extension-host', [], { silent: true }, { onMessage });
      for (let index = 0; index <= ExtensionHostProcessPendingEventLimit; index++) {
        fakeProcess.emit('message', index);
      }

      expect(onMessage).not.toHaveBeenCalled();
      expect(() => registration.activate()).toThrow(ExtensionHostProcessRegistrationOverflowError);
      expect(() => registration.activate()).not.toThrow();
      expect(onMessage).not.toHaveBeenCalled();

      manager.disposeLease(registration.lease);
      expect(fakeProcess.kill).toHaveBeenCalledTimes(1);
    } finally {
      fork.mockRestore();
      await manager.dispose();
    }
  });

  it('invalidates legacy-adapter leases before publishing manager epoch loss', async () => {
    expect.hasAssertions();
    const pid = 494_949;
    const epochLossEmitter = new Emitter<ExtensionHostProcessEpochLoss>();
    const legacyManager = {
      dispose: jest.fn().mockResolvedValue(undefined),
      disposeProcess: jest.fn(),
      findDebugPort: jest.fn(),
      fork: jest.fn().mockResolvedValue(pid),
      init: jest.fn(),
      isKilled: jest.fn().mockReturnValue(false),
      isRunning: jest.fn().mockReturnValue(true),
      kill: jest.fn(),
      onDidLoseProcessEpoch: epochLossEmitter.event,
      onExit: jest.fn(),
      onMessage: jest.fn(),
      onOutput: jest.fn(),
      send: jest.fn(),
      treeKill: jest.fn(),
    } as unknown as IExtensionHostManager;
    const adapter = createExtensionHostProcessLeaseManager(legacyManager);
    const oldRegistration = await adapter.forkWithLease('/old-epoch-host', [], {}, {});
    const observedLeaseState = jest.fn(() => adapter.isRunningLease(oldRegistration.lease));
    const listener = adapter.onDidLoseProcessEpoch!(observedLeaseState);

    epochLossEmitter.fire({ epoch: 7, reason: 'connection-replaced' });

    expect(observedLeaseState).toHaveBeenCalledTimes(1);
    expect(observedLeaseState).toHaveReturnedWith(false);
    expect(() => adapter.disposeLease(oldRegistration.lease)).not.toThrow();
    expect(legacyManager.disposeProcess).not.toHaveBeenCalled();

    const replacement = await adapter.forkWithLease('/new-epoch-host', [], {}, {});
    await adapter.disposeLease(oldRegistration.lease);
    expect(legacyManager.disposeProcess).not.toHaveBeenCalled();
    await adapter.disposeLease(replacement.lease);
    expect(legacyManager.disposeProcess).toHaveBeenCalledWith(pid);

    listener.dispose();
    await adapter.dispose();
    epochLossEmitter.dispose();
  });

  it('does not publish a legacy-adapter lease when its fork crosses an epoch loss', async () => {
    expect.hasAssertions();
    const pid = 505_050;
    const epochLossEmitter = new Emitter<ExtensionHostProcessEpochLoss>();
    let resolveFork: (pid: number) => void = () => undefined;
    const forkResult = new Promise<number>((resolve) => {
      resolveFork = resolve;
    });
    const legacyManager = {
      dispose: jest.fn().mockResolvedValue(undefined),
      disposeProcess: jest.fn(),
      findDebugPort: jest.fn(),
      fork: jest.fn().mockReturnValue(forkResult),
      init: jest.fn(),
      isKilled: jest.fn().mockReturnValue(false),
      isRunning: jest.fn().mockReturnValue(true),
      kill: jest.fn(),
      onDidLoseProcessEpoch: epochLossEmitter.event,
      onExit: jest.fn(),
      onMessage: jest.fn(),
      onOutput: jest.fn(),
      send: jest.fn(),
      treeKill: jest.fn(),
    } as unknown as IExtensionHostManager;
    const adapter = createExtensionHostProcessLeaseManager(legacyManager);
    const pendingRegistration = adapter.forkWithLease('/cross-epoch-host', [], {}, {});

    epochLossEmitter.fire({ epoch: 8, reason: 'connection-closed' });
    resolveFork(pid);

    await expect(pendingRegistration).rejects.toMatchObject({
      code: 'EXTENSION_HOST_PROCESS_LEASE_INVALID',
      reason: 'stale',
    });
    expect(legacyManager.onMessage).not.toHaveBeenCalled();
    expect(legacyManager.disposeProcess).not.toHaveBeenCalled();

    await adapter.dispose();
    epochLossEmitter.dispose();
  });
});
