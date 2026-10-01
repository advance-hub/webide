import { ExtensionHostRuntimeHandle } from '../../src/node/extension-host-runtime';

import { createTestProcessLeaseManager, createTestProcessRegistration } from './extension-host-process-test-utils';

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function createLogger() {
  return {
    debug: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
    verbose: jest.fn(),
    warn: jest.fn(),
  };
}

function createEventHarness<T extends (...args: any[]) => void>() {
  const listeners = new Set<T>();
  const listenerDisposers: Array<jest.Mock<void, []>> = [];
  const subscribe = jest.fn((listener: T) => {
    listeners.add(listener);
    const dispose = jest.fn(() => listeners.delete(listener));
    listenerDisposers.push(dispose);
    return { dispose };
  });
  const emit = (...args: Parameters<T>) => {
    [...listeners].forEach((listener) => listener(...args));
  };
  return { emit, listenerDisposers, listeners, subscribe };
}

function createConnectionHarness() {
  const messages = createEventHarness<(data: Uint8Array) => void>();
  const closes = createEventHarness<(code?: number, reason?: string) => void>();
  return {
    closes,
    connection: {
      destroy: jest.fn(),
      dispose: jest.fn(),
      onMessage: messages.subscribe,
      onceClose: closes.subscribe,
      send: jest.fn(),
    } as any,
    messages,
  };
}

function createChannelHarness() {
  const binary = createEventHarness<(data: Uint8Array) => void>();
  const closes = createEventHarness<(code?: number, reason?: string) => void>();
  return {
    binary,
    channel: {
      onBinary: binary.subscribe,
      onceClose: closes.subscribe,
      sendBinary: jest.fn(),
    } as any,
    closes,
  };
}

function createRuntime(generation = 1) {
  const manager = createTestProcessLeaseManager();
  const logger = createLogger();
  const runtime = new ExtensionHostRuntimeHandle('client', generation, manager, logger as any);
  return { logger, manager, runtime };
}

