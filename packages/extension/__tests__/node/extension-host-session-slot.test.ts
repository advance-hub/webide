import { ExtensionHostSessionSlot, ExtensionHostSessionSlotRegistry } from '../../src/node/extension-host-session-slot';

import type { IExtensionNodeClientService } from '../../src/common';
import type { ExtensionHostRuntimeHandle } from '../../src/node/extension-host-runtime';
import type { WSServerChannel } from '@opensumi/ide-connection';

function createDeferred<T>() {
  let resolve: (value: T | PromiseLike<T>) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

function createRuntime(clientId: string, generation: number): ExtensionHostRuntimeHandle {
  return { clientId, generation } as ExtensionHostRuntimeHandle;
}

function createFacade(name: string): IExtensionNodeClientService {
  return { name } as unknown as IExtensionNodeClientService;
}

function createChannel(name: string): WSServerChannel {
  return { name } as unknown as WSServerChannel;
}

describe('ExtensionHostSessionSlot', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('publishes and clears only the exact current RuntimeHandle', async () => {
    expect.hasAssertions();
    const slot = new ExtensionHostSessionSlot('client');
    const current = createRuntime('client', 1);
    const stale = createRuntime('client', 0);
    const foreign = createRuntime('foreign', 2);

    await slot.runCreation((token) => {
      expect(slot.publishRuntime(token, foreign)).toBe(false);
      expect(slot.publishRuntime(token, current)).toBe(true);
    });

    expect(slot.isCurrentRuntime(current)).toBe(true);
    expect(slot.clearRuntime(stale)).toBe(false);
    expect(slot.currentRuntime).toBe(current);
    expect(slot.clearRuntime(current)).toBe(true);
    expect(slot.currentRuntime).toBeUndefined();
  });

  it('coalesces creation and rejects publication after revision invalidation', async () => {
    expect.hasAssertions();
    const slot = new ExtensionHostSessionSlot('client');
    const release = createDeferred<void>();
    const runtime = createRuntime('client', 1);
    const task = jest.fn(async (token) => {
      await release.promise;
      expect(slot.publishRuntime(token, runtime)).toBe(false);
    });

    const first = slot.runCreation(task);
    const second = slot.runCreation(jest.fn());
    expect(first).toBe(second);
    expect(task).toHaveBeenCalledTimes(1);

    slot.invalidateRuntimePublication();
    release.resolve(undefined);
    await first;
    expect(slot.currentRuntime).toBeUndefined();
    expect(slot.creationPromise).toBeUndefined();
  });

  it('registers operations before synchronous reentry without delaying retirement', async () => {
    expect.hasAssertions();
    const slot = new ExtensionHostSessionSlot('client');
    const runtime = createRuntime('client', 1);
    const ignored = jest.fn();
    let reentrantCreation: Promise<void> | undefined;
    const creation = slot.runCreation(() => {
      reentrantCreation = slot.runCreation(ignored);
    });
    let reentrantReadiness: Promise<boolean> | undefined;
    const readiness = slot.runReadiness(runtime, () => {
      reentrantReadiness = slot.runReadiness(runtime, ignored);
      return true;
    });
    let reentrantRetirement: Promise<void> | undefined;
    const retirement = slot.runRetirement(runtime, () => {
      reentrantRetirement = slot.runRetirement(runtime, ignored);
    });
    expect(reentrantCreation).toBe(creation);
    expect(reentrantReadiness).toBe(readiness);
    expect(reentrantRetirement).toBe(retirement);
    expect(ignored).not.toHaveBeenCalled();
    await Promise.all([creation, readiness, retirement]);
  });

  it.each([false, true])(
    'allows replacement only while admission remains valid (invalidated=%s)',
    async (invalidated) => {
      expect.hasAssertions();
      const slot = new ExtensionHostSessionSlot('client');
      const old = createRuntime('client', 1);
      const replacement = createRuntime('client', 2);
      await slot.runCreation((token) => {
        expect(slot.publishRuntime(token, old)).toBe(true);
      });
      await slot.runCreation((token) => {
        if (invalidated) {
          slot.invalidateRuntimePublication();
        }
        expect(slot.clearRuntime(old)).toBe(true);
        expect(slot.publishRuntime(token, replacement)).toBe(!invalidated);
        if (!invalidated) {
          expect(slot.clearRuntime(replacement)).toBe(true);
          expect(slot.publishRuntime(token, createRuntime('client', 3))).toBe(false);
        }
      });
      expect(slot.currentRuntime).toBeUndefined();
    },
  );

  it('keeps readiness single-flight exact to each RuntimeHandle even after settlement', async () => {
    expect.hasAssertions();
    const slot = new ExtensionHostSessionSlot('client');
    const firstRuntime = createRuntime('client', 1);
    const secondRuntime = createRuntime('client', 2);
    const firstTask = jest.fn().mockResolvedValue(true);
    const ignoredTask = jest.fn().mockResolvedValue(false);

    const first = slot.runReadiness(firstRuntime, firstTask);
    const duplicate = slot.runReadiness(firstRuntime, ignoredTask);
    const second = slot.runReadiness(secondRuntime, ignoredTask);

    expect(first).toBe(duplicate);
    await expect(first).resolves.toBe(true);
    await expect(second).resolves.toBe(false);
    expect(slot.runReadiness(firstRuntime, ignoredTask)).toBe(first);
    expect(firstTask).toHaveBeenCalledTimes(1);
    expect(ignoredTask).toHaveBeenCalledTimes(1);
    expect(slot.hasPendingReadiness).toBe(false);
  });

  it('keeps retirement single-flight exact to each RuntimeHandle and tracks pending work', async () => {
    expect.hasAssertions();
    const slot = new ExtensionHostSessionSlot('client');
    const firstRuntime = createRuntime('client', 1);
    const secondRuntime = createRuntime('client', 2);
    const firstRelease = createDeferred<void>();
    const firstTask = jest.fn(() => firstRelease.promise);
    const ignoredTask = jest.fn();

    const first = slot.runRetirement(firstRuntime, firstTask);
    const duplicate = slot.runRetirement(firstRuntime, ignoredTask);
    const second = slot.runRetirement(secondRuntime, ignoredTask);
    expect(first).toBe(duplicate);
    expect(slot.hasPendingRetirement).toBe(true);

    await second;
    firstRelease.resolve(undefined);
    await slot.whenRetirementsSettled();
    expect(slot.runRetirement(firstRuntime, ignoredTask)).toBe(first);
    expect(firstTask).toHaveBeenCalledTimes(1);
    expect(ignoredTask).toHaveBeenCalledTimes(1);
    expect(slot.hasPendingRetirement).toBe(false);
  });

  it('releases only the exact current facade', () => {
    expect.hasAssertions();
    const slot = new ExtensionHostSessionSlot('client');
    const stale = createFacade('stale');
    const current = createFacade('current');

    expect(slot.attachFacade(stale)).toBe(true);
    expect(slot.attachFacade(current)).toBe(true);
    expect(slot.releaseFacade(stale)).toBe(false);
    expect(slot.facade).toBe(current);
    expect(slot.releaseFacade(current)).toBe(true);
    expect(slot.facade).toBeUndefined();
  });

  it('uses Main Thread epoch tokens so stale setup and close cannot affect a replacement', () => {
    expect.hasAssertions();
    const slot = new ExtensionHostSessionSlot('client');
    const disconnectToken = slot.markDisconnected()!;
    const runtime = createRuntime('client', 1);
    const timer = setTimeout(() => undefined, 1_000);
    expect(slot.armDisconnectLease(disconnectToken, timer, runtime)).toBe(true);

    const stale = slot.beginMainThreadConnection(createChannel('stale'))!;
    const current = slot.beginMainThreadConnection(createChannel('current'))!;
    expect(current.epoch).toBeGreaterThan(stale.epoch);
    expect(slot.commitMainThreadConnection(stale)).toBe(false);
    expect(slot.disconnectLease?.timer).toBe(timer);
    expect(slot.releaseMainThreadConnection(stale)).toBe(false);
    expect(slot.isCurrentMainThread(current)).toBe(true);

    expect(slot.commitMainThreadConnection(current)).toBe(true);
    expect(slot.disconnectLease).toBeUndefined();
    expect(slot.releaseMainThreadConnection(current)).toBe(true);
    expect(slot.mainThreadChannel).toBeUndefined();
  });

  it('fences disconnect timers by exact token, timer, and captured RuntimeHandle', () => {
    expect.hasAssertions();
    const slot = new ExtensionHostSessionSlot('client');
    const runtime = createRuntime('client', 1);
    const firstToken = slot.markDisconnected()!;
    const firstTimer = setTimeout(() => undefined, 1_000);
    expect(slot.armDisconnectLease(firstToken, firstTimer, runtime)).toBe(true);

    const currentToken = slot.markDisconnected()!;
    const invalidTimer = setTimeout(() => undefined, 1_000);
    const currentTimer = setTimeout(() => undefined, 1_000);
    expect(slot.armDisconnectLease(firstToken, invalidTimer, runtime)).toBe(false);
    expect(slot.armDisconnectLease(currentToken, currentTimer, runtime)).toBe(true);
    expect(slot.consumeDisconnectLease(firstToken, firstTimer)).toBeUndefined();
    expect(slot.consumeDisconnectLease(currentToken, firstTimer)).toBeUndefined();
    expect(slot.consumeDisconnectLease(currentToken, currentTimer)).toEqual({
      token: currentToken,
      timer: currentTimer,
      runtime,
    });
    expect(slot.disconnectLease).toBeUndefined();
  });

  it('memoizes the Electron path Promise and rejects a late result after reset', async () => {
    expect.hasAssertions();
    const slot = new ExtensionHostSessionSlot('client');
    const pathResult = createDeferred<string>();
    const factory = jest.fn(() => pathResult.promise);

    const first = slot.getElectronMainThreadListenPath(factory);
    const second = slot.getElectronMainThreadListenPath(factory);
    expect(first).toBe(second);
    await Promise.resolve();
    expect(factory).toHaveBeenCalledTimes(1);

    slot.resetElectronMainThreadListenPath();
    pathResult.resolve('/tmp/stale.sock');
    await expect(first).rejects.toMatchObject({ name: 'StaleExtensionHostSessionOperationError' });

    await expect(slot.getElectronMainThreadListenPath(() => '/tmp/current.sock')).resolves.toBe('/tmp/current.sock');
  });

  it('clears a rejected Electron path operation so a retry can run', async () => {
    expect.hasAssertions();
    const slot = new ExtensionHostSessionSlot('client');
    const error = new Error('path allocation failed');

    await expect(slot.getElectronMainThreadListenPath(() => Promise.reject(error))).rejects.toBe(error);
    await expect(slot.getElectronMainThreadListenPath(() => '/tmp/retry.sock')).resolves.toBe('/tmp/retry.sock');
  });

  it('drain invalidates publication, rejects new admission, and clears borrowed references only after quiescence', async () => {
    expect.hasAssertions();
    const slot = new ExtensionHostSessionSlot('client');
    const runtime = createRuntime('client', 1);
    const creationRelease = createDeferred<void>();
    const creation = slot.runCreation(async (token) => {
      await creationRelease.promise;
      expect(slot.publishRuntime(token, runtime)).toBe(false);
    });
    const facade = createFacade('facade');
    const channel = createChannel('channel');
    expect(slot.attachFacade(facade)).toBe(true);
    expect(slot.beginMainThreadConnection(channel)).toBeDefined();

    slot.beginDrain();
    expect(slot.phase).toBe('draining');
    expect(slot.attachFacade(createFacade('late'))).toBe(false);
    expect(slot.beginMainThreadConnection(createChannel('late'))).toBeUndefined();
    await expect(slot.runCreation(jest.fn())).rejects.toMatchObject({ name: 'ExtensionHostSessionDrainingError' });
    await expect(slot.runReadiness(runtime, jest.fn())).rejects.toMatchObject({
      name: 'ExtensionHostSessionDrainingError',
    });
    expect(slot.finishDrain()).toBe(false);

    creationRelease.resolve(undefined);
    await creation;
    await slot.whenCreationSettled();
    expect(slot.finishDrain()).toBe(true);
    expect(slot.phase).toBe('drained');
    expect(slot.facade).toBeUndefined();
    expect(slot.mainThreadChannel).toBeUndefined();
    expect(slot.isCollectible()).toBe(true);
  });

  it('waits for exact readiness and retirement operations before finishing drain', async () => {
    expect.hasAssertions();
    const slot = new ExtensionHostSessionSlot('client');
    const runtime = createRuntime('client', 1);
    await slot.runCreation((token) => {
      expect(slot.publishRuntime(token, runtime)).toBe(true);
    });
    const readinessResult = createDeferred<boolean>();
    const retirementResult = createDeferred<void>();
    const readiness = slot.runReadiness(runtime, () => readinessResult.promise);
    const retirement = slot.runRetirement(runtime, () => retirementResult.promise);

    slot.beginDrain();
    expect(slot.clearRuntime(runtime)).toBe(true);
    expect(slot.finishDrain()).toBe(false);

    readinessResult.resolve(false);
    retirementResult.resolve(undefined);
    await Promise.all([readiness, retirement]);
    await Promise.all([slot.whenReadinessSettled(), slot.whenRetirementsSettled()]);
    expect(slot.finishDrain()).toBe(true);
    expect(slot.isCollectible()).toBe(true);
  });
});

