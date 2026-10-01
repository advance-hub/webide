import { Injector } from '@opensumi/di';
import { FileChangeType, URI } from '@opensumi/ide-core-common';

import { FileServiceModule } from '../../src/node';
import { SharedNodeWatcherPool, SharedNodeWatcherPoolToken } from '../../src/node/shared-node-watcher';

import type { IWatcherProcessManager } from '../../src/common/watcher';
import type { FileSystemWatcherClient } from '@opensumi/ide-core-common/file-watch';

function fixture() {
  let emit: FileSystemWatcherClient;
  let exit: () => void;
  const host = {
    setUnexpectedExitHandler: jest.fn((handler) => {
      exit = handler;
    }),
    setClient: jest.fn((client) => {
      emit = client;
    }),
    createProcess: jest.fn(async () => 4321),
    whenReady: Promise.resolve(),
    watch: jest.fn(async (_uri, options) => options.sharedWatchId),
    unWatch: jest.fn(async () => undefined),
    dispose: jest.fn(async () => undefined),
  };
  const createHost = jest.fn(() => host as unknown as IWatcherProcessManager);
  const pool = new SharedNodeWatcherPool(createHost);
  const clients = Array.from({ length: 5 }, () => ({
    onDidFilesChanged: jest.fn(),
    onWatcherOverflow: jest.fn(),
    onWatcherFailed: jest.fn(),
  }));
  return { pool, host, createHost, clients, emit: () => emit!, crash: () => exit() };
}

