import { Injector } from '@opensumi/di';
import { INodeLogger } from '@opensumi/ide-core-node';

import {
  DefaultExtensionHostProfilerTargetSource,
  ExtensionHostProfilerCoordinator,
  ExtensionHostProfilerTarget,
} from '../../src/node/extension-host-profiler-coordinator';

import type { ExtensionHostRuntimeOwnedResource } from '../../src/node/extension-host-runtime';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function createLogger(): INodeLogger {
  return {
    debug: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
    verbose: jest.fn(),
    warn: jest.fn(),
  } as unknown as INodeLogger;
}

function createTarget(clientId = 'client', generation = 1) {
  let attached: ExtensionHostRuntimeOwnedResource | undefined;
  let current = true;
  const identity = {};
  const target: ExtensionHostProfilerTarget = {
    clientId,
    generation,
    identity,
    inspectPort: 9200 + generation,
    processId: 4100 + generation,
    attach: (resource) => {
      if (attached || !current) {
        return false;
      }
      attached = resource;
      return true;
    },
    confirmCurrent: async () => current,
    detach: (resource) => {
      if (attached === resource) {
        attached = undefined;
      }
    },
  };
  return {
    get attached() {
      return attached;
    },
    retireTarget() {
      current = false;
    },
    target,
  };
}

function createCoordinator(targetSource: { acquire: jest.Mock }) {
  const injector = new Injector([
    { token: DefaultExtensionHostProfilerTargetSource, useValue: targetSource },
    { token: INodeLogger, useValue: createLogger() },
    ExtensionHostProfilerCoordinator,
  ]);
  return { coordinator: injector.get(ExtensionHostProfilerCoordinator), injector };
}

