import path from 'path';

import { WatcherProcessManagerImpl, normalizeWorkspaceAgentChangeUri } from '../../src/node/watcher-process-manager';

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
  const originalWorkspaceAgentWatchMode = process.env.OPENSUMI_WORKSPACE_AGENT_WATCH_MODE;
  const originalFallback = process.env.OPENSUMI_WORKSPACE_AGENT_FALLBACK;
  const originalExecArgv = process.execArgv.slice();

  afterEach(() => {
    if (originalFallback === undefined) {
      delete process.env.OPENSUMI_WORKSPACE_AGENT_FALLBACK;
    } else {
      process.env.OPENSUMI_WORKSPACE_AGENT_FALLBACK = originalFallback;
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
    if (originalWorkspaceAgentWatchMode === undefined) {
      delete process.env.OPENSUMI_WORKSPACE_AGENT_WATCH_MODE;
    } else {
      process.env.OPENSUMI_WORKSPACE_AGENT_WATCH_MODE = originalWorkspaceAgentWatchMode;
    }
    process.execArgv.splice(0, process.execArgv.length, ...originalExecArgv);
  });

  it('uses source watcher host in js mode when configured host is the default built host', () => {
    expect.hasAssertions();
    process.env.EXT_MODE = 'js';
    const defaultBuiltWatcherHost = path.join(__dirname, '../../lib/node/hosted/watcher.process.js');
    const manager = createManager(defaultBuiltWatcherHost);

    expect(manager.watcherHost).toContain('packages/file-service/src/node/hosted/watcher.process.ts');
  });

  it('canonicalizes Windows file URIs emitted by the Go watcher', () => {
    expect.assertions(1);
    expect(normalizeWorkspaceAgentChangeUri('file:///C:/Users/RUNNER~1/AppData/Local/Temp/watch-proof.txt')).toBe(
      'file:///c%3A/Users/RUNNER~1/AppData/Local/Temp/watch-proof.txt',
    );
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

  it('releases connection watch streams without stopping the server-scoped agent', async () => {
    expect.hasAssertions();
    const manager = createManager() as any;
    const disposeStream = jest.fn();
    const disposeAgent = jest.fn();
    manager.workspaceAgentWatches = new Map([[1, { generation: 0, handle: { dispose: disposeStream } }]]);
    Object.defineProperty(manager, 'workspaceAgent', { value: { dispose: disposeAgent } });
    manager.logger = { debug: jest.fn() };
    manager.watcherRuntime = 'agent';
    manager.closeWatcherServers = jest.fn().mockResolvedValue(undefined);
    manager.stopWatcherProcess = jest.fn().mockResolvedValue(undefined);

    await manager.dispose();

    expect(disposeStream).toHaveBeenCalledTimes(1);
    expect(disposeAgent).not.toHaveBeenCalled();
    expect(manager.workspaceAgentWatches.size).toBe(0);
  });

  it('fences and reclaims watcher startup that settles after manager disposal', async () => {
    expect.hasAssertions();
    process.env.OPENSUMI_WORKSPACE_AGENT_WATCH_MODE = 'off';
    let resolveStartup!: (pid: number) => void;
    const startup = new Promise<number>((resolve) => {
      resolveStartup = resolve;
    });
    const manager = createManager() as any;
    manager.disposing = false;
    manager.disposePromise = undefined;
    manager.lifecycleGeneration = 0;
    manager.workspaceAgentWatches = new Map();
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

  it('does not publish an Agent-fallback watcher that resolves after manager disposal', async () => {
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
    manager.watcherRuntime = 'agent-fallback';
    manager.workspaceAgentFallback = Promise.resolve();
    manager.workspaceAgentWatcherSequence = 1;
    manager.workspaceAgentWatches = new Map();
    manager._whenReadyDeferred = { promise: Promise.resolve() };
    manager.logger = { debug: jest.fn(), error: jest.fn(), log: jest.fn(), warn: jest.fn() };
    manager.closeWatcherServers = jest.fn().mockResolvedValue(undefined);
    manager.stopWatcherProcess = jest.fn().mockResolvedValue(undefined);
    manager.getProxy = () => ({ $unwatch: unwatch, $watch: jest.fn(() => nodeWatch) });

    const registration = manager.watch({ scheme: 'file', path: '/late-fallback-watch' });
    await Promise.resolve();
    await Promise.resolve();
    const disposal = manager.dispose();
    await disposal;

    resolveNodeWatch(5510);
    await expect(registration).rejects.toThrow('WatcherProcessManager is disposing');
    await Promise.resolve();

    expect(manager.workspaceAgentWatches.size).toBe(0);
    expect(unwatch).toHaveBeenCalledWith(5510);
    expect(manager.logger.warn).not.toHaveBeenCalled();
  });

  it('applies watcher excludes before restoring subscriptions during Agent fallback', async () => {
    expect.assertions(3);
    process.env.OPENSUMI_WORKSPACE_AGENT_FALLBACK = 'node';
    const manager = createManager() as any;
    const operations: string[] = [];
    const disposeStream = jest.fn();
    manager.logger = { error: jest.fn() };
    manager.watcherRuntime = 'agent';
    manager.workspaceAgentFallback = undefined;
    manager.workspaceAgentClientId = 'fallback-client';
    manager.workspaceAgentDefaultExcludes = ['**/node_modules/**'];
    manager.workspaceAgentWatches = new Map([
      [
        1,
        {
          uri: { scheme: 'file', path: '/workspace' },
          options: { recursive: true },
          generation: 0,
          handle: { dispose: disposeStream },
        },
      ],
    ]);
    manager.startNodeWatcherProcess = jest.fn(async () => {
      manager._whenReadyDeferred.resolve();
    });
    manager.getProxy = () => ({
      $setWatcherFileExcludes: async (excludes: string[]) => {
        operations.push(`excludes:${excludes.join(',')}`);
      },
      $watch: async () => {
        operations.push('watch');
        return 17;
      },
    });
    manager.$onWatcherFailed = jest.fn();

    await manager.fallbackWorkspaceAgentWatcher('test failure');

    expect(operations).toEqual(['excludes:**/node_modules/**', 'watch']);
    expect(disposeStream).toHaveBeenCalledTimes(1);
    expect(manager.workspaceAgentWatches.get(1).nodeWatchId).toBe(17);
  });

  it('reports a required Agent stream failure, cancels streams and rejects further watches without Node fallback', async () => {
    expect.hasAssertions();
    process.env.OPENSUMI_WORKSPACE_AGENT_FALLBACK = 'error';
    const manager = createManager() as any;
    const disposeStream = jest.fn();
    manager.watcherRuntime = 'agent';
    manager.workspaceAgentWatches = new Map([[1, { generation: 0, handle: { dispose: disposeStream } }]]);
    manager.$onWatcherFailed = jest.fn();
    manager.startNodeWatcherProcess = jest.fn();
    await manager.fallbackWorkspaceAgentWatcher('connection lost');
    expect(disposeStream).toHaveBeenCalledTimes(1);
    expect(manager.workspaceAgentWatches.get(1).generation).toBe(1);
    expect(manager.$onWatcherFailed).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('Node fallback is disabled') }),
    );
    expect(manager.startNodeWatcherProcess).not.toHaveBeenCalled();
    await expect(manager.watch({ scheme: 'file', path: '/workspace' })).rejects.toThrow('connection lost');
  });
});
