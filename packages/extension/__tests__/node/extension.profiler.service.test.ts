import os from 'os';
import path from 'path';

import { Injector } from '@opensumi/di';
import { ServiceRegistry, getServiceMethods } from '@opensumi/ide-connection';
import { CLIENT_ID_TOKEN, Uri } from '@opensumi/ide-core-common';
import { AppConfig, INodeLogger } from '@opensumi/ide-core-node';
import { FileSystemProvider, IDiskFileProvider, IFileService } from '@opensumi/ide-file-service';
import { getSafeFileservice } from '@opensumi/ide-file-service/node';

import { IExtensionNodeService } from '../../src/common';
import {
  DefaultExtensionHostProfilerTargetSource,
  ExtensionHostProfilerCoordinator,
  type ExtensionHostProfilerTarget,
} from '../../src/node/extension-host-profiler-coordinator';
import {
  EXTENSION_PROFILER_LIFECYCLE_OPTIONS,
  type ExtensionProfilerLifecycleOptions,
  ExtensionProfilerService,
} from '../../src/node/extension.profiler.service';

import type { ExtensionHostRuntimeSnapshot } from '../../src/node/extension-host-runtime';

const mockStartProfiling = jest.fn();

const BOUND_CLIENT_ID = 'bound-profiler-client';
const PROFILE_IDENTITY_ERROR = 'Extension profiler session identity is invalid';
const PROFILE_LIFECYCLE_ERROR = 'Extension profiler session lifecycle is unavailable';
const PROFILE_PATH_ERROR = 'Extension profile save path is invalid';
const PROFILE_SAVE_ERROR = 'Extension profile could not be saved';
const CLEANUP_ERROR = 'Extension profiling session cleanup failed';

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

function createFileService() {
  return {
    createFile: jest.fn().mockResolvedValue(undefined),
    getFileStat: jest.fn().mockResolvedValue(undefined),
    setContent: jest.fn().mockResolvedValue(undefined),
  };
}

function createExtensionService() {
  return {
    getExtProcessId: jest.fn().mockResolvedValue(4100),
    getProcessInspectPort: jest.fn().mockResolvedValue(9230),
    tryEnableInspectPort: jest.fn().mockResolvedValue(true),
  };
}

function createRuntimeSnapshotExtensionService(getSnapshot: () => ExtensionHostRuntimeSnapshot | undefined) {
  return {
    ...createExtensionService(),
    getRuntimeHandleSnapshot: jest.fn(getSnapshot),
  };
}

function createProfilerService(options?: {
  clientId?: string;
  extensionService?: ReturnType<typeof createExtensionService>;
  fileService?: ReturnType<typeof createFileService>;
  lifecycleOptions?: ExtensionProfilerLifecycleOptions;
}) {
  const extensionService = options?.extensionService ?? createExtensionService();
  const fileService = options?.fileService ?? createFileService();
  const logger = createLogger();
  const injector = new Injector([
    { token: CLIENT_ID_TOKEN, useValue: options?.clientId ?? BOUND_CLIENT_ID },
    ...(options?.lifecycleOptions
      ? [{ token: EXTENSION_PROFILER_LIFECYCLE_OPTIONS, useValue: options.lifecycleOptions }]
      : []),
    { token: IExtensionNodeService, useValue: extensionService },
    { token: IFileService, useValue: fileService },
    { token: INodeLogger, useValue: logger },
    DefaultExtensionHostProfilerTargetSource,
    ExtensionHostProfilerCoordinator,
    ExtensionProfilerService,
  ]);
  return {
    extensionService,
    fileService,
    injector,
    logger,
    service: injector.get(ExtensionProfilerService),
  };
}

interface TestProfilerSessionHandle {
  inspectPort: number;
  processId: number;
  runtimeGeneration?: number;
  retired: boolean;
  session: { stop: jest.Mock };
  stopped: boolean;
  stopPromise?: Promise<unknown>;
}

function getSessionMap(service: ExtensionProfilerService): Map<string, TestProfilerSessionHandle> {
  return (service as unknown as { sessionMap: Map<string, TestProfilerSessionHandle> }).sessionMap;
}

function setActiveSession(
  service: ExtensionProfilerService,
  profile: object,
  stop = jest.fn().mockResolvedValue({ profile }),
  inspectPort = 9230,
  processId = 4100,
) {
  getSessionMap(service).set(BOUND_CLIENT_ID, {
    inspectPort,
    processId,
    retired: false,
    session: { stop },
    stopped: false,
  });
  return stop;
}