describe('ExtensionHostRuntimeHandle', () => {
  it('becomes ready only after child ready, IPC connection, and a live process agree', async () => {
    expect.hasAssertions();
    const { manager, runtime } = createRuntime();
    const alive = createDeferred<boolean>();
    manager.isRunningLease.mockReturnValue(alive.promise);
    const connection = createConnectionHarness();
    const registration = createTestProcessRegistration(101);
    runtime.attachProcess(registration);

    let settled = false;
    const readiness = runtime.whenReady(1_000).finally(() => {
      settled = true;
    });
    expect(registration.activate).toHaveBeenCalledTimes(1);
    expect(runtime.markChildReady(registration.lease)).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(manager.isRunningLease).not.toHaveBeenCalled();

    expect(runtime.attachConnection(connection.connection)).toBe(true);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(manager.isRunningLease).toHaveBeenCalledWith(registration.lease);
    expect(settled).toBe(false);
    expect(runtime.phase).toBe('starting');

    alive.resolve(true);
    await readiness;
    expect(runtime.phase).toBe('ready');
  });

  it('ignores a late child-ready signal after stop has started', async () => {
    expect.hasAssertions();
    const { manager, runtime } = createRuntime();
    manager.isRunningLease.mockReturnValue(false);
    const registration = createTestProcessRegistration(102);
    runtime.attachProcess(registration);

    const stopping = runtime.stop({ gracefulTimeoutMs: 0, killProcess: true });
    expect(runtime.phase).toBe('stopping');
    expect(runtime.markChildReady(registration.lease)).toBe(false);

    await stopping;
    expect(runtime.phase).toBe('stopped');
    expect(runtime.markChildReady(registration.lease)).toBe(false);
    expect(manager.sendLease).not.toHaveBeenCalled();
  });

  it('coalesces concurrent stop calls and releases process ownership at most once', async () => {
    expect.hasAssertions();
    const { manager, runtime } = createRuntime();
    manager.isRunningLease.mockReturnValue(true);
    const registration = createTestProcessRegistration(103);
    runtime.attachProcess(registration);
    runtime.markFinished(registration.lease);

    const first = runtime.stop({ gracefulTimeoutMs: 1_000, killProcess: true });
    const second = runtime.stop({ gracefulTimeoutMs: 1_000, killProcess: true });

    expect(second).toBe(first);
    await first;
    expect(manager.sendLease).toHaveBeenCalledTimes(1);
    expect(manager.sendLease).toHaveBeenCalledWith(registration.lease, 'close');
    expect(manager.treeKillLease).toHaveBeenCalledTimes(1);
    expect(manager.treeKillLease).toHaveBeenCalledWith(registration.lease);
    expect(manager.disposeLease).toHaveBeenCalledTimes(1);
    expect(manager.disposeLease).toHaveBeenCalledWith(registration.lease);
    expect(manager.send).not.toHaveBeenCalled();
    expect(manager.isRunning).not.toHaveBeenCalled();
    expect(manager.treeKill).not.toHaveBeenCalled();
    expect(manager.disposeProcess).not.toHaveBeenCalled();
    expect(runtime.phase).toBe('stopped');
  });

  it('retires generation-owned resources before sending process shutdown', async () => {
    expect.hasAssertions();
    const { manager, runtime } = createRuntime();
    const order: string[] = [];
    const registration = createTestProcessRegistration(108);
    manager.isRunningLease.mockImplementation(async () => {
      order.push('process-running');
      return true;
    });
    manager.sendLease.mockImplementation(async () => {
      order.push('process-close');
    });
    manager.treeKillLease.mockImplementation(async () => {
      order.push('process-kill');
    });
    const ownedResource = {
      retire: jest.fn(async () => {
        order.push('profiler-retire');
      }),
    };
    runtime.attachProcess(registration);
    runtime.markFinished(registration.lease);

    expect(runtime.attachOwnedResource('profiler', ownedResource)).toBe(true);
    await runtime.stop({ gracefulTimeoutMs: 1_000, killProcess: true });

    expect(ownedResource.retire).toHaveBeenCalledWith(expect.any(Number), 'runtime-retire');
    expect(order).toEqual(['profiler-retire', 'process-running', 'process-close', 'process-running', 'process-kill']);
  });

  it.each(['isRunningLease', 'sendLease', 'treeKillLease', 'disposeLease'] as const)(
    'settles stop at the shared deadline when manager.%s never settles',
    async (operation) => {
      jest.useFakeTimers();
      try {
        const { logger, manager, runtime } = createRuntime();
        const pending = createDeferred<never>();
        const registration = createTestProcessRegistration(109);
        runtime.attachProcess(registration);
        if (operation === 'isRunningLease') {
          manager.isRunningLease.mockReturnValue(pending.promise);
        } else if (operation === 'sendLease') {
          manager.isRunningLease.mockReturnValue(true);
          manager.sendLease.mockReturnValue(pending.promise);
        } else if (operation === 'treeKillLease') {
          manager.isRunningLease.mockReturnValue(true);
          manager.treeKillLease.mockReturnValue(pending.promise);
          runtime.markFinished(registration.lease);
        } else {
          manager.isRunningLease.mockReturnValue(false);
          manager.disposeLease.mockReturnValue(pending.promise);
        }

        const stopping = runtime.stop({ gracefulTimeoutMs: 50, killProcess: true });
        await jest.advanceTimersByTimeAsync(50);
        await expect(stopping).resolves.toMatchObject({ hadProcess: true, processId: 109 });

        expect(manager[operation]).toHaveBeenCalled();
        expect(runtime.phase).toBe('stopped');
        if (operation === 'treeKillLease') {
          expect(manager.disposeLease).not.toHaveBeenCalled();
        }
        pending.reject(new Error(`late ${operation} rejection`));
        await jest.advanceTimersByTimeAsync(0);
        if (operation === 'treeKillLease') {
          expect(manager.disposeLease).toHaveBeenCalledTimes(1);
          expect(manager.disposeLease).toHaveBeenCalledWith(registration.lease);
        }
        expect(logger.warn).toHaveBeenCalled();
      } finally {
        jest.useRealTimers();
      }
    },
  );

  it('contains a manager PromiseLike with a throwing then getter during stop', async () => {
    const { logger, manager, runtime } = createRuntime();
    const registration = createTestProcessRegistration(110);
    const brokenThenable = Object.defineProperty({}, 'then', {
      get() {
        throw new Error('broken manager then getter');
      },
    });
    runtime.attachProcess(registration);
    manager.isRunningLease.mockReturnValue(false);
    manager.disposeLease.mockReturnValue(brokenThenable as any);

    await expect(runtime.stop({ gracefulTimeoutMs: 100, killProcess: true })).resolves.toMatchObject({
      hadProcess: true,
      processId: 110,
    });

    expect(runtime.phase).toBe('stopped');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('releasing the process lease'),
      expect.objectContaining({ message: 'broken manager then getter' }),
    );
  });

  it('keeps same-PID replacement ownership isolated from a stale Handle stop', async () => {
    expect.hasAssertions();
    const manager = createTestProcessLeaseManager();
    const logger = createLogger();
    const staleRuntime = new ExtensionHostRuntimeHandle('client', 1, manager, logger as any);
    const replacementRuntime = new ExtensionHostRuntimeHandle('client', 2, manager, logger as any);
    const staleRegistration = createTestProcessRegistration(104, 1, 1);
    const replacementRegistration = createTestProcessRegistration(104, 1, 2);
    staleRuntime.attachProcess(staleRegistration);
    replacementRuntime.attachProcess(replacementRegistration);
    manager.isRunningLease.mockImplementation((lease) => lease === replacementRegistration.lease);

    await staleRuntime.stop({ gracefulTimeoutMs: 0, killProcess: true });

    expect(manager.isRunningLease).toHaveBeenCalledWith(staleRegistration.lease);
    expect(manager.sendLease).not.toHaveBeenCalled();
    expect(manager.treeKillLease).not.toHaveBeenCalled();
    expect(manager.disposeLease).toHaveBeenCalledTimes(1);
    expect(manager.disposeLease).toHaveBeenCalledWith(staleRegistration.lease);
    expect(manager.disposeLease).not.toHaveBeenCalledWith(replacementRegistration.lease);
    expect(replacementRuntime.processLease).toBe(replacementRegistration.lease);
    expect(replacementRuntime.phase).toBe('starting');
    expect(replacementRegistration.discard).not.toHaveBeenCalled();
  });

  it('rejects and destroys a second IPC connection', () => {
    expect.hasAssertions();
    const { runtime } = createRuntime();
    const first = createConnectionHarness();
    const second = createConnectionHarness();

    expect(runtime.attachConnection(first.connection)).toBe(true);
    expect(runtime.attachConnection(second.connection)).toBe(false);
    expect(second.connection.dispose).toHaveBeenCalledTimes(1);
    expect(second.connection.destroy).toHaveBeenCalledTimes(1);
    expect(first.connection.dispose).not.toHaveBeenCalled();
    expect(first.connection.destroy).not.toHaveBeenCalled();
    expect(runtime.connection).toBe(first.connection);
  });

  it.each(['extension-host connection', 'main-thread channel'] as const)(
    'releases both bridge directions when the %s closes',
    (closingSide) => {
      expect.hasAssertions();
      const { runtime } = createRuntime();
      const connection = createConnectionHarness();
      const channel = createChannelHarness();
      runtime.attachConnection(connection.connection);

      expect(runtime.replaceMainThreadBridge(channel.channel)).toBe(true);
      expect(connection.messages.listeners.size).toBe(1);
      expect(channel.binary.listeners.size).toBe(1);

      if (closingSide === 'extension-host connection') {
        connection.closes.emit();
      } else {
        channel.closes.emit();
      }

      expect(connection.messages.listeners.size).toBe(0);
      expect(channel.binary.listeners.size).toBe(0);
      expect(connection.messages.listenerDisposers[0]).toHaveBeenCalledTimes(1);
      expect(channel.binary.listenerDisposers[0]).toHaveBeenCalledTimes(1);
      expect(runtime.snapshot().hasMainThreadBridge).toBe(false);
    },
  );

  it('returns one generation-consistent runtime snapshot', async () => {
    expect.hasAssertions();
    const { manager, runtime } = createRuntime(7);
    const connection = createConnectionHarness();
    const channel = createChannelHarness();
    manager.isRunningLease.mockReturnValue(true);
    const registration = createTestProcessRegistration(107);

    runtime.attachProcess(registration);
    runtime.setInspectPort(registration.lease, 9_007);
    runtime.attachConnection(connection.connection);
    runtime.markChildReady(registration.lease);
    await runtime.whenReady(1_000);
    runtime.replaceMainThreadBridge(channel.channel);

    expect(runtime.snapshot()).toEqual({
      clientId: 'client',
      generation: 7,
      phase: 'ready',
      processId: 107,
      inspectPort: 9_007,
      hasConnection: true,
      hasMainThreadBridge: true,
    });
  });
});