describe('server-scoped shared Node watchers', () => {
  it('keeps the pool singleton across child connection injectors', () => {
    expect.hasAssertions();
    const injector = new Injector();
    const provider = new FileServiceModule().providers.find(
      (entry) => typeof entry === 'object' && 'token' in entry && entry.token === SharedNodeWatcherPoolToken,
    );
    injector.addProviders(provider!);
    const pool = injector.get(SharedNodeWatcherPoolToken);
    expect(injector.get(SharedNodeWatcherPoolToken)).toBe(pool);
    expect(injector.createChild().get(SharedNodeWatcherPoolToken)).toBe(pool);
    expect(injector.createChild().get(SharedNodeWatcherPoolToken)).toBe(pool);
  });
  it('shares one host and one identical subscription across five connections', async () => {
    expect.hasAssertions();
    const f = fixture();
    const leases = await Promise.all(f.clients.map((client) => f.pool.acquire(client)));
    const ids = await Promise.all(
      leases.map((lease) => lease.watch(URI.file('/project').codeUri, { recursive: true })),
    );
    expect(f.createHost).toHaveBeenCalledTimes(1);
    expect(f.host.createProcess).toHaveBeenCalledTimes(1);
    expect(f.host.watch).toHaveBeenCalledTimes(1);
    expect(new Set(ids).size).toBe(5);
    const sharedWatchId = f.host.watch.mock.calls[0][1].sharedWatchId;
    f.emit().onDidFilesChanged({
      sharedWatchId,
      changes: [{ uri: URI.file('/project/new.ts').toString(), type: FileChangeType.ADDED }],
    } as any);
    for (const client of f.clients) {
      expect(client.onDidFilesChanged).toHaveBeenCalledTimes(1);
      expect(client.onDidFilesChanged.mock.calls[0][0]).not.toHaveProperty('sharedWatchId');
    }
    await leases[0].dispose();
    expect(f.host.unWatch).not.toHaveBeenCalled();
    f.emit().onDidFilesChanged({ sharedWatchId, changes: [] } as any);
    expect(f.clients[0].onDidFilesChanged).toHaveBeenCalledTimes(1);
    expect(f.clients[1].onDidFilesChanged).toHaveBeenCalledTimes(2);
    await f.pool.dispose();
    expect(f.host.unWatch).toHaveBeenCalledTimes(1);
    expect(f.host.dispose).toHaveBeenCalledTimes(1);
  });

  it('re-subscribes surviving leases after a crash and rejects stale host events', async () => {
    expect.hasAssertions();
    const f = fixture();
    const a = await f.pool.acquire(f.clients[0]);
    const b = await f.pool.acquire(f.clients[1]);
    const id = await a.watch(URI.file('/one').codeUri, { recursive: true });
    await b.watch(URI.file('/two').codeUri, { recursive: true });
    const oldId = f.host.watch.mock.calls[0][1].sharedWatchId;
    f.crash();
    await b.dispose();
    await a.pid;
    expect(f.createHost).toHaveBeenCalledTimes(2);
    expect(f.clients[0].onWatcherOverflow).toHaveBeenCalledTimes(1);
    f.emit().onDidFilesChanged({ sharedWatchId: oldId, changes: [] } as any);
    expect(f.clients[0].onDidFilesChanged).not.toHaveBeenCalled();
    const newId = f.host.watch.mock.calls.at(-1)![1].sharedWatchId;
    f.emit().onDidFilesChanged({ sharedWatchId: newId, changes: [] } as any);
    expect(f.clients[0].onDidFilesChanged).toHaveBeenCalledTimes(1);
    expect(f.clients[1].onDidFilesChanged).not.toHaveBeenCalled();
    await a.unWatch(id);
    await f.pool.dispose();
  });

  it('bounds recovery failures and reports them to surviving subscribers', async () => {
    expect.hasAssertions();
    const f = fixture();
    const lease = await f.pool.acquire(f.clients[0]);
    await lease.watch(URI.file('/project').codeUri, { recursive: true });
    f.host.createProcess.mockRejectedValue(new Error('restart failed'));
    f.crash();
    await expect(lease.pid).rejects.toThrow('restart failed');
    expect(f.createHost).toHaveBeenCalledTimes(4);
    expect(f.clients[0].onWatcherFailed).toHaveBeenCalledWith(expect.objectContaining({ attempts: 3 }));
    await f.pool.dispose();
  });

  it('cancels recovery when the last lease closes', async () => {
    expect.hasAssertions();
    const f = fixture();
    const lease = await f.pool.acquire(f.clients[0]);
    await lease.watch(URI.file('/project').codeUri, { recursive: true });
    Object.defineProperty(f.host, 'whenReady', { value: new Promise(() => undefined) });
    f.crash();
    const recovery = lease.pid.catch((error) => error);
    await lease.dispose();
    await expect(recovery).resolves.toBeInstanceOf(Error);
    await f.pool.dispose();
    expect(f.createHost.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('keeps paths and per-connection exclusion changes isolated', async () => {
    expect.hasAssertions();
    const f = fixture();
    const a = await f.pool.acquire(f.clients[0]);
    const b = await f.pool.acquire(f.clients[1]);
    await a.watch(URI.file('/one').codeUri, { recursive: true });
    const bId = await b.watch(URI.file('/two').codeUri, { recursive: true });
    const aHostId = f.host.watch.mock.calls[0][1].sharedWatchId;
    const bHostId = f.host.watch.mock.calls[1][1].sharedWatchId;
    f.emit().onWatcherOverflow({ sharedWatchId: aHostId, eventCount: 50, limit: 10, timestamp: 1 } as any);
    expect(f.clients[0].onWatcherOverflow).toHaveBeenCalledTimes(1);
    expect(f.clients[1].onWatcherOverflow).not.toHaveBeenCalled();
    await a.setExcludes(['**/secret/**']);
    expect(f.host.unWatch).toHaveBeenCalledWith(aHostId);
    expect(f.host.unWatch).not.toHaveBeenCalledWith(bHostId);
    expect(f.host.watch.mock.calls[2][1].excludes).toEqual(['**/secret/**']);
    f.emit().onDidFilesChanged({ sharedWatchId: aHostId, changes: [] } as any);
    expect(f.clients[0].onDidFilesChanged).not.toHaveBeenCalled();
    f.emit().onWatcherFailed({ sharedWatchId: bHostId, message: 'fixture failure', timestamp: 1 } as any);
    expect(f.clients[1].onWatcherFailed).toHaveBeenCalledTimes(1);
    await b.unWatch(bId);
    await f.pool.dispose();
  });

  it('does not deduplicate different policies for the same path', async () => {
    expect.hasAssertions();
    const f = fixture();
    const a = await f.pool.acquire(f.clients[0]);
    const b = await f.pool.acquire(f.clients[1]);
    await a.setExcludes(['**/private/**']);
    await b.setExcludes([]);
    await Promise.all([
      a.watch(URI.file('/project').codeUri, { recursive: true }),
      b.watch(URI.file('/project').codeUri, { recursive: true }),
    ]);
    expect(f.createHost).toHaveBeenCalledTimes(1);
    expect(f.host.watch).toHaveBeenCalledTimes(2);
    await f.pool.dispose();
  });

  it('reclaims late registrations after their owner closes', async () => {
    expect.hasAssertions();
    const f = fixture();
    let complete!: (id: number) => void;
    f.host.watch.mockImplementation(
      (_uri, options) =>
        new Promise((resolve) => {
          complete = () => resolve(options.sharedWatchId);
        }),
    );
    const lease = await f.pool.acquire(f.clients[0]);
    const registration = lease.watch(URI.file('/project').codeUri, { recursive: true });
    await Promise.resolve();
    const disposal = lease.dispose();
    expect(lease.dispose()).toBe(disposal);
    complete(0);
    await registration;
    await disposal;
    expect(f.host.unWatch).toHaveBeenCalledTimes(1);
    expect(f.host.dispose).toHaveBeenCalledTimes(1);
    await expect(lease.watch(URI.file('/project').codeUri)).rejects.toThrow('disposed');
  });

  it('retires failed startup and allows a fresh host for the next connection', async () => {
    expect.hasAssertions();
    const f = fixture();
    f.host.createProcess.mockRejectedValueOnce(new Error('fixture startup failed'));
    await expect(f.pool.acquire(f.clients[0])).rejects.toThrow('fixture startup failed');
    expect(f.host.dispose).toHaveBeenCalledTimes(1);
    const lease = await f.pool.acquire(f.clients[1]);
    expect(f.createHost).toHaveBeenCalledTimes(2);
    await lease.dispose();
  });

  it('cancels a pending acquisition when the server stops', async () => {
    expect.hasAssertions();
    const f = fixture();
    Object.defineProperty(f.host, 'whenReady', { value: new Promise(() => undefined) });
    const acquisition = f.pool.acquire(f.clients[0]);
    const outcome = acquisition.catch((error) => error);
    await f.pool.dispose();
    await expect(outcome).resolves.toHaveProperty('message', expect.stringContaining('retired'));
    expect(f.host.dispose).toHaveBeenCalledTimes(1);
    await expect(f.pool.acquire(f.clients[1])).rejects.toThrow('stopping');
  });

  it('stops all hosts even if a subscription cannot be released', async () => {
    expect.hasAssertions();
    const f = fixture();
    const lease = await f.pool.acquire(f.clients[0]);
    await lease.watch(URI.file('/project').codeUri, { recursive: true });
    f.host.unWatch.mockRejectedValueOnce(new Error('fixture release failure'));
    await expect(f.pool.dispose()).rejects.toThrow('pool cleanup failed');
    expect(f.host.dispose).toHaveBeenCalledTimes(1);
  });
});