describe('ExtensionHostProfilerCoordinator', () => {
  it('admits one profiler per Host generation and transfers authority to the replacement connection', async () => {
    const runtime = createTarget();
    const targetSource = { acquire: jest.fn().mockResolvedValue(runtime.target) };
    const { coordinator, injector } = createCoordinator(targetSource);
    const started = createDeferred<{ stop: jest.Mock }>();
    const stop = jest.fn().mockResolvedValue({ profile: { nodes: [{ id: 1 }] } });
    const startProfiler = jest.fn(() => started.promise);
    const firstAuthority = {};
    const replacementAuthority = {};

    const firstStart = coordinator.start(firstAuthority, 'client', { cleanupLeaseMs: 100, startProfiler });
    await Promise.resolve();
    const replacementStart = coordinator.start(replacementAuthority, 'client', {
      cleanupLeaseMs: 100,
      startProfiler,
    });
    started.resolve({ stop });
    await Promise.all([firstStart, replacementStart]);

    expect(startProfiler).toHaveBeenCalledTimes(1);
    await expect(coordinator.release(firstAuthority, 'client', 100)).resolves.toBeUndefined();
    expect(stop).not.toHaveBeenCalled();
    await expect(coordinator.stop(firstAuthority, 'client')).resolves.toEqual({ stopped: false });
    await expect(coordinator.stop(replacementAuthority, 'client')).resolves.toMatchObject({ stopped: true });
    expect(stop).toHaveBeenCalledTimes(1);
    expect(coordinator.peekLastProfile('client')?.profile).toEqual({ nodes: [{ id: 1 }] });
    await injector.disposeAll();
  });

  it('fences a late profiler start when the exact RuntimeHandle resource retires', async () => {
    const runtime = createTarget();
    const targetSource = { acquire: jest.fn().mockResolvedValue(runtime.target) };
    const { coordinator, injector } = createCoordinator(targetSource);
    const started = createDeferred<{ stop: jest.Mock }>();
    const detachedStop = jest.fn().mockResolvedValue({ profile: { nodes: [] } });
    const startProfiler = jest.fn(() => started.promise);
    const startRequest = coordinator.start({}, 'client', {
      cleanupLeaseMs: 100,
      startProfiler,
    });
    while (startProfiler.mock.calls.length === 0) {
      await Promise.resolve();
    }
    const resource = runtime.attached;
    expect(resource).toBeDefined();

    runtime.retireTarget();
    const retirement = resource!.retire(Date.now() + 100, 'runtime-retire').catch(() => undefined);
    started.resolve({ stop: detachedStop });
    await Promise.all([startRequest.catch(() => undefined), retirement]);

    expect(detachedStop).toHaveBeenCalledTimes(1);
    expect(coordinator.getSessionMap().size).toBe(0);
    expect(runtime.attached).toBeUndefined();
    await injector.disposeAll();
  });

  it('revokes an authority that disconnects while target acquisition is in flight', async () => {
    const runtime = createTarget();
    const targetAcquisition = createDeferred<ExtensionHostProfilerTarget>();
    const targetSource = { acquire: jest.fn(() => targetAcquisition.promise) };
    const { coordinator, injector } = createCoordinator(targetSource);
    const authority = {};
    const startProfiler = jest.fn();
    const startRequest = coordinator.start(authority, 'client', { cleanupLeaseMs: 50, startProfiler });

    await expect(coordinator.release(authority, 'client', 50)).resolves.toBeUndefined();
    targetAcquisition.resolve(runtime.target);
    await expect(startRequest).resolves.toBeUndefined();

    expect(startProfiler).not.toHaveBeenCalled();
    expect(runtime.attached).toBeUndefined();
    expect(coordinator.getSessionMap().size).toBe(0);
    await injector.disposeAll();
  });

  it('fails closed for the same Host generation while a cleanup stop outcome is uncertain', async () => {
    jest.useFakeTimers();
    try {
      const runtime = createTarget();
      const targetSource = { acquire: jest.fn().mockResolvedValue(runtime.target) };
      const { coordinator, injector } = createCoordinator(targetSource);
      const stopping = createDeferred<{ profile: object }>();
      const stop = jest.fn(() => stopping.promise);
      const authority = {};
      await coordinator.start(authority, 'client', {
        cleanupLeaseMs: 50,
        startProfiler: jest.fn().mockResolvedValue({ stop }),
      });

      const release = coordinator.release(authority, 'client', 50).catch((error) => error as AggregateError);
      await jest.advanceTimersByTimeAsync(50);
      await expect(release).resolves.toMatchObject({ message: 'Extension profiling session cleanup failed' });
      await expect(
        coordinator.start({}, 'client', {
          cleanupLeaseMs: 50,
          startProfiler: jest.fn(),
        }),
      ).rejects.toMatchObject({ name: 'ExtensionProfilerUncertainStateError' });

      stopping.resolve({ profile: { nodes: [] } });
      await jest.advanceTimersByTimeAsync(0);
      await injector.disposeAll();
    } finally {
      jest.useRealTimers();
    }
  });

  it('consumes saved profiles by exact version so an older write cannot clear a newer result', async () => {
    const runtime = createTarget();
    const targetSource = { acquire: jest.fn().mockResolvedValue(runtime.target) };
    const { coordinator, injector } = createCoordinator(targetSource);
    const authority = {};
    const firstStop = jest.fn().mockResolvedValue({ profile: { nodes: [{ id: 1 }] } });
    const secondStop = jest.fn().mockResolvedValue({ profile: { nodes: [{ id: 2 }] } });
    const startProfiler = jest
      .fn()
      .mockResolvedValueOnce({ stop: firstStop })
      .mockResolvedValueOnce({ stop: secondStop });

    await coordinator.start(authority, 'client', { cleanupLeaseMs: 100, startProfiler });
    await coordinator.stop(authority, 'client');
    const first = coordinator.peekLastProfile('client')!;
    await coordinator.start(authority, 'client', { cleanupLeaseMs: 100, startProfiler });
    await coordinator.stop(authority, 'client');
    const second = coordinator.peekLastProfile('client')!;

    expect(coordinator.consumeLastProfile('client', first.version)).toBe(false);
    expect(coordinator.peekLastProfile('client')).toEqual(second);
    expect(coordinator.consumeLastProfile('client', second.version)).toBe(true);
    expect(coordinator.peekLastProfile('client')).toBeUndefined();
    await injector.disposeAll();
  });

  it('does not let an old stop settlement overwrite a replacement generation profile', async () => {
    const oldRuntime = createTarget('client', 1);
    const replacementRuntime = createTarget('client', 2);
    let currentTarget = oldRuntime.target;
    const targetSource = { acquire: jest.fn(async () => currentTarget) };
    const { coordinator, injector } = createCoordinator(targetSource);
    const oldStopResult = createDeferred<{ profile: object }>();
    const oldStop = jest.fn(() => oldStopResult.promise);
    const oldAuthority = {};
    await coordinator.start(oldAuthority, 'client', {
      cleanupLeaseMs: 50,
      startProfiler: jest.fn().mockResolvedValue({ stop: oldStop }),
    });
    const staleStopRequest = coordinator.stop(oldAuthority, 'client');
    await Promise.resolve();

    oldRuntime.retireTarget();
    await oldRuntime.attached!.retire(Date.now(), 'runtime-retire').catch(() => undefined);
    currentTarget = replacementRuntime.target;
    const replacementAuthority = {};
    await coordinator.start(replacementAuthority, 'client', {
      cleanupLeaseMs: 50,
      startProfiler: jest.fn().mockResolvedValue({
        stop: jest.fn().mockResolvedValue({ profile: { nodes: [{ id: 2 }] } }),
      }),
    });
    await coordinator.stop(replacementAuthority, 'client');

    oldStopResult.resolve({ profile: { nodes: [{ id: 1 }] } });
    await staleStopRequest;
    expect(coordinator.peekLastProfile('client')?.profile).toEqual({ nodes: [{ id: 2 }] });
    await injector.disposeAll();
  });

  it('keeps a same-generation tombstone until a timed-out detached stop settles', async () => {
    jest.useFakeTimers();
    try {
      const runtime = createTarget();
      const targetSource = { acquire: jest.fn().mockResolvedValue(runtime.target) };
      const { coordinator, injector } = createCoordinator(targetSource);
      const started = createDeferred<{ stop: jest.Mock }>();
      const detachedStopResult = createDeferred<{ profile: object }>();
      const detachedStop = jest.fn(() => detachedStopResult.promise);
      const authority = {};
      const startProfiler = jest.fn(() => started.promise);
      const startRequest = coordinator
        .start(authority, 'client', {
          cleanupLeaseMs: 50,
          startProfiler,
        })
        .catch((error) => error as Error);
      while (startProfiler.mock.calls.length === 0) {
        await Promise.resolve();
      }
      const release = coordinator.release(authority, 'client', 50).catch((error) => error as AggregateError);
      started.resolve({ stop: detachedStop });
      await jest.advanceTimersByTimeAsync(50);
      await expect(startRequest).resolves.toMatchObject({ name: 'ExtensionProfilerLeaseTimeoutError' });
      await expect(release).resolves.toMatchObject({ message: 'Extension profiling session cleanup failed' });

      await expect(
        coordinator.start({}, 'client', {
          cleanupLeaseMs: 50,
          startProfiler: jest.fn(),
        }),
      ).rejects.toMatchObject({ name: 'ExtensionProfilerUncertainStateError' });

      detachedStopResult.resolve({ profile: { nodes: [] } });
      await jest.advanceTimersByTimeAsync(0);
      const replacementStart = jest.fn().mockResolvedValue({ stop: jest.fn().mockResolvedValue({ profile: {} }) });
      await expect(
        coordinator.start({}, 'client', { cleanupLeaseMs: 50, startProfiler: replacementStart }),
      ).resolves.toBeUndefined();
      expect(replacementStart).toHaveBeenCalledTimes(1);
      await injector.disposeAll();
    } finally {
      jest.useRealTimers();
    }
  });

  it('recovers the same generation after an in-lease start rejection during connection cleanup', async () => {
    const runtime = createTarget();
    const targetSource = { acquire: jest.fn().mockResolvedValue(runtime.target) };
    const { coordinator, injector } = createCoordinator(targetSource);
    const started = createDeferred<{ stop: jest.Mock }>();
    const authority = {};
    const startProfiler = jest.fn(() => started.promise);
    const startRequest = coordinator
      .start(authority, 'client', { cleanupLeaseMs: 100, startProfiler })
      .catch((error) => error as Error);
    while (startProfiler.mock.calls.length === 0) {
      await Promise.resolve();
    }

    const release = coordinator.release(authority, 'client', 100).catch((error) => error as AggregateError);
    started.reject(new Error('inspector start rejected'));

    await expect(startRequest).resolves.toMatchObject({ message: 'inspector start rejected' });
    await expect(release).resolves.toMatchObject({ message: 'Extension profiling session cleanup failed' });
    const replacementStart = jest.fn().mockResolvedValue({ stop: jest.fn().mockResolvedValue({ profile: {} }) });
    await expect(
      coordinator.start({}, 'client', { cleanupLeaseMs: 100, startProfiler: replacementStart }),
    ).resolves.toBeUndefined();
    expect(replacementStart).toHaveBeenCalledTimes(1);
    await injector.disposeAll();
  });

  it('recovers after a live start timeout later rejects without creating a session', async () => {
    jest.useFakeTimers();
    try {
      const runtime = createTarget();
      const targetSource = { acquire: jest.fn().mockResolvedValue(runtime.target) };
      const { coordinator, injector } = createCoordinator(targetSource);
      const started = createDeferred<{ stop: jest.Mock }>();
      const startProfiler = jest.fn(() => started.promise);
      const startRequest = coordinator
        .start({}, 'client', { cleanupLeaseMs: 50, startProfiler })
        .catch((error) => error as Error);
      while (startProfiler.mock.calls.length === 0) {
        await Promise.resolve();
      }

      await jest.advanceTimersByTimeAsync(50);
      await expect(startRequest).resolves.toMatchObject({ name: 'ExtensionProfilerLeaseTimeoutError' });
      started.reject(new Error('late inspector start rejection'));
      await jest.advanceTimersByTimeAsync(0);

      const replacementStart = jest.fn().mockResolvedValue({ stop: jest.fn().mockResolvedValue({ profile: {} }) });
      await expect(
        coordinator.start({}, 'client', { cleanupLeaseMs: 50, startProfiler: replacementStart }),
      ).resolves.toBeUndefined();
      expect(replacementStart).toHaveBeenCalledTimes(1);
      expect(coordinator.getSessionMap().size).toBe(1);
      await injector.disposeAll();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not let an older start waiter cancel a start transferred to a replacement authority', async () => {
    jest.useFakeTimers();
    try {
      const runtime = createTarget();
      const targetSource = { acquire: jest.fn().mockResolvedValue(runtime.target) };
      const { coordinator, injector } = createCoordinator(targetSource);
      const started = createDeferred<{ stop: jest.Mock }>();
      const stop = jest.fn().mockResolvedValue({ profile: { nodes: [] } });
      const startProfiler = jest.fn(() => started.promise);
      const firstAuthority = {};
      const replacementAuthority = {};
      const firstStart = coordinator
        .start(firstAuthority, 'client', { cleanupLeaseMs: 50, startProfiler })
        .catch((error) => error as Error);
      while (startProfiler.mock.calls.length === 0) {
        await Promise.resolve();
      }

      await jest.advanceTimersByTimeAsync(40);
      const replacementStart = coordinator.start(replacementAuthority, 'client', {
        cleanupLeaseMs: 50,
        startProfiler,
      });
      await jest.advanceTimersByTimeAsync(10);
      await expect(firstStart).resolves.toMatchObject({ name: 'ExtensionProfilerLeaseTimeoutError' });

      started.resolve({ stop });
      await jest.advanceTimersByTimeAsync(0);
      await expect(replacementStart).resolves.toBeUndefined();
      expect(coordinator.getSessionMap().size).toBe(1);
      await expect(coordinator.stop(replacementAuthority, 'client')).resolves.toMatchObject({ stopped: true });
      expect(stop).toHaveBeenCalledTimes(1);
      await injector.disposeAll();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not report start success to an older waiter after the replacement authority cancels the attempt', async () => {
    const runtime = createTarget();
    const targetSource = { acquire: jest.fn().mockResolvedValue(runtime.target) };
    const { coordinator, injector } = createCoordinator(targetSource);
    const started = createDeferred<{ stop: jest.Mock }>();
    const detachedStop = jest.fn().mockResolvedValue({ profile: { nodes: [] } });
    const startProfiler = jest.fn(() => started.promise);
    const firstStart = coordinator.start({}, 'client', { cleanupLeaseMs: 100, startProfiler }).catch((error) => error);
    while (startProfiler.mock.calls.length === 0) {
      await Promise.resolve();
    }
    const replacementAuthority = {};
    const replacementStart = coordinator
      .start(replacementAuthority, 'client', { cleanupLeaseMs: 100, startProfiler })
      .catch((error) => error);
    while (targetSource.acquire.mock.calls.length < 2) {
      await Promise.resolve();
    }
    await new Promise<void>((resolve) => setImmediate(resolve));

    const release = coordinator.release(replacementAuthority, 'client', 100);
    started.resolve({ stop: detachedStop });

    await expect(firstStart).resolves.toMatchObject({ name: 'ExtensionProfilerStartSupersededError' });
    await expect(replacementStart).resolves.toMatchObject({ name: 'ExtensionProfilerStartSupersededError' });
    await expect(release).resolves.toBeUndefined();
    expect(detachedStop).toHaveBeenCalledTimes(1);
    expect(coordinator.getSessionMap().size).toBe(0);
    await injector.disposeAll();
  });

  it('bounds stop while a profiling start never settles', async () => {
    jest.useFakeTimers();
    try {
      const runtime = createTarget();
      const targetSource = { acquire: jest.fn().mockResolvedValue(runtime.target) };
      const { coordinator, injector } = createCoordinator(targetSource);
      const started = createDeferred<{ stop: jest.Mock }>();
      const authority = {};
      const startProfiler = jest.fn(() => started.promise);
      const startRequest = coordinator
        .start(authority, 'client', { cleanupLeaseMs: 50, startProfiler })
        .catch((error) => error as Error);
      while (startProfiler.mock.calls.length === 0) {
        await Promise.resolve();
      }
      const stopRequest = coordinator.stop(authority, 'client').catch((error) => error as Error);

      await jest.advanceTimersByTimeAsync(50);
      await expect(startRequest).resolves.toMatchObject({ name: 'ExtensionProfilerLeaseTimeoutError' });
      await expect(stopRequest).resolves.toMatchObject({ name: 'ExtensionProfilerLeaseTimeoutError' });

      const detachedStop = jest.fn().mockResolvedValue({ profile: { nodes: [] } });
      started.resolve({ stop: detachedStop });
      await jest.advanceTimersByTimeAsync(0);
      expect(detachedStop).toHaveBeenCalledTimes(1);
      await injector.disposeAll();
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops a late live-start fulfillment before reopening same-generation admission', async () => {
    jest.useFakeTimers();
    try {
      const runtime = createTarget();
      const targetSource = { acquire: jest.fn().mockResolvedValue(runtime.target) };
      const { coordinator, injector } = createCoordinator(targetSource);
      const started = createDeferred<{ stop: jest.Mock }>();
      const detachedStop = jest.fn().mockResolvedValue({ profile: { nodes: [] } });
      const startProfiler = jest.fn(() => started.promise);
      const startRequest = coordinator
        .start({}, 'client', { cleanupLeaseMs: 50, startProfiler })
        .catch((error) => error as Error);
      while (startProfiler.mock.calls.length === 0) {
        await Promise.resolve();
      }

      await jest.advanceTimersByTimeAsync(50);
      await expect(startRequest).resolves.toMatchObject({ name: 'ExtensionProfilerLeaseTimeoutError' });
      started.resolve({ stop: detachedStop });
      await jest.advanceTimersByTimeAsync(0);

      expect(detachedStop).toHaveBeenCalledTimes(1);
      const replacementStart = jest.fn().mockResolvedValue({ stop: jest.fn().mockResolvedValue({ profile: {} }) });
      await coordinator.start({}, 'client', { cleanupLeaseMs: 50, startProfiler: replacementStart });
      expect(replacementStart).toHaveBeenCalledTimes(1);
      await injector.disposeAll();
    } finally {
      jest.useRealTimers();
    }
  });

  it('publishes a late live-stop fulfillment and then reopens same-generation admission', async () => {
    jest.useFakeTimers();
    try {
      const runtime = createTarget();
      const targetSource = { acquire: jest.fn().mockResolvedValue(runtime.target) };
      const { coordinator, injector } = createCoordinator(targetSource);
      const stopped = createDeferred<{ profile: object }>();
      const authority = {};
      await coordinator.start(authority, 'client', {
        cleanupLeaseMs: 50,
        startProfiler: jest.fn().mockResolvedValue({ stop: jest.fn(() => stopped.promise) }),
      });

      const stopRequest = coordinator.stop(authority, 'client').catch((error) => error as Error);
      await jest.advanceTimersByTimeAsync(50);
      await expect(stopRequest).resolves.toMatchObject({ name: 'ExtensionProfilerLeaseTimeoutError' });
      stopped.resolve({ profile: { nodes: [{ id: 71 }] } });
      await jest.advanceTimersByTimeAsync(0);

      expect(coordinator.peekLastProfile('client')?.profile).toEqual({ nodes: [{ id: 71 }] });
      const replacementStart = jest.fn().mockResolvedValue({ stop: jest.fn().mockResolvedValue({ profile: {} }) });
      await coordinator.start({}, 'client', { cleanupLeaseMs: 50, startProfiler: replacementStart });
      expect(replacementStart).toHaveBeenCalledTimes(1);
      await injector.disposeAll();
    } finally {
      jest.useRealTimers();
    }
  });

  it('bounds replacement start while the previous profiling stop never settles', async () => {
    jest.useFakeTimers();
    try {
      const runtime = createTarget();
      const targetSource = { acquire: jest.fn().mockResolvedValue(runtime.target) };
      const { coordinator, injector } = createCoordinator(targetSource);
      const stopped = createDeferred<{ profile: object }>();
      const firstAuthority = {};
      await coordinator.start(firstAuthority, 'client', {
        cleanupLeaseMs: 50,
        startProfiler: jest.fn().mockResolvedValue({ stop: jest.fn(() => stopped.promise) }),
      });
      const stopRequest = coordinator.stop(firstAuthority, 'client').catch((error) => error as Error);

      await jest.advanceTimersByTimeAsync(40);
      const replacementStartProfiler = jest
        .fn()
        .mockResolvedValue({ stop: jest.fn().mockResolvedValue({ profile: {} }) });
      const replacementStart = coordinator
        .start({}, 'client', { cleanupLeaseMs: 50, startProfiler: replacementStartProfiler })
        .catch((error) => error as Error);
      await jest.advanceTimersByTimeAsync(50);

      await expect(stopRequest).resolves.toMatchObject({ name: 'ExtensionProfilerLeaseTimeoutError' });
      await expect(replacementStart).resolves.toMatchObject({ name: 'ExtensionProfilerLeaseTimeoutError' });
      expect(replacementStartProfiler).not.toHaveBeenCalled();

      stopped.resolve({ profile: { nodes: [] } });
      await jest.advanceTimersByTimeAsync(0);
      await expect(
        coordinator.start({}, 'client', { cleanupLeaseMs: 50, startProfiler: replacementStartProfiler }),
      ).resolves.toBeUndefined();
      expect(replacementStartProfiler).toHaveBeenCalledTimes(1);
      await injector.disposeAll();
    } finally {
      jest.useRealTimers();
    }
  });

  it('restores a timed-out live stop to running after its late rejection so stop can be retried', async () => {
    jest.useFakeTimers();
    try {
      const runtime = createTarget();
      const targetSource = { acquire: jest.fn().mockResolvedValue(runtime.target) };
      const { coordinator, injector } = createCoordinator(targetSource);
      const stopped = createDeferred<{ profile: object }>();
      const stop = jest
        .fn()
        .mockImplementationOnce(() => stopped.promise)
        .mockResolvedValueOnce({ profile: { nodes: [{ id: 73 }] } });
      const authority = {};
      await coordinator.start(authority, 'client', {
        cleanupLeaseMs: 50,
        startProfiler: jest.fn().mockResolvedValue({ stop }),
      });

      const firstStop = coordinator.stop(authority, 'client').catch((error) => error as Error);
      await jest.advanceTimersByTimeAsync(50);
      await expect(firstStop).resolves.toMatchObject({ name: 'ExtensionProfilerLeaseTimeoutError' });
      stopped.reject(new Error('late inspector stop rejection'));
      await jest.advanceTimersByTimeAsync(0);

      await expect(coordinator.stop(authority, 'client')).resolves.toMatchObject({ stopped: true });
      expect(stop).toHaveBeenCalledTimes(2);
      expect(coordinator.peekLastProfile('client')?.profile).toEqual({ nodes: [{ id: 73 }] });
      await injector.disposeAll();
    } finally {
      jest.useRealTimers();
    }
  });

  it('retains a completed profile across exact RuntimeHandle retirement until versioned consumption', async () => {
    const runtime = createTarget();
    const targetSource = { acquire: jest.fn().mockResolvedValue(runtime.target) };
    const { coordinator, injector } = createCoordinator(targetSource);
    const authority = {};
    await coordinator.start(authority, 'client', {
      cleanupLeaseMs: 100,
      startProfiler: jest.fn().mockResolvedValue({
        stop: jest.fn().mockResolvedValue({ profile: { nodes: [{ id: 79 }] } }),
      }),
    });
    await coordinator.stop(authority, 'client');
    const completed = coordinator.peekLastProfile('client')!;

    await runtime.attached!.retire(Date.now() + 100, 'runtime-retire');

    expect(coordinator.peekLastProfile('client')).toEqual(completed);
    expect(coordinator.consumeLastProfile('client', completed.version)).toBe(true);
    expect(coordinator.peekLastProfile('client')).toBeUndefined();
    await injector.disposeAll();
  });

  it('bounds retained completed profiles across clients', async () => {
    const targetSource = { acquire: jest.fn() };
    const { coordinator, injector } = createCoordinator(targetSource);

    for (let index = 0; index < 129; index++) {
      coordinator.setLastProfile(`client-${index}`, { nodes: [{ id: index }] } as any);
    }

    expect(coordinator.peekLastProfile('client-0')).toBeUndefined();
    expect(coordinator.peekLastProfile('client-1')).toBeDefined();
    expect(coordinator.peekLastProfile('client-128')).toBeDefined();
    await injector.disposeAll();
  });

  it('retires a mismatched legacy session before starting the current Runtime generation', async () => {
    const runtime = createTarget('client', 2);
    const targetSource = { acquire: jest.fn().mockResolvedValue(runtime.target) };
    const { coordinator, injector } = createCoordinator(targetSource);
    const legacyStop = jest.fn().mockResolvedValue({ profile: { nodes: [] } });
    coordinator.getSessionMap().set('client', {
      inspectPort: runtime.target.inspectPort,
      processId: runtime.target.processId,
      runtimeGeneration: 1,
      retired: false,
      session: { stop: legacyStop } as any,
      stopped: false,
    });
    const currentStop = jest.fn().mockResolvedValue({ profile: { nodes: [] } });
    const startProfiler = jest.fn().mockResolvedValue({ stop: currentStop });
    const authority = {};

    await expect(
      coordinator.start(authority, 'client', { cleanupLeaseMs: 100, startProfiler }),
    ).resolves.toBeUndefined();
    expect(legacyStop).toHaveBeenCalledTimes(1);
    expect(startProfiler).toHaveBeenCalledTimes(1);
    expect(coordinator.getSessionMap().get('client')).toMatchObject({ runtimeGeneration: 2 });
    await coordinator.stop(authority, 'client');
    expect(currentStop).toHaveBeenCalledTimes(1);
    await injector.disposeAll();
  });

  it('keeps a timed-out legacy orphan fenced until its late stop settles', async () => {
    jest.useFakeTimers();
    try {
      const runtime = createTarget('client', 2);
      const targetSource = { acquire: jest.fn().mockResolvedValue(runtime.target) };
      const { coordinator, injector } = createCoordinator(targetSource);
      const legacyStopped = createDeferred<{ profile: object }>();
      const legacyStop = jest.fn(() => legacyStopped.promise);
      coordinator.getSessionMap().set('client', {
        inspectPort: runtime.target.inspectPort,
        processId: runtime.target.processId,
        runtimeGeneration: 1,
        retired: false,
        session: { stop: legacyStop } as any,
        stopped: false,
      });
      const startProfiler = jest.fn().mockResolvedValue({ stop: jest.fn().mockResolvedValue({ profile: {} }) });
      const firstStart = coordinator
        .start({}, 'client', { cleanupLeaseMs: 50, startProfiler })
        .catch((error) => error as Error);
      await jest.advanceTimersByTimeAsync(50);
      await expect(firstStart).resolves.toMatchObject({ message: 'Legacy extension profiling session cleanup failed' });
      expect(startProfiler).not.toHaveBeenCalled();
      expect(coordinator.getSessionMap().has('client')).toBe(true);

      const secondStart = coordinator
        .start({}, 'client', { cleanupLeaseMs: 50, startProfiler })
        .catch((error) => error as Error);
      await jest.advanceTimersByTimeAsync(50);
      await expect(secondStart).resolves.toMatchObject({
        message: 'Legacy extension profiling session cleanup failed',
      });
      expect(startProfiler).not.toHaveBeenCalled();

      legacyStopped.resolve({ profile: { nodes: [] } });
      await jest.advanceTimersByTimeAsync(0);
      await expect(coordinator.start({}, 'client', { cleanupLeaseMs: 50, startProfiler })).resolves.toBeUndefined();
      expect(legacyStop).toHaveBeenCalledTimes(1);
      expect(startProfiler).toHaveBeenCalledTimes(1);
      await injector.disposeAll();
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not attach or start a replacement after old-slot retirement consumes the deadline', async () => {
    jest.useFakeTimers();
    try {
      const oldRuntime = createTarget('client', 1);
      const replacementRuntime = createTarget('client', 2);
      let currentTarget = oldRuntime.target;
      const targetSource = { acquire: jest.fn(async () => currentTarget) };
      const { coordinator, injector } = createCoordinator(targetSource);
      const oldStopped = createDeferred<{ profile: object }>();
      await coordinator.start({}, 'client', {
        cleanupLeaseMs: 50,
        startProfiler: jest.fn().mockResolvedValue({ stop: jest.fn(() => oldStopped.promise) }),
      });
      currentTarget = replacementRuntime.target;
      const replacementStartProfiler = jest.fn();

      const replacement = coordinator
        .start({}, 'client', { cleanupLeaseMs: 50, startProfiler: replacementStartProfiler })
        .catch((error) => error as Error);
      await jest.advanceTimersByTimeAsync(50);

      await expect(replacement).resolves.toMatchObject({ name: 'ExtensionProfilerLeaseTimeoutError' });
      expect(replacementRuntime.attached).toBeUndefined();
      expect(replacementStartProfiler).not.toHaveBeenCalled();
      oldStopped.resolve({ profile: { nodes: [] } });
      await jest.advanceTimersByTimeAsync(0);
      await injector.disposeAll();
    } finally {
      jest.useRealTimers();
    }
  });
});
