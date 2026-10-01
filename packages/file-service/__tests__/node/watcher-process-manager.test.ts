import path from 'path';

import { WatcherProcessManagerImpl } from '../../src/node/watcher-process-manager';

const createManager = (watcherHost?: string, watcherHostForkOptions?: Record<string, unknown>) => {
  const manager = Object.create(WatcherProcessManagerImpl.prototype) as WatcherProcessManagerImpl;
  Object.defineProperty(manager, 'appConfig', {
    value: { watcherHost, watcherHostForkOptions },
  });
  return manager;
};

describe('WatcherProcessManagerImpl', () => {
  const originalExtMode = process.env.EXT_MODE;
  const originalWatcherStdioDiagnostics = process.env.OPENSUMI_WATCHER_STDIO_DIAGNOSTICS;
  const originalNodeWatcherMode = process.env.OPENSUMI_NODE_WATCHER_MODE;
  const originalExecArgv = process.execArgv.slice();

  const createRuntimeManager = () => {
    const manager = createManager() as any;
    manager.disposing = false;
    manager.lifecycleGeneration = 0;
    manager.logger = { debug: jest.fn(), error: jest.fn(), log: jest.fn(), warn: jest.fn() };
    manager.closeWatcherServers = jest.fn().mockResolvedValue(undefined);
    manager.stopWatcherProcess = jest.fn().mockResolvedValue(undefined);
    manager.startNodeWatcherProcess = jest.fn().mockResolvedValue(1234);
    Object.defineProperty(manager, 'sharedNodeWatcherPool', { value: { acquire: jest.fn() } });
    return manager;
  };

  afterEach(() => {
    if (originalNodeWatcherMode === undefined) {
      delete process.env.OPENSUMI_NODE_WATCHER_MODE;
    } else {
      process.env.OPENSUMI_NODE_WATCHER_MODE = originalNodeWatcherMode;
    }
    if (originalExtMode === undefined) {
      delete process.env.EXT_MODE;
    } else {
      process.env.EXT_MODE = originalExtMode;
    }
    if (originalWatcherStdioDiagnostics === undefined) {
      delete process.env.OPENSUMI_WATCHER_STDIO_DIAGNOSTICS;
    } else {
      process.env.OPENSUMI_WATCHER_STDIO_DIAGNOSTICS = originalWatcherStdioDiagnostics;
    }
    process.execArgv.splice(0, process.execArgv.length, ...originalExecArgv);
  });

  it.each([undefined, 'per-client'])('keeps connection-owned watchers for mode %s', async (mode) => {
    expect.hasAssertions();
    const manager = createRuntimeManager();
    if (mode === undefined) {
      delete process.env.OPENSUMI_NODE_WATCHER_MODE;
    } else {
      process.env.OPENSUMI_NODE_WATCHER_MODE = mode;
    }
    expect(await manager.createProcess('private-client')).toBe(1234);
    expect(manager.startNodeWatcherProcess).toHaveBeenCalledWith('private-client', undefined);
    expect(manager.sharedNodeWatcherPool.acquire).not.toHaveBeenCalled();
    await manager.dispose();
  });

  it('routes an opted-in connection through its shared lease and releases only that lease', async () => {
    expect.hasAssertions();
    const manager = createRuntimeManager();
    process.env.OPENSUMI_NODE_WATCHER_MODE = 'shared';
    const lease = {
      pid: Promise.resolve(5678),
      watch: jest.fn().mockResolvedValue(73),
      unWatch: jest.fn().mockResolvedValue(undefined),
      setExcludes: jest.fn().mockResolvedValue(undefined),
      dispose: jest.fn().mockResolvedValue(undefined),
    };
    manager.sharedNodeWatcherPool.acquire.mockResolvedValue(lease);
    const client = { onDidFilesChanged: jest.fn() };
    manager.setClient(client);
    expect(await manager.createProcess('shared-client')).toBe(5678);
    await manager.whenReady;
    expect(manager.startNodeWatcherProcess).not.toHaveBeenCalled();
    const uri = { scheme: 'file', path: '/shared' };
    expect(await manager.watch(uri, { recursive: true })).toBe(73);
    expect(lease.watch).toHaveBeenCalledWith(uri, { recursive: true });
    await manager.setWatcherFileExcludes(['**/private/**']);
    expect(lease.setExcludes).toHaveBeenCalledWith(['**/private/**']);
    manager.sharedNodeWatcherPool.acquire.mock.calls[0][0].onDidFilesChanged({ changes: [] });
    expect(client.onDidFilesChanged).toHaveBeenCalledWith({ changes: [] });
    await manager.unWatch(73);
    expect(lease.unWatch).toHaveBeenCalledWith(73);
    await manager.dispose();
    expect(lease.dispose).toHaveBeenCalledTimes(1);
  });

  it('starts the shared host directly without recursively acquiring another shared lease', async () => {
    expect.hasAssertions();
    const manager = createRuntimeManager();
    process.env.OPENSUMI_NODE_WATCHER_MODE = 'shared';
    manager.useSharedNodeHost();
    expect(await manager.createProcess('pool-host')).toBe(1234);
    expect(manager.sharedNodeWatcherPool.acquire).not.toHaveBeenCalled();
    expect(manager.startNodeWatcherProcess).toHaveBeenCalledTimes(1);
    await manager.dispose();
  });

  it('uses source watcher host in js mode when configured host is the default built host', () => {
    expect.hasAssertions();
    process.env.EXT_MODE = 'js';
    const defaultBuiltWatcherHost = path.join(__dirname, '../../lib/node/hosted/watcher.process.js');
    const manager = createManager(defaultBuiltWatcherHost);

    expect(manager.watcherHost).toContain('packages/file-service/src/node/hosted/watcher.process.ts');
  });

  it('keeps custom configured watcher host in js mode', () => {
    expect.hasAssertions();
    process.env.EXT_MODE = 'js';
    const customWatcherHost = path.join(__dirname, 'custom-watcher.process.js');
    const manager = createManager(customWatcherHost);

    expect(manager.watcherHost).toBe(customWatcherHost);
  });

  it('keeps configured watcher host outside js mode', () => {
    expect.hasAssertions();
    delete process.env.EXT_MODE;
    const defaultBuiltWatcherHost = path.join(__dirname, '../../lib/node/hosted/watcher.process.js');
    const manager = createManager(defaultBuiltWatcherHost);

    expect(manager.watcherHost).toBe(defaultBuiltWatcherHost);
  });

  it('starts js-mode watcher process with clean transpile-only ts-node hooks', () => {
    expect.hasAssertions();
    process.env.EXT_MODE = 'js';
    process.execArgv.splice(
      0,
      process.execArgv.length,
      '--require',
      'ts-node/register',
      '--require',
      'source-map-support/register',
      '--inspect=9999',
    );

    const execArgv = (createManager() as any).getWatcherProcessExecArgv();

    expect(execArgv).toEqual([
      '--require',
      'ts-node/register/transpile-only',
      '--require',
      'tsconfig-paths/register',
      '--require',
      'source-map-support/register',
    ]);
  });

  it('gives the watcher process an independent heap limit', () => {
    expect.hasAssertions();
    process.env.EXT_MODE = 'js';
    process.execArgv.splice(0, process.execArgv.length, '--max-old-space-size=512');
    const manager = createManager(undefined, {
      execArgv: ['--max-old-space-size=256'],
    });

    const options = (manager as any).getWatcherProcessForkOptions();

    expect(options.execArgv).toContain('--max-old-space-size=256');
    expect(options.execArgv).not.toContain('--max-old-space-size=512');
    expect(options.silent).toBe(true);
  });

  it('enables Watcher Host console mirroring only for diagnostic smoke runs', () => {
    expect.assertions(2);
    process.env.OPENSUMI_WATCHER_STDIO_DIAGNOSTICS = '1';

    const options = (createManager() as any).getWatcherProcessForkOptions();

    expect(options.env.OPENSUMI_WATCHER_STDIO_DIAGNOSTICS).toBe('1');
    expect(options.env.KTLOG_SHOW_DEBUG).toBe('1');
  });

  it('fences and reclaims watcher startup that settles after manager disposal', async () => {
    expect.hasAssertions();
    let resolveStartup!: (pid: number) => void;
    const startup = new Promise<number>((resolve) => {
      resolveStartup = resolve;
    });
    const manager = createManager() as any;
    manager.disposing = false;
    manager.disposePromise = undefined;
    manager.lifecycleGeneration = 0;
    manager.logger = { debug: jest.fn(), error: jest.fn(), log: jest.fn(), warn: jest.fn() };
    manager.closeWatcherServers = jest.fn().mockResolvedValue(undefined);
    manager.stopWatcherProcess = jest.fn().mockResolvedValue(undefined);
    manager.startNodeWatcherProcess = jest.fn(() => startup);

    const initialization = manager.createProcess('late-watcher-client');
    for (let index = 0; index < 6 && manager.startNodeWatcherProcess.mock.calls.length === 0; index++) {
      await Promise.resolve();
    }
    expect(manager.startNodeWatcherProcess).toHaveBeenCalledTimes(1);

    const disposal = manager.dispose();
    expect(manager.dispose()).toBe(disposal);
    await disposal;
    resolveStartup(4410);

    await expect(initialization).rejects.toThrow('WatcherProcessManager is disposing');
    expect(manager.closeWatcherServers.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(manager.stopWatcherProcess.mock.calls.length).toBeGreaterThanOrEqual(2);
    await expect(manager.watch({ scheme: 'file', path: '/late' })).rejects.toThrow('cannot accept new work');
  });

  it('does not publish an Node watcher that resolves after manager disposal', async () => {
    expect.hasAssertions();
    let resolveNodeWatch!: (watcherId: number) => void;
    const nodeWatch = new Promise<number>((resolve) => {
      resolveNodeWatch = resolve;
    });
    const unwatch = jest.fn().mockResolvedValue(undefined);
    const manager = createManager() as any;
    manager.disposing = false;
    manager.disposePromise = undefined;
    manager.lifecycleGeneration = 0;
    manager._whenReadyDeferred = { promise: Promise.resolve() };
    manager.logger = { debug: jest.fn(), error: jest.fn(), log: jest.fn(), warn: jest.fn() };
    manager.closeWatcherServers = jest.fn().mockResolvedValue(undefined);
    manager.stopWatcherProcess = jest.fn().mockResolvedValue(undefined);
    manager.getProxy = () => ({ $unwatch: unwatch, $watch: jest.fn(() => nodeWatch) });

    const registration = manager.watch({ scheme: 'file', path: '/late-watch' });
    await Promise.resolve();
    await Promise.resolve();
    const disposal = manager.dispose();
    await disposal;

    resolveNodeWatch(5510);
    await expect(registration).rejects.toThrow('WatcherProcessManager is disposing');
    await Promise.resolve();

    expect(unwatch).toHaveBeenCalledWith(5510);
    expect(manager.logger.warn).not.toHaveBeenCalled();
  });
});
