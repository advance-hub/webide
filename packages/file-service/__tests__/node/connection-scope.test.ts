jest.mock('fs-extra', () => {
  const actual = jest.requireActual('fs-extra');
  return {
    ...actual,
    remove: jest.fn(actual.remove),
    rename: jest.fn(actual.rename),
  };
});

import * as fse from 'fs-extra';

import { Injector, Token } from '@opensumi/di';
import { WSChannel } from '@opensumi/ide-connection';
import {
  AppConfig,
  ConnectionScopeRetirement,
  IConnectionScopeRetirement,
  INodeLogger,
  ServerConnectionRegistry,
  URI,
} from '@opensumi/ide-core-node';

import { FileStat, FileSystemProvider, IDiskFileProvider } from '../../src/common';
import { FileService, FileSystemNodeOptions, getFileservice, getSafeFileservice } from '../../src/node';
import { DiskFileSystemProvider } from '../../src/node/disk-file-system.provider';

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createProvider(overrides: Partial<FileSystemProvider> = {}): FileSystemProvider {
  return {
    onDidChangeFile: jest.fn(() => ({ dispose: jest.fn() })),
    unwatch: jest.fn(),
    watch: jest.fn(),
    ...overrides,
  } as unknown as FileSystemProvider;
}

function createFileService(provider: FileSystemProvider): FileService {
  const logger = {
    debug: jest.fn(),
    error: jest.fn(),
    log: jest.fn(),
    warn: jest.fn(),
  } as unknown as INodeLogger;
  const injector = new Injector([
    { token: IDiskFileProvider, useValue: provider },
    { token: INodeLogger, useValue: logger },
  ]);
  return injector.get(FileService, [FileSystemNodeOptions.DEFAULT]);
}