function setLastProfile(service: ExtensionProfilerService, profile: object) {
  (service as unknown as { lastProfile: object | null }).lastProfile = profile;
}

beforeEach(() => {
  mockStartProfiling.mockReset();
  mockStartProfiling.mockResolvedValue({
    stop: jest.fn().mockResolvedValue({ profile: { nodes: [] } }),
  });
});

describe('ExtensionProfilerService connection boundary', () => {
  it('fences start and stop to the immutable connection identity without leaking either id', async () => {
    expect.hasAssertions();
    const { extensionService, service } = createProfilerService();
    const foreignClientId = 'foreign-profiler-secret';

    let startError: Error | undefined;
    try {
      await service.$startProfile(foreignClientId);
    } catch (error) {
      startError = error as Error;
    }
    expect(startError?.message).toBe(PROFILE_IDENTITY_ERROR);
    expect(startError?.message).not.toContain(BOUND_CLIENT_ID);
    expect(startError?.message).not.toContain(foreignClientId);

    let stopError: Error | undefined;
    try {
      await service.$stopProfile(foreignClientId);
    } catch (error) {
      stopError = error as Error;
    }
    expect(stopError?.message).toBe(PROFILE_IDENTITY_ERROR);
    expect(stopError?.message).not.toContain(BOUND_CLIENT_ID);
    expect(stopError?.message).not.toContain(foreignClientId);
    expect(extensionService.tryEnableInspectPort).not.toHaveBeenCalled();
    expect(extensionService.getProcessInspectPort).not.toHaveBeenCalled();
  });

  it('keeps the inspector-port attachment helper off the reflected RPC surface', () => {
    const { service } = createProfilerService();
    const ownMethods = Object.getOwnPropertyNames(ExtensionProfilerService.prototype)
      .filter(
        (name) =>
          typeof Object.getOwnPropertyDescriptor(ExtensionProfilerService.prototype, name)?.value === 'function',
      )
      .sort();

    expect(ownMethods).toEqual(['$saveLastProfile', '$startProfile', '$stopProfile', 'constructor']);
    expect(ownMethods.filter((name) => name.startsWith('$'))).toEqual([
      '$saveLastProfile',
      '$startProfile',
      '$stopProfile',
    ]);
    expect(getServiceMethods(service)).not.toContain('doStartProfiler');

    const registry = new ServiceRegistry();
    registry.registerService(service);
    expect(registry.methods()).not.toContain('doStartProfiler');
    expect(
      registry
        .methods()
        .filter((name) => name.startsWith('$'))
        .sort(),
    ).toEqual(['$saveLastProfile', '$startProfile', '$stopProfile']);
  });

  it('shares one root coordinator across replacement connection children', async () => {
    let attached: object | undefined;
    const target: ExtensionHostProfilerTarget = {
      clientId: BOUND_CLIENT_ID,
      generation: 1,
      identity: {},
      inspectPort: 9230,
      processId: 4100,
      attach: (resource) => {
        if (attached) {
          return false;
        }
        attached = resource;
        return true;
      },
      confirmCurrent: async () => true,
      detach: (resource) => {
        if (attached === resource) {
          attached = undefined;
        }
      },
    };
    const root = new Injector([
      { token: DefaultExtensionHostProfilerTargetSource, useValue: { acquire: jest.fn().mockResolvedValue(target) } },
      { token: INodeLogger, useValue: createLogger() },
      ExtensionHostProfilerCoordinator,
    ]);
    const stop = jest.fn().mockResolvedValue({ profile: { nodes: [] } });
    const firstStart = jest.fn().mockResolvedValue({ stop });
    const replacementStart = jest.fn().mockResolvedValue({ stop: jest.fn() });
    const createChild = (startProfiler: jest.Mock) =>
      root.createChild([
        { token: CLIENT_ID_TOKEN, useValue: BOUND_CLIENT_ID },
        { token: IFileService, useValue: createFileService() },
        { token: EXTENSION_PROFILER_LIFECYCLE_OPTIONS, useValue: { cleanupLeaseMs: 100, startProfiler } },
        ExtensionProfilerService,
      ]);
    const firstChild = createChild(firstStart);
    const replacementChild = createChild(replacementStart);
    const first = firstChild.get(ExtensionProfilerService);
    const replacement = replacementChild.get(ExtensionProfilerService);

    expect(firstChild.get(ExtensionHostProfilerCoordinator)).toBe(root.get(ExtensionHostProfilerCoordinator));
    expect(replacementChild.get(ExtensionHostProfilerCoordinator)).toBe(root.get(ExtensionHostProfilerCoordinator));
    await first.$startProfile(BOUND_CLIENT_ID);
    await replacement.$startProfile(BOUND_CLIENT_ID);
    expect(firstStart).toHaveBeenCalledTimes(1);
    expect(replacementStart).not.toHaveBeenCalled();

    await firstChild.disposeAll();
    expect(stop).not.toHaveBeenCalled();
    await replacementChild.disposeAll();
    expect(stop).toHaveBeenCalledTimes(1);
    await root.disposeAll();
  });

  it('removes a stopped session so a repeated stop cannot reuse a stale profile', async () => {
    const { service } = createProfilerService();
    const stop = setActiveSession(service, { nodes: [{ id: 1 }] });

    await expect(service.$stopProfile(BOUND_CLIENT_ID)).resolves.toBe(true);
    await expect(service.$stopProfile(BOUND_CLIENT_ID)).resolves.toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('retains a session after a failed stop so the same inspector can be retried without overlap', async () => {
    const extensionService = createExtensionService();
    const { service } = createProfilerService({ extensionService });
    const stopError = new Error('inspector stop failed');
    const stop = jest
      .fn()
      .mockRejectedValueOnce(stopError)
      .mockResolvedValueOnce({ profile: { nodes: [{ id: 23 }] } });
    setActiveSession(service, { nodes: [{ id: 23 }] }, stop);

    await expect(service.$stopProfile(BOUND_CLIENT_ID)).resolves.toBe(false);
    await service.$startProfile(BOUND_CLIENT_ID);

    expect(extensionService.tryEnableInspectPort).toHaveBeenCalledTimes(1);
    expect(extensionService.getProcessInspectPort).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
    await expect(service.$stopProfile(BOUND_CLIENT_ID)).resolves.toBe(true);
    expect(stop).toHaveBeenCalledTimes(2);
    await expect(service.$stopProfile(BOUND_CLIENT_ID)).resolves.toBe(false);
  });

  it('retires a failed old inspector generation and attaches the replacement inspect port', async () => {
    const extensionService = createExtensionService();
    let inspectPort = 9230;
    extensionService.getProcessInspectPort.mockImplementation(async () => inspectPort);
    const oldStop = jest.fn().mockRejectedValue(new Error('old inspector is gone'));
    const replacementStop = jest.fn().mockResolvedValue({ profile: { nodes: [{ id: 31 }] } });
    mockStartProfiling.mockResolvedValueOnce({ stop: oldStop }).mockResolvedValueOnce({ stop: replacementStop });
    const { injector, service } = createProfilerService({
      extensionService,
      lifecycleOptions: { startProfiler: mockStartProfiling },
    });

    await service.$startProfile(BOUND_CLIENT_ID);
    expect(getSessionMap(service).get(BOUND_CLIENT_ID)?.inspectPort).toBe(9230);

    inspectPort = 9231;
    await expect(service.$startProfile(BOUND_CLIENT_ID)).resolves.toBeUndefined();

    expect(oldStop).toHaveBeenCalledTimes(2);
    expect(mockStartProfiling).toHaveBeenNthCalledWith(2, 9231);
    expect(getSessionMap(service).get(BOUND_CLIENT_ID)?.inspectPort).toBe(9231);
    await expect(service.$stopProfile(BOUND_CLIENT_ID)).resolves.toBe(true);
    expect(replacementStop).toHaveBeenCalledTimes(1);
    await expect(injector.disposeAll()).resolves.toBeDefined();
  });

  it('replaces a restarted Extension Host even when its inspect port is reused', async () => {
    const extensionService = createExtensionService();
    let processId = 4100;
    extensionService.getExtProcessId.mockImplementation(async () => processId);
    const oldStop = jest.fn().mockRejectedValue(new Error('old reused-port inspector is gone'));
    const replacementStop = jest.fn().mockResolvedValue({ profile: { nodes: [{ id: 37 }] } });
    mockStartProfiling.mockResolvedValueOnce({ stop: oldStop }).mockResolvedValueOnce({ stop: replacementStop });
    const { injector, service } = createProfilerService({
      extensionService,
      lifecycleOptions: { startProfiler: mockStartProfiling },
    });

    await service.$startProfile(BOUND_CLIENT_ID);
    expect(getSessionMap(service).get(BOUND_CLIENT_ID)).toMatchObject({ inspectPort: 9230, processId: 4100 });

    processId = 4200;
    await service.$startProfile(BOUND_CLIENT_ID);

    expect(oldStop).toHaveBeenCalledTimes(2);
    expect(mockStartProfiling).toHaveBeenCalledTimes(2);
    expect(getSessionMap(service).get(BOUND_CLIENT_ID)).toMatchObject({ inspectPort: 9230, processId: 4200 });
    await expect(service.$stopProfile(BOUND_CLIENT_ID)).resolves.toBe(true);
    expect(replacementStop).toHaveBeenCalledTimes(1);
    await expect(injector.disposeAll()).resolves.toBeDefined();
  });

  it('uses atomic runtime snapshots and retires a profiler when only the runtime generation changes', async () => {
    expect.hasAssertions();
    let runtimeGeneration = 1;
    const extensionService = createRuntimeSnapshotExtensionService(() => ({
      clientId: BOUND_CLIENT_ID,
      generation: runtimeGeneration,
      phase: 'ready',
      processId: 4100,
      inspectPort: 9230,
      hasConnection: true,
      hasMainThreadBridge: true,
    }));
    const oldStop = jest.fn().mockResolvedValue({ profile: { nodes: [{ id: 43 }] } });
    const replacementStop = jest.fn().mockResolvedValue({ profile: { nodes: [{ id: 47 }] } });
    mockStartProfiling.mockResolvedValueOnce({ stop: oldStop }).mockResolvedValueOnce({ stop: replacementStop });
    const { injector, service } = createProfilerService({
      extensionService,
      lifecycleOptions: { startProfiler: mockStartProfiling },
    });

    await service.$startProfile(BOUND_CLIENT_ID);
    expect(getSessionMap(service).get(BOUND_CLIENT_ID)).toMatchObject({
      inspectPort: 9230,
      processId: 4100,
      runtimeGeneration: 1,
    });

    runtimeGeneration = 2;
    await service.$startProfile(BOUND_CLIENT_ID);

    expect(oldStop).toHaveBeenCalledTimes(1);
    expect(mockStartProfiling).toHaveBeenCalledTimes(2);
    expect(mockStartProfiling).toHaveBeenNthCalledWith(2, 9230);
    expect(getSessionMap(service).get(BOUND_CLIENT_ID)).toMatchObject({
      inspectPort: 9230,
      processId: 4100,
      runtimeGeneration: 2,
    });
    expect(extensionService.getRuntimeHandleSnapshot).toHaveBeenCalledTimes(5);
    expect(extensionService.getRuntimeHandleSnapshot).toHaveBeenCalledWith(BOUND_CLIENT_ID);
    expect(extensionService.getExtProcessId).not.toHaveBeenCalled();
    expect(extensionService.getProcessInspectPort).not.toHaveBeenCalled();
    await expect(service.$stopProfile(BOUND_CLIENT_ID)).resolves.toBe(true);
    expect(replacementStop).toHaveBeenCalledTimes(1);
    await expect(injector.disposeAll()).resolves.toBeDefined();
  });

  it.each<[string, ExtensionHostRuntimeSnapshot]>([
    [
      'starting',
      {
        clientId: BOUND_CLIENT_ID,
        generation: 1,
        phase: 'starting',
        processId: 4100,
        inspectPort: 9230,
        hasConnection: true,
        hasMainThreadBridge: false,
      },
    ],
    [
      'stopping',
      {
        clientId: BOUND_CLIENT_ID,
        generation: 1,
        phase: 'stopping',
        processId: 4100,
        inspectPort: 9230,
        hasConnection: true,
        hasMainThreadBridge: false,
      },
    ],
    [
      'ready without an inspect endpoint',
      {
        clientId: BOUND_CLIENT_ID,
        generation: 1,
        phase: 'ready',
        processId: 4100,
        hasConnection: true,
        hasMainThreadBridge: true,
      },
    ],
  ])('does not start profiling from a %s runtime snapshot', async (_caseName, snapshot) => {
    expect.hasAssertions();
    const extensionService = createRuntimeSnapshotExtensionService(() => snapshot);
    const { injector, service } = createProfilerService({
      extensionService,
      lifecycleOptions: { startProfiler: mockStartProfiling },
    });

    await expect(service.$startProfile(BOUND_CLIENT_ID)).resolves.toBeUndefined();

    expect(extensionService.tryEnableInspectPort).toHaveBeenCalledTimes(1);
    expect(extensionService.getRuntimeHandleSnapshot).toHaveBeenCalledTimes(1);
    expect(mockStartProfiling).not.toHaveBeenCalled();
    expect(getSessionMap(service).size).toBe(0);
    expect(extensionService.getExtProcessId).not.toHaveBeenCalled();
    expect(extensionService.getProcessInspectPort).not.toHaveBeenCalled();
    await expect(injector.disposeAll()).resolves.toBeDefined();
  });

  it('discards an in-flight stale attachment and CAS-installs the current Host generation', async () => {
    const extensionService = createExtensionService();
    let processId = 4100;
    let inspectPort = 9230;
    extensionService.getExtProcessId.mockImplementation(async () => processId);
    extensionService.getProcessInspectPort.mockImplementation(async () => inspectPort);
    const staleStart = createDeferred<{ stop: jest.Mock }>();
    const staleStartCalled = createDeferred<void>();
    const staleStop = jest.fn().mockResolvedValue({ profile: { nodes: [] } });
    const currentStop = jest.fn().mockResolvedValue({ profile: { nodes: [{ id: 41 }] } });
    mockStartProfiling
      .mockImplementationOnce(() => {
        staleStartCalled.resolve();
        return staleStart.promise;
      })
      .mockResolvedValueOnce({ stop: currentStop });
    const { injector, service } = createProfilerService({
      extensionService,
      lifecycleOptions: { startProfiler: mockStartProfiling },
    });

    const firstStart = service.$startProfile(BOUND_CLIENT_ID);
    await staleStartCalled.promise;
    expect(mockStartProfiling).toHaveBeenCalledTimes(1);

    processId = 4200;
    inspectPort = 9231;
    const coalescedStart = service.$startProfile(BOUND_CLIENT_ID);
    staleStart.resolve({ stop: staleStop });
    await Promise.all([firstStart, coalescedStart]);

    expect(staleStop).toHaveBeenCalledTimes(1);
    expect(mockStartProfiling).toHaveBeenNthCalledWith(2, 9231);
    expect(getSessionMap(service).get(BOUND_CLIENT_ID)).toMatchObject({ inspectPort: 9231, processId: 4200 });
    await expect(service.$stopProfile(BOUND_CLIENT_ID)).resolves.toBe(true);
    expect(currentStop).toHaveBeenCalledTimes(1);
    await expect(injector.disposeAll()).resolves.toBeDefined();
  });

  it('waits for a stopping session before admitting a replacement start', async () => {
    const extensionService = createExtensionService();
    extensionService.tryEnableInspectPort.mockResolvedValue(false);
    const { service } = createProfilerService({ extensionService });
    const stopGate = createDeferred<{ profile: object }>();
    const stop = setActiveSession(
      service,
      { nodes: [{ id: 29 }] },
      jest.fn(() => stopGate.promise),
    );

    const stopRequest = service.$stopProfile(BOUND_CLIENT_ID);
    const replacementStart = service.$startProfile(BOUND_CLIENT_ID);
    await Promise.resolve();

    expect(extensionService.tryEnableInspectPort).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalledTimes(1);

    stopGate.resolve({ profile: { nodes: [{ id: 29 }] } });
    await expect(stopRequest).resolves.toBe(true);
    await replacementStart;
    expect(extensionService.tryEnableInspectPort).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent start requests before an inspector session can be created', async () => {
    const extensionService = createExtensionService();
    const admission = createDeferred<boolean>();
    extensionService.tryEnableInspectPort.mockReturnValue(admission.promise);
    const { service } = createProfilerService({ extensionService });

    const firstStart = service.$startProfile(BOUND_CLIENT_ID);
    const secondStart = service.$startProfile(BOUND_CLIENT_ID);

    expect(extensionService.tryEnableInspectPort).toHaveBeenCalledTimes(1);
    admission.resolve(false);
    await Promise.all([firstStart, secondStart]);
    expect(extensionService.tryEnableInspectPort).toHaveBeenCalledTimes(1);
    expect(extensionService.getProcessInspectPort).not.toHaveBeenCalled();
  });

  it('waits for an in-flight start before stopping the session it creates', async () => {
    const extensionService = createExtensionService();
    const admission = createDeferred<void>();
    let service: ExtensionProfilerService;
    const sessionStop = jest.fn().mockResolvedValue({ profile: { nodes: [{ id: 19 }] } });
    extensionService.tryEnableInspectPort.mockImplementation(async () => {
      await admission.promise;
      setActiveSession(service, { nodes: [{ id: 19 }] }, sessionStop);
      return false;
    });
    ({ service } = createProfilerService({ extensionService }));

    const startRequest = service.$startProfile(BOUND_CLIENT_ID);
    const stopRequest = service.$stopProfile(BOUND_CLIENT_ID);
    let stopSettled = false;
    void stopRequest.then(() => {
      stopSettled = true;
    });
    await Promise.resolve();

    expect(stopSettled).toBe(false);
    expect(sessionStop).not.toHaveBeenCalled();

    admission.resolve();
    await startRequest;
    await expect(stopRequest).resolves.toBe(true);
    expect(sessionStop).toHaveBeenCalledTimes(1);
    await expect(service.$stopProfile(BOUND_CLIENT_ID)).resolves.toBe(false);
  });

  it('awaits active profiler cleanup when the connection child injector is disposed', async () => {
    const extensionService = createExtensionService();
    extensionService.tryEnableInspectPort.mockResolvedValue(false);
    const { injector, service } = createProfilerService({ extensionService });
    const stopped = createDeferred<{ profile: object }>();
    const stop = jest.fn(() => stopped.promise);

    await service.$startProfile(BOUND_CLIENT_ID);
    setActiveSession(service, { nodes: [] }, stop);
    const disposal = injector.disposeAll();
    await Promise.resolve();

    expect(stop).toHaveBeenCalledTimes(1);
    let disposalSettled = false;
    void disposal.then(() => {
      disposalSettled = true;
    });
    await Promise.resolve();
    expect(disposalSettled).toBe(false);

    stopped.resolve({ profile: { nodes: [] } });
    await disposal;
    expect(disposalSettled).toBe(true);
  });

  it('retries a retained failed stop during connection cleanup', async () => {
    const { injector, service } = createProfilerService();
    const stop = jest
      .fn()
      .mockRejectedValueOnce(new Error('first stop failed'))
      .mockResolvedValueOnce({ profile: { nodes: [] } });
    setActiveSession(service, { nodes: [] }, stop);

    await expect(service.$stopProfile(BOUND_CLIENT_ID)).resolves.toBe(false);
    await expect(injector.disposeAll()).resolves.toBeDefined();

    expect(stop).toHaveBeenCalledTimes(2);
    expect((service as unknown as { sessionMap: Map<string, unknown> }).sessionMap.size).toBe(0);
  });

  it('retries, retires, and reports a session that still fails cleanup', async () => {
    const extensionService = createExtensionService();
    extensionService.tryEnableInspectPort.mockResolvedValue(false);
    const { injector, logger, service } = createProfilerService({ extensionService });
    await service.$startProfile(BOUND_CLIENT_ID);
    const stopError = new Error('cleanup stop failed');
    const stop = setActiveSession(service, { nodes: [] }, jest.fn().mockRejectedValue(stopError));

    const cleanupError = await injector.disposeAll().catch((error) => error as AggregateError);

    expect(cleanupError).toBeInstanceOf(AggregateError);
    expect(cleanupError).toMatchObject({ message: CLEANUP_ERROR });
    expect(cleanupError.errors).toEqual([stopError, stopError]);
    expect(stop).toHaveBeenCalledTimes(2);
    expect(getSessionMap(service).has(BOUND_CLIENT_ID)).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to clean up one or more extension profiling sessions.',
      cleanupError,
    );
  });

  it('rejects late stop and save calls after connection disposal without stopping twice', async () => {
    const extensionService = createExtensionService();
    extensionService.tryEnableInspectPort.mockResolvedValue(false);
    const { fileService, injector, service } = createProfilerService({ extensionService });
    const stop = setActiveSession(service, { nodes: [] });

    await service.$startProfile(BOUND_CLIENT_ID);
    await injector.disposeAll();

    await expect(service.$stopProfile(BOUND_CLIENT_ID)).rejects.toThrow(PROFILE_LIFECYCLE_ERROR);
    await expect(service.$saveLastProfile(path.join(os.tmpdir(), 'late.cpuprofile'))).rejects.toThrow(
      PROFILE_LIFECYCLE_ERROR,
    );
    expect(stop).toHaveBeenCalledTimes(1);
    expect(fileService.getFileStat).not.toHaveBeenCalled();
  });

  it('bounds cleanup when a session start never settles and retires the late session without reattaching it', async () => {
    jest.useFakeTimers();
    try {
      const extensionService = createExtensionService();
      const sessionStart = createDeferred<{ stop: jest.Mock }>();
      const startProfiler = jest.fn(() => sessionStart.promise);
      const lateStop = jest.fn().mockResolvedValue({ profile: { nodes: [] } });
      const { injector, service } = createProfilerService({
        extensionService,
        lifecycleOptions: { cleanupLeaseMs: 100, startProfiler },
      });
      const startRequest = service.$startProfile(BOUND_CLIENT_ID).catch((error) => error as Error);
      await jest.advanceTimersByTimeAsync(0);
      expect(startProfiler).toHaveBeenCalledTimes(1);
      const disposalResult = injector.disposeAll().catch((error) => error as Error);

      await jest.advanceTimersByTimeAsync(100);
      await expect(disposalResult).resolves.toMatchObject({ message: CLEANUP_ERROR });
      expect(getSessionMap(service).size).toBe(0);

      sessionStart.resolve({ stop: lateStop });
      await expect(startRequest).resolves.toMatchObject({ message: PROFILE_LIFECYCLE_ERROR });
      await jest.advanceTimersByTimeAsync(0);
      expect(lateStop).toHaveBeenCalledTimes(1);
      expect(getSessionMap(service).size).toBe(0);
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('bounds cleanup around a never-settling stop, retires its handle, and never double-stops it', async () => {
    jest.useFakeTimers();
    try {
      const { injector, service } = createProfilerService({ lifecycleOptions: { cleanupLeaseMs: 100 } });
      const stopped = createDeferred<{ profile: object }>();
      const stop = setActiveSession(
        service,
        { nodes: [] },
        jest.fn(() => stopped.promise),
      );
      const stopRequest = service.$stopProfile(BOUND_CLIENT_ID);
      const disposalResult = injector.disposeAll().catch((error) => error as Error);

      await jest.advanceTimersByTimeAsync(100);
      await expect(disposalResult).resolves.toMatchObject({ message: CLEANUP_ERROR });
      expect(stop).toHaveBeenCalledTimes(1);
      expect(getSessionMap(service).size).toBe(0);

      stopped.reject(new Error('late inspector stop rejection'));
      await expect(stopRequest).rejects.toThrow(PROFILE_LIFECYCLE_ERROR);
      await jest.runOnlyPendingTimersAsync();
    } finally {
      jest.useRealTimers();
    }
  });

  it('handles disposeOne cleanup rejection while the tail provider still propagates the same evidence', async () => {
    const extensionService = createExtensionService();
    extensionService.tryEnableInspectPort.mockResolvedValue(false);
    const { injector, service } = createProfilerService({ extensionService });
    await service.$startProfile(BOUND_CLIENT_ID);
    const stop = setActiveSession(service, { nodes: [] }, jest.fn().mockRejectedValue(new Error('disposeOne stop')));
    const unhandledRejection = jest.fn();
    process.on('unhandledRejection', unhandledRejection);

    try {
      expect(injector.disposeOne(ExtensionProfilerService)).toBeUndefined();
      const cleanupPromise = (service as unknown as { lifecycle: { cleanupPromise: Promise<void> } }).lifecycle
        .cleanupPromise;
      await expect(cleanupPromise).rejects.toMatchObject({ message: CLEANUP_ERROR });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandledRejection).not.toHaveBeenCalled();

      await expect(injector.disposeAll()).rejects.toMatchObject({ message: CLEANUP_ERROR });
      expect(stop).toHaveBeenCalledTimes(2);
      expect(getSessionMap(service).size).toBe(0);
    } finally {
      process.off('unhandledRejection', unhandledRejection);
    }
  });
});

describe('ExtensionProfilerService profile persistence', () => {
  it('overwrites an existing profile through the connection-scoped file service', async () => {
    const fileService = createFileService();
    const existingStat = { isDirectory: false, uri: 'file:///tmp/existing.cpuprofile' };
    fileService.getFileStat.mockResolvedValue(existingStat);
    const { service } = createProfilerService({ fileService });
    const profile = { nodes: [{ id: 7 }] };
    const savePath = path.join(os.tmpdir(), 'existing.cpuprofile');
    const saveUri = Uri.file(savePath).toString();
    setLastProfile(service, profile);

    await service.$saveLastProfile(savePath);

    expect(fileService.getFileStat).toHaveBeenCalledWith(saveUri);
    expect(fileService.setContent).toHaveBeenCalledWith(existingStat, JSON.stringify(profile, null, '\t'));
    expect(fileService.createFile).not.toHaveBeenCalled();
  });

  it('creates a missing profile through the connection-scoped file service', async () => {
    const fileService = createFileService();
    const { service } = createProfilerService({ fileService });
    const profile = { nodes: [{ id: 11 }] };
    const savePath = path.join(os.tmpdir(), 'created.cpuprofile');
    const saveUri = Uri.file(savePath).toString();
    setLastProfile(service, profile);

    await service.$saveLastProfile(savePath);

    expect(fileService.getFileStat).toHaveBeenCalledWith(saveUri);
    expect(fileService.createFile).toHaveBeenCalledWith(saveUri, {
      content: JSON.stringify(profile, null, '\t'),
    });
    expect(fileService.setContent).not.toHaveBeenCalled();
  });

  it('does not leak block policy details and retains the last profile after a failed write', async () => {
    expect.hasAssertions();
    const profile = { nodes: [{ id: 17 }] };
    const savePath = path.join(os.tmpdir(), 'blocked.cpuprofile');
    const retryPath = path.join(os.tmpdir(), 'retry.cpuprofile');
    const blockedUri = Uri.file(savePath).toString();
    const provider = {
      onDidChangeFile: jest.fn(() => ({ dispose: jest.fn() })),
      stat: jest.fn().mockResolvedValue(undefined),
      writeFile: jest.fn(async (uri) => ({ isDirectory: false, uri: uri.toString() })),
    } as unknown as FileSystemProvider;
    const logger = createLogger();
    const extensionService = createExtensionService();
    const injector = new Injector([
      { token: AppConfig, useValue: { blockPatterns: [blockedUri] } },
      { token: CLIENT_ID_TOKEN, useValue: BOUND_CLIENT_ID },
      { token: IDiskFileProvider, useValue: provider },
      { token: IExtensionNodeService, useValue: extensionService },
      { token: INodeLogger, useValue: logger },
      { token: IFileService, useFactory: (scope: Injector) => getSafeFileservice(scope) },
      DefaultExtensionHostProfilerTargetSource,
      ExtensionHostProfilerCoordinator,
      ExtensionProfilerService,
    ]);
    const service = injector.get(ExtensionProfilerService);
    setLastProfile(service, profile);

    let saveError: Error | undefined;
    try {
      await service.$saveLastProfile(savePath);
    } catch (error) {
      saveError = error as Error;
    }
    expect(saveError?.message).toBe(PROFILE_SAVE_ERROR);
    expect(saveError?.message).not.toContain(blockedUri);
    expect(provider.stat).not.toHaveBeenCalled();

    await service.$saveLastProfile(retryPath);
    expect(provider.writeFile).toHaveBeenCalledTimes(1);
    const [, writtenContent] = (provider.writeFile as jest.Mock).mock.calls[0];
    expect(Buffer.from(writtenContent).toString()).toBe(JSON.stringify(profile, null, '\t'));
    await injector.disposeAll();
  });

  it.each(['', 'relative.cpuprofile', 'https://example.test/profile.cpuprofile', 'file:///tmp/profile.cpuprofile'])(
    'rejects an empty, non-absolute, or URI save path before file access: %p',
    async (savePath) => {
      const { fileService, service } = createProfilerService();

      await expect(service.$saveLastProfile(savePath)).rejects.toThrow(PROFILE_PATH_ERROR);
      expect(fileService.getFileStat).not.toHaveBeenCalled();
      expect(fileService.setContent).not.toHaveBeenCalled();
      expect(fileService.createFile).not.toHaveBeenCalled();
    },
  );
});