describe('ExtensionHostSessionSlotRegistry', () => {
  it('returns one slot per client and prunes by exact slot identity only when collectible', async () => {
    expect.hasAssertions();
    const registry = new ExtensionHostSessionSlotRegistry();
    const current = registry.getOrCreate('client');
    const same = registry.getOrCreate('client');
    const impostor = new ExtensionHostSessionSlot('client');
    expect(current).toBe(same);

    const facade = createFacade('facade');
    current.attachFacade(facade);
    expect(registry.deleteIfCollectible(current)).toBe(false);
    current.releaseFacade(facade);
    expect(registry.deleteIfCollectible(impostor)).toBe(false);
    expect(registry.deleteIfCollectible(current)).toBe(true);
    expect(registry.size).toBe(0);
  });

  it('freezes every current slot during root drain and prevents registry resurrection', () => {
    expect.hasAssertions();
    const registry = new ExtensionHostSessionSlotRegistry();
    const first = registry.getOrCreate('first');
    const second = registry.getOrCreate('second');

    expect(registry.beginDrain()).toEqual([first, second]);
    expect(first.phase).toBe('draining');
    expect(second.phase).toBe('draining');
    expect(() => registry.getOrCreate('late')).toThrow(
      expect.objectContaining({ name: 'ExtensionHostSessionRegistryDrainingError' }),
    );
    expect(registry.finishDrain()).toBe(true);
    expect(registry.phase).toBe('drained');
    expect(registry.size).toBe(0);
  });
});