describe('connection-scoped file services', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('waits for every watcher provider handle before disposal resolves', async () => {
    expect.hasAssertions();

    const unwatchDisposal = createDeferred();
    const provider = createProvider({
      watch: jest.fn(async () => 41),
      unwatch: jest.fn(() => unwatchDisposal.promise),
    });
    const fileService = createFileService(provider);
    const fileChangeListener = fileService.onFilesChanged(jest.fn());

    await fileService.watchFileChanges('file:///tmp/opensumi-watcher-lifecycle');
    expect((fileService as any).onFileChangedEmitter.listenerSize).toBe(1);
    const disposal = fileService.disposeAsync();

    expect(provider.unwatch).toHaveBeenCalledTimes(1);
    expect(provider.unwatch).toHaveBeenCalledWith(41);
    expect((fileService as any).onFileChangedEmitter.listenerSize).toBe(0);

    let disposalSettled = false;
    void disposal.then(() => {
      disposalSettled = true;
    });
    await Promise.resolve();
    expect(disposalSettled).toBe(false);

    unwatchDisposal.resolve();
    await disposal;

    expect(disposalSettled).toBe(true);
    expect((fileService as any).watcherDisposerMap.size).toBe(0);
    expect((fileService as any).watcherWithSchemaMap.size).toBe(0);
    fileChangeListener.dispose();
    await expect(fileService.watchFileChanges('file:///tmp/rejected-after-dispose')).rejects.toThrow(
      'cannot accept new watchers',
    );
  });

  test('reclaims a provider watcher whose registration finishes during disposal', async () => {
    expect.hasAssertions();

    const watcherRegistration = createDeferred<number>();
    const unwatchDisposal = createDeferred();
    const provider = createProvider({
      watch: jest.fn(() => watcherRegistration.promise),
      unwatch: jest.fn(() => unwatchDisposal.promise),
    });
    const fileService = createFileService(provider);

    const watcher = fileService.watchFileChanges('file:///tmp/opensumi-pending-watcher');
    const watcherResult = watcher.catch((error) => error as Error);
    const disposal = fileService.disposeAsync();

    watcherRegistration.resolve(73);
    await Promise.resolve();
    await Promise.resolve();

    expect(provider.unwatch).toHaveBeenCalledWith(73);

    let disposalSettled = false;
    void disposal.then(() => {
      disposalSettled = true;
    });
    await Promise.resolve();
    expect(disposalSettled).toBe(false);

    unwatchDisposal.resolve();
    expect((await watcherResult).message).toContain('disposed while registering a watcher');
    await disposal;

    expect(disposalSettled).toBe(true);
    expect((fileService as any).watcherDisposerMap.size).toBe(0);
  });

  test('evicts disk and safe file-service caches when the owning injector is disposed', async () => {
    expect.hasAssertions();

    const diskProviderToken = Symbol('DiskProvider') as Token;
    const firstDiskProvider = createProvider();
    const secondDiskProvider = createProvider();
    let currentDiskProvider = firstDiskProvider;
    const diskCleanup: Array<{ dispose(): void | Promise<void> }> = [];
    const diskInjector = {
      addProviders: (provider: { useValue: { dispose(): void | Promise<void> } }) => {
        diskCleanup.push(provider.useValue);
      },
      disposeAll: async () => {
        await Promise.all(diskCleanup.map((cleanup) => cleanup.dispose()));
      },
      get: () => currentDiskProvider,
    } as unknown as Injector;

    expect(getFileservice(diskInjector, diskProviderToken)).toBe(firstDiskProvider);
    currentDiskProvider = secondDiskProvider;
    expect(getFileservice(diskInjector, diskProviderToken)).toBe(firstDiskProvider);
    await (diskInjector as any).disposeAll();
    expect(getFileservice(diskInjector, diskProviderToken)).toBe(secondDiskProvider);

    const safeCleanup: Array<{ dispose(): void | Promise<void> }> = [];
    let safeFileServiceVersion = 0;
    const safeFileServiceDisposals: jest.Mock[] = [];
    const safeInjector = {
      addProviders: (provider: { useValue: { dispose(): void | Promise<void> } }) => {
        safeCleanup.push(provider.useValue);
      },
      disposeAll: async () => {
        await Promise.all(safeCleanup.map((cleanup) => cleanup.dispose()));
      },
      get: (token: Token) => {
        if (token === AppConfig) {
          return { blockPatterns: [] };
        }
        if (token === FileService) {
          safeFileServiceVersion += 1;
          const dispose = jest.fn(async () => undefined);
          safeFileServiceDisposals.push(dispose);
          return { dispose, version: safeFileServiceVersion };
        }
        throw new Error(`Unexpected token: ${String(token)}`);
      },
    } as unknown as Injector;

    const firstSafeFileService = getSafeFileservice(safeInjector);
    expect(getSafeFileservice(safeInjector)).toBe(firstSafeFileService);
    await (safeInjector as any).disposeAll();
    expect(safeFileServiceDisposals[0]).toHaveBeenCalledTimes(1);
    expect(getSafeFileservice(safeInjector)).not.toBe(firstSafeFileService);
  });

  test('owns a transient safe FileService through a real injector cleanup provider', async () => {
    expect.hasAssertions();

    const provider = createProvider();
    const logger = {
      debug: jest.fn(),
      error: jest.fn(),
      log: jest.fn(),
      warn: jest.fn(),
    } as unknown as INodeLogger;
    const injector = new Injector([
      { token: AppConfig, useValue: { blockPatterns: [] } },
      { token: IDiskFileProvider, useValue: provider },
      { token: INodeLogger, useValue: logger },
    ]);
    const fileService = getSafeFileservice(injector) as FileService;
    const disposeSpy = jest.spyOn(fileService, 'disposeAsync');

    await injector.disposeAll();

    expect(disposeSpy).toHaveBeenCalledTimes(1);
    expect((fileService as any).onFileChangedEmitter.listenerSize).toBe(0);
  });

  test('serializes watcher unwatch work before the disk provider shuts down', async () => {
    expect.hasAssertions();

    const unwatchDisposal = createDeferred();
    const watcherProcessManager = {
      dispose: jest.fn(async () => undefined),
      unWatch: jest.fn(() => unwatchDisposal.promise),
    };
    const provider = Object.create(DiskFileSystemProvider.prototype) as DiskFileSystemProvider;
    Object.defineProperties(provider, {
      pendingFileWrites: { value: new Map<string, Promise<void>>() },
      pendingMutations: { value: new Set<Promise<unknown>>() },
      pendingWatcherInitializations: { value: new Set<Promise<void>>() },
      pendingWatcherRegistrations: { value: new Set<Promise<void>>() },
      pendingWatcherDisposals: { value: new Set<Promise<void>>() },
      watcherProcessManager: { value: watcherProcessManager },
    });

    const unwatch = provider.unwatchAsync(91);
    const disposal = provider.dispose();

    await Promise.resolve();
    expect(watcherProcessManager.dispose).not.toHaveBeenCalled();

    unwatchDisposal.resolve();
    await unwatch;
    await disposal;

    expect(watcherProcessManager.unWatch).toHaveBeenCalledWith(91);
    expect(watcherProcessManager.dispose).toHaveBeenCalledTimes(1);
  });

  test('reports watcher cleanup failure after the disk provider still shuts down', async () => {
    expect.hasAssertions();

    const cleanupError = new Error('watcher cleanup failed');
    const watcherProcessManager = {
      dispose: jest.fn(async () => undefined),
      unWatch: jest.fn(async () => {
        throw cleanupError;
      }),
    };
    const provider = Object.create(DiskFileSystemProvider.prototype) as DiskFileSystemProvider;
    Object.defineProperties(provider, {
      pendingFileWrites: { value: new Map<string, Promise<void>>() },
      pendingMutations: { value: new Set<Promise<unknown>>() },
      pendingWatcherInitializations: { value: new Set<Promise<void>>() },
      pendingWatcherRegistrations: { value: new Set<Promise<void>>() },
      pendingWatcherDisposals: { value: new Set<Promise<void>>() },
      watcherProcessManager: { value: watcherProcessManager },
    });

    const unwatch = provider.unwatchAsync(93);
    const disposal = provider.dispose();

    await expect(unwatch).rejects.toBe(cleanupError);
    await expect(disposal).rejects.toBe(cleanupError);
    expect(watcherProcessManager.dispose).toHaveBeenCalledTimes(1);
  });

  test('lets global disk-provider disposal own late unwatch requests', async () => {
    expect.hasAssertions();

    const providerDisposal = createDeferred();
    const watcherProcessManager = {
      dispose: jest.fn(() => providerDisposal.promise),
      unWatch: jest.fn(async () => undefined),
    };
    const provider = Object.create(DiskFileSystemProvider.prototype) as DiskFileSystemProvider;
    Object.defineProperties(provider, {
      pendingFileWrites: { value: new Map<string, Promise<void>>() },
      pendingMutations: { value: new Set<Promise<unknown>>() },
      pendingWatcherInitializations: { value: new Set<Promise<void>>() },
      pendingWatcherRegistrations: { value: new Set<Promise<void>>() },
      pendingWatcherDisposals: { value: new Set<Promise<void>>() },
      watcherProcessManager: { value: watcherProcessManager },
    });

    const disposal = provider.dispose();
    const lateUnwatch = provider.unwatchAsync(92);

    expect(lateUnwatch).toBe(disposal);
    expect(watcherProcessManager.unWatch).not.toHaveBeenCalled();

    providerDisposal.resolve();
    await lateUnwatch;

    expect(watcherProcessManager.dispose).toHaveBeenCalledTimes(1);
  });

  test('reclaims a watcher that finishes registering after disk-provider disposal starts', async () => {
    expect.hasAssertions();

    const watcherRegistration = createDeferred<number>();
    const lateWatcherCleanup = createDeferred();
    const lifecycle: string[] = [];
    const watcherProcessManager = {
      dispose: jest.fn(async () => {
        lifecycle.push('manager-dispose');
      }),
      unWatch: jest.fn(async () => {
        lifecycle.push('late-unwatch-start');
        await lateWatcherCleanup.promise;
        lifecycle.push('late-unwatch-finish');
      }),
      watch: jest.fn(() => {
        lifecycle.push('watch-start');
        return watcherRegistration.promise;
      }),
      whenReady: Promise.resolve(),
    };
    const provider = Object.create(DiskFileSystemProvider.prototype) as DiskFileSystemProvider;
    Object.defineProperties(provider, {
      pendingFileWrites: { value: new Map<string, Promise<void>>() },
      pendingMutations: { value: new Set<Promise<unknown>>() },
      pendingWatcherInitializations: { value: new Set<Promise<void>>() },
      pendingWatcherRegistrations: { value: new Set<Promise<void>>() },
      pendingWatcherDisposals: { value: new Set<Promise<void>>() },
      recursive: { value: true },
      watcherProcessManager: { value: watcherProcessManager },
    });
    const uri = URI.file('/tmp/opensumi-late-disk-watcher').codeUri.toJSON();

    const watcherResult = provider.watch(uri).catch((error) => error as Error);
    await Promise.resolve();
    expect(watcherProcessManager.watch).toHaveBeenCalledTimes(1);

    const disposal = provider.dispose();
    expect(provider.dispose()).toBe(disposal);
    await expect(provider.watch(uri)).rejects.toThrow('cannot accept new watchers');
    expect(watcherProcessManager.watch).toHaveBeenCalledTimes(1);
    expect(watcherProcessManager.dispose).not.toHaveBeenCalled();

    watcherRegistration.resolve(94);
    await Promise.resolve();
    await Promise.resolve();

    expect(watcherProcessManager.unWatch).toHaveBeenCalledWith(94);
    expect(watcherProcessManager.dispose).not.toHaveBeenCalled();

    let watcherSettled = false;
    void watcherResult.then(() => {
      watcherSettled = true;
    });
    await Promise.resolve();
    expect(watcherSettled).toBe(false);

    lateWatcherCleanup.resolve();
    expect((await watcherResult).message).toContain('disposed while registering a watcher');
    await disposal;

    expect(watcherProcessManager.dispose).toHaveBeenCalledTimes(1);
    expect(lifecycle).toEqual(['watch-start', 'late-unwatch-start', 'late-unwatch-finish', 'manager-dispose']);
  });

  test('waits for a late watcher-process initialization before final manager cleanup', async () => {
    expect.hasAssertions();

    const processCreation = createDeferred<number>();
    const lifecycle: string[] = [];
    let processRunning = false;
    const watcherProcessManager = {
      createProcess: jest.fn(async () => {
        lifecycle.push('create-start');
        const pid = await processCreation.promise;
        processRunning = true;
        lifecycle.push('create-finish');
        return pid;
      }),
      dispose: jest.fn(async () => {
        lifecycle.push('manager-dispose');
        processRunning = false;
      }),
    };
    const provider = Object.create(DiskFileSystemProvider.prototype) as DiskFileSystemProvider;
    Object.defineProperties(provider, {
      pendingFileWrites: { value: new Map<string, Promise<void>>() },
      pendingMutations: { value: new Set<Promise<unknown>>() },
      pendingWatcherInitializations: { value: new Set<Promise<void>>() },
      pendingWatcherRegistrations: { value: new Set<Promise<void>>() },
      pendingWatcherDisposals: { value: new Set<Promise<void>>() },
      watcherProcessManager: { value: watcherProcessManager },
    });

    const initializationResult = provider.initialize('late-client').catch((error) => error as Error);
    expect(watcherProcessManager.createProcess).toHaveBeenCalledWith('late-client', undefined);

    const disposal = provider.dispose();
    expect(provider.dispose()).toBe(disposal);
    await expect(provider.initialize('rejected-client')).rejects.toThrow('cannot initialize the watcher process');
    expect(watcherProcessManager.createProcess).toHaveBeenCalledTimes(1);
    expect(watcherProcessManager.dispose).not.toHaveBeenCalled();

    processCreation.resolve(4201);
    expect((await initializationResult).message).toContain('disposed while initializing the watcher process');
    await disposal;

    expect(processRunning).toBe(false);
    expect(watcherProcessManager.dispose).toHaveBeenCalledTimes(1);
    expect(lifecycle).toEqual(['create-start', 'create-finish', 'manager-dispose']);
  });

  test('drains admitted file writes and rejects new writes before manager cleanup', async () => {
    expect.hasAssertions();

    const fileWrite = createDeferred();
    const lifecycle: string[] = [];
    const doWriteFile = jest.fn(async () => {
      lifecycle.push('write-start');
      await fileWrite.promise;
      lifecycle.push('write-finish');
    });
    const watcherProcessManager = {
      dispose: jest.fn(async () => {
        lifecycle.push('manager-dispose');
      }),
    };
    const provider = Object.create(DiskFileSystemProvider.prototype) as DiskFileSystemProvider;
    Object.defineProperties(provider, {
      doWriteFile: { value: doWriteFile },
      pendingFileWrites: { value: new Map<string, Promise<void>>() },
      pendingMutations: { value: new Set<Promise<unknown>>() },
      pendingWatcherInitializations: { value: new Set<Promise<void>>() },
      pendingWatcherRegistrations: { value: new Set<Promise<void>>() },
      pendingWatcherDisposals: { value: new Set<Promise<void>>() },
      watcherProcessManager: { value: watcherProcessManager },
    });
    const uri = URI.file('/tmp/opensumi-pending-write').codeUri.toJSON();

    const write = provider.writeFile(uri, new Uint8Array([1]), { create: true, overwrite: true });
    await Promise.resolve();
    expect(doWriteFile).toHaveBeenCalledTimes(1);

    const disposal = provider.dispose();
    await expect(provider.writeFile(uri, new Uint8Array([2]), { create: true, overwrite: true })).rejects.toThrow(
      'cannot accept new file mutations',
    );
    await expect(
      provider.writeFileWithStat(
        { uri: URI.file('/tmp/opensumi-rejected-write-with-stat').toString() } as FileStat,
        new Uint8Array([3]),
      ),
    ).rejects.toThrow('cannot accept new file mutations');
    expect(doWriteFile).toHaveBeenCalledTimes(1);
    expect(watcherProcessManager.dispose).not.toHaveBeenCalled();

    fileWrite.resolve();
    await write;
    await disposal;

    expect(watcherProcessManager.dispose).toHaveBeenCalledTimes(1);
    expect(lifecycle).toEqual(['write-start', 'write-finish', 'manager-dispose']);
  });

  test('drains every admitted disk mutation and rejects new mutations before manager cleanup', async () => {
    expect.hasAssertions();

    const createDirectory = createDeferred<FileStat>();
    const deleteFile = createDeferred();
    const renameFile = createDeferred<FileStat>();
    const copyFile = createDeferred<FileStat>();
    const lifecycle: string[] = [];
    const watcherProcessManager = {
      dispose: jest.fn(async () => {
        lifecycle.push('manager-dispose');
      }),
    };
    const provider = Object.create(DiskFileSystemProvider.prototype) as DiskFileSystemProvider;
    Object.defineProperties(provider, {
      doCopy: {
        value: jest.fn(() => {
          lifecycle.push('copy-start');
          return copyFile.promise.then((result) => {
            lifecycle.push('copy-finish');
            return result;
          });
        }),
      },
      doCreateDirectory: {
        value: jest.fn(() => {
          lifecycle.push('create-start');
          return createDirectory.promise.then((result) => {
            lifecycle.push('create-finish');
            return result;
          });
        }),
      },
      doDelete: {
        value: jest.fn(() => {
          lifecycle.push('delete-start');
          return deleteFile.promise.then(() => {
            lifecycle.push('delete-finish');
          });
        }),
      },
      doMove: {
        value: jest.fn(() => {
          lifecycle.push('rename-start');
          return renameFile.promise.then((result) => {
            lifecycle.push('rename-finish');
            return result;
          });
        }),
      },
      pendingFileWrites: { value: new Map<string, Promise<void>>() },
      pendingMutations: { value: new Set<Promise<unknown>>() },
      pendingWatcherInitializations: { value: new Set<Promise<void>>() },
      pendingWatcherRegistrations: { value: new Set<Promise<void>>() },
      pendingWatcherDisposals: { value: new Set<Promise<void>>() },
      watcherProcessManager: { value: watcherProcessManager },
    });
    const source = URI.file('/tmp/opensumi-mutation-source').codeUri.toJSON();
    const target = URI.file('/tmp/opensumi-mutation-target').codeUri.toJSON();
    const stat = { isDirectory: false, uri: URI.file('/tmp/opensumi-mutation-target').toString() } as FileStat;

    const admitted = [
      provider.createDirectory(target),
      provider.delete(source, { moveToTrash: false }),
      provider.rename(source, target, { overwrite: true }),
      provider.copy(source, target, { overwrite: true }),
    ];
    const disposal = provider.dispose();

    await expect(provider.createDirectory(target)).rejects.toThrow('cannot accept new file mutations');
    await expect(provider.delete(source, { moveToTrash: false })).rejects.toThrow('cannot accept new file mutations');
    await expect(provider.rename(source, target, { overwrite: true })).rejects.toThrow(
      'cannot accept new file mutations',
    );
    await expect(provider.copy(source, target, { overwrite: true })).rejects.toThrow(
      'cannot accept new file mutations',
    );
    expect(watcherProcessManager.dispose).not.toHaveBeenCalled();

    createDirectory.resolve(stat);
    deleteFile.resolve();
    renameFile.resolve(stat);
    copyFile.resolve(stat);
    await Promise.all(admitted);
    await disposal;

    expect(watcherProcessManager.dispose).toHaveBeenCalledTimes(1);
    expect(lifecycle.indexOf('manager-dispose')).toBeGreaterThan(lifecycle.indexOf('create-finish'));
    expect(lifecycle.indexOf('manager-dispose')).toBeGreaterThan(lifecycle.indexOf('delete-finish'));
    expect(lifecycle.indexOf('manager-dispose')).toBeGreaterThan(lifecycle.indexOf('rename-finish'));
    expect(lifecycle.indexOf('manager-dispose')).toBeGreaterThan(lifecycle.indexOf('copy-finish'));
  });

  test('waits for the renamed delete target to be removed before provider disposal', async () => {
    expect.hasAssertions();

    const removeTemporaryTarget = createDeferred();
    const rename = jest.mocked(fse.rename).mockResolvedValue(undefined);
    const remove = jest.mocked(fse.remove).mockReturnValue(removeTemporaryTarget.promise);
    const watcherProcessManager = {
      dispose: jest.fn(async () => undefined),
    };
    const provider = Object.create(DiskFileSystemProvider.prototype) as DiskFileSystemProvider;
    const sourcePath = '/tmp/opensumi-delete-source';
    const source = URI.file(sourcePath).codeUri.toJSON();
    Object.defineProperties(provider, {
      doGetStat: {
        value: jest.fn().mockResolvedValue({ uri: URI.file(sourcePath).toString(), isDirectory: false } as FileStat),
      },
      pendingFileWrites: { value: new Map<string, Promise<void>>() },
      pendingMutations: { value: new Set<Promise<unknown>>() },
      pendingWatcherInitializations: { value: new Set<Promise<void>>() },
      pendingWatcherRegistrations: { value: new Set<Promise<void>>() },
      pendingWatcherDisposals: { value: new Set<Promise<void>>() },
      watcherProcessManager: { value: watcherProcessManager },
    });

    const deletion = provider.delete(source, { moveToTrash: false });
    await flushAsyncWork();
    expect(rename).toHaveBeenCalledTimes(1);
    expect(remove).toHaveBeenCalledTimes(1);
    expect(remove.mock.calls[0][0]).not.toBe(sourcePath);

    const disposal = provider.dispose();
    await flushAsyncWork();
    expect(watcherProcessManager.dispose).not.toHaveBeenCalled();

    removeTemporaryTarget.resolve();
    await Promise.all([deletion, disposal]);

    expect(watcherProcessManager.dispose).toHaveBeenCalledTimes(1);
  });

  test('reports a rejected temporary delete cleanup and still disposes the provider', async () => {
    expect.hasAssertions();

    const removeTemporaryTarget = createDeferred();
    const cleanupError = new Error('temporary delete cleanup failed');
    jest.mocked(fse.rename).mockResolvedValue(undefined);
    const remove = jest.mocked(fse.remove).mockReturnValue(removeTemporaryTarget.promise);
    const logger = { warn: jest.fn() };
    const watcherProcessManager = {
      dispose: jest.fn(async () => undefined),
    };
    const provider = Object.create(DiskFileSystemProvider.prototype) as DiskFileSystemProvider;
    const sourcePath = '/tmp/opensumi-delete-rejection';
    const source = URI.file(sourcePath).codeUri.toJSON();
    Object.defineProperties(provider, {
      doGetStat: {
        value: jest.fn().mockResolvedValue({ uri: URI.file(sourcePath).toString(), isDirectory: false } as FileStat),
      },
      logger: { value: logger },
      pendingFileWrites: { value: new Map<string, Promise<void>>() },
      pendingMutations: { value: new Set<Promise<unknown>>() },
      pendingWatcherInitializations: { value: new Set<Promise<void>>() },
      pendingWatcherRegistrations: { value: new Set<Promise<void>>() },
      pendingWatcherDisposals: { value: new Set<Promise<void>>() },
      watcherProcessManager: { value: watcherProcessManager },
    });

    const deletion = provider.delete(source, { moveToTrash: false });
    await flushAsyncWork();
    const disposal = provider.dispose();
    removeTemporaryTarget.reject(cleanupError);

    await expect(deletion).rejects.toBe(cleanupError);
    await expect(disposal).resolves.toBeUndefined();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(
      'An admitted disk provider mutation failed while the provider was draining.',
      cleanupError,
    );
    expect(watcherProcessManager.dispose).toHaveBeenCalledTimes(1);
  });

  test('drains watcher exclude mutations, rejects late updates, and does not mutate caller input', async () => {
    expect.hasAssertions();

    const excludeUpdate = createDeferred();
    const lifecycle: string[] = [];
    const watcherProcessManager = {
      setWatcherFileExcludes: jest.fn(async () => {
        lifecycle.push('exclude-start');
        await excludeUpdate.promise;
        lifecycle.push('exclude-finish');
      }),
      dispose: jest.fn(async () => {
        lifecycle.push('manager-dispose');
      }),
    };
    const logger = { log: jest.fn(), warn: jest.fn() };
    const provider = Object.create(DiskFileSystemProvider.prototype) as DiskFileSystemProvider;
    Object.defineProperties(provider, {
      logger: { value: logger },
      pendingFileWrites: { value: new Map<string, Promise<void>>() },
      pendingMutations: { value: new Set<Promise<unknown>>() },
      pendingWatcherInitializations: { value: new Set<Promise<void>>() },
      pendingWatcherRegistrations: { value: new Set<Promise<void>>() },
      pendingWatcherDisposals: { value: new Set<Promise<void>>() },
      watchFileExcludes: { value: [], writable: true },
      watcherProcessManager: { value: watcherProcessManager },
    });
    const excludes = ['**/node_modules/*/**', '**/.git/**'];

    const update = provider.setWatchFileExcludes(excludes);
    await Promise.resolve();
    expect(excludes).toEqual(['**/node_modules/*/**', '**/.git/**']);
    expect(watcherProcessManager.setWatcherFileExcludes).toHaveBeenCalledWith(['**/node_modules/**', '**/.git/**']);
    expect(provider.getWatchFileExcludes()).toEqual([]);

    const disposal = provider.dispose();
    await expect(provider.setWatchFileExcludes(['**/late/**'])).rejects.toThrow('cannot accept new file mutations');
    expect(watcherProcessManager.dispose).not.toHaveBeenCalled();

    excludeUpdate.resolve();
    await Promise.all([update, disposal]);

    expect(lifecycle).toEqual(['exclude-start', 'exclude-finish', 'manager-dispose']);
    expect(watcherProcessManager.setWatcherFileExcludes).toHaveBeenCalledTimes(1);
    expect(provider.getWatchFileExcludes()).toEqual(['**/node_modules/**', '**/.git/**']);
  });

  test('bounds disconnected child cleanup and fences late file mutation and watcher initialization results', async () => {
    expect.hasAssertions();
    jest.useFakeTimers();

    const excludeUpdate = createDeferred();
    const watcherInitialization = createDeferred<number>();
    const logger = { log: jest.fn(), warn: jest.fn() };
    const watcherProcessManager = {
      createProcess: jest.fn(() => watcherInitialization.promise),
      dispose: jest.fn(async () => undefined),
      setWatcherFileExcludes: jest.fn(() => excludeUpdate.promise),
    };
    const provider = Object.create(DiskFileSystemProvider.prototype) as DiskFileSystemProvider;
    Object.defineProperties(provider, {
      logger: { value: logger },
      pendingFileWrites: { value: new Map<string, Promise<void>>() },
      pendingMutations: { value: new Set<Promise<unknown>>() },
      pendingWatcherInitializations: { value: new Set<Promise<void>>() },
      pendingWatcherRegistrations: { value: new Set<Promise<void>>() },
      pendingWatcherDisposals: { value: new Set<Promise<void>>() },
      watchFileExcludes: { value: [], writable: true },
      watcherProcessManager: { value: watcherProcessManager },
    });
    const retirement = new ConnectionScopeRetirement();

    const providerToken = Symbol('RetiredDiskProvider');
    const childInjector = new Injector([
      { token: IConnectionScopeRetirement, useValue: retirement },
      { token: providerToken, useValue: provider },
    ]);
    expect(getFileservice(childInjector, providerToken)).toBe(provider);
    const loggerNode = {
      error: jest.fn(),
      log: jest.fn(),
    } as unknown as INodeLogger;
    const registry = new ServerConnectionRegistry(loggerNode, { disconnectGraceMs: 20 });
    const inboundIdle = createDeferred();
    const childDisposed = jest.fn();
    const channel = new WSChannel({ send: jest.fn() } as any, { id: 'retired-file-scope-channel' });

    const excludeResult = provider.setWatchFileExcludes(['**/late/**']).catch((error) => error as Error);
    const initializationResult = provider.initialize('retired-file-client').catch((error) => error as Error);
    await Promise.resolve();
    expect(watcherProcessManager.setWatcherFileExcludes).toHaveBeenCalledTimes(1);
    expect(watcherProcessManager.createProcess).toHaveBeenCalledTimes(1);

    try {
      registry.trackConnection(
        channel,
        'retired-file-client',
        async () => {
          await childInjector.disposeAll();
          childDisposed();
        },
        {
          whenInboundIdle: () => inboundIdle.promise,
          retireDisconnectedScope: () => retirement.retire(),
        },
      );

      channel.close(1006, 'transport lost');
      jest.advanceTimersByTime(20);
      await registry.waitForIdle();

      expect(retirement.retired).toBe(true);
      expect(childDisposed).toHaveBeenCalledTimes(1);
      expect(registry.activeConnectionCount).toBe(0);
      expect(childInjector.instanceRefMap.size).toBe(0);
      expect(watcherProcessManager.dispose).toHaveBeenCalledTimes(1);
      expect(provider.getWatchFileExcludes()).toEqual([]);
      expect(jest.getTimerCount()).toBe(0);

      excludeUpdate.resolve();
      watcherInitialization.resolve(4401);
      expect((await excludeResult).message).toContain('connection scope retired');
      expect((await initializationResult).message).toContain('disposed while initializing');
      expect(provider.getWatchFileExcludes()).toEqual([]);
      expect(loggerNode.error).not.toHaveBeenCalled();
    } finally {
      inboundIdle.resolve();
      jest.useRealTimers();
    }
  });

  test('continues provider cleanup after an admitted mutation fails during drain', async () => {
    expect.hasAssertions();

    const mutation = createDeferred();
    const mutationError = new Error('admitted mutation failed');
    const logger = {
      warn: jest.fn(),
    };
    const watcherProcessManager = {
      dispose: jest.fn(async () => undefined),
    };
    const provider = Object.create(DiskFileSystemProvider.prototype) as DiskFileSystemProvider;
    Object.defineProperties(provider, {
      doDelete: { value: jest.fn(() => mutation.promise) },
      logger: { value: logger },
      pendingFileWrites: { value: new Map<string, Promise<void>>() },
      pendingMutations: { value: new Set<Promise<unknown>>() },
      pendingWatcherInitializations: { value: new Set<Promise<void>>() },
      pendingWatcherRegistrations: { value: new Set<Promise<void>>() },
      pendingWatcherDisposals: { value: new Set<Promise<void>>() },
      watcherProcessManager: { value: watcherProcessManager },
    });
    const uri = URI.file('/tmp/opensumi-failed-mutation').codeUri.toJSON();

    const admitted = provider.delete(uri, { moveToTrash: false });
    const disposal = provider.dispose();
    mutation.reject(mutationError);

    await expect(admitted).rejects.toBe(mutationError);
    await expect(disposal).resolves.toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(
      'An admitted disk provider mutation failed while the provider was draining.',
      mutationError,
    );
    expect(watcherProcessManager.dispose).toHaveBeenCalledTimes(1);
  });
});
