import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { loadConfig } from './config';
import { type Workspace } from './git';
import { Jobs } from './jobs';
import { Machines } from './machines';
import { LocalRuntime, type Machine } from './runtime';
import { Store, newID, now } from './store';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webide-machine-'));
  const config = { ...loadConfig({}), data: root };
  const store = new Store(root);
  const jobs = new Jobs();
  const driver = new LocalRuntime(config, store);
  const connected = new Set<string>();
  driver.stop = async () => undefined;
  driver.inspect = async () => ({ exists: true, phase: 'fixture', ideReady: true });
  const machine = store.put<Machine>('machine', {
    id: newID(),
    owner: 'alice',
    driver: 'local',
    createdAt: '2026-01-01T00:00:00Z',
  });
  const project = store.put('project', { id: newID(), owner: 'alice' });
  const workspace = store.put<Workspace>('workspace', {
    id: newID(),
    owner: 'alice',
    projectId: project.id,
    machineId: machine.id,
    branch: 'feature',
    status: 'ready',
    createdAt: now(),
    updatedAt: now(),
  });
  const directory = driver.projectDirectory(workspace);
  await mkdir(directory, { recursive: true });
  await driver.provision(machine);
  await writeFile(path.join(directory, 'dirty.txt'), 'original uncommitted');
  const machines = new Machines(
    config,
    store,
    driver,
    jobs,
    async (w) => {
      w.status = 'ready';
      store.put('workspace', w);
    },
    (id) => connected.has(id),
  );
  const wait = async () => {
    for (let i = 0; jobs.busy(`machine:${machine.id}`) && i < 500; i++) {
      await delay(10);
    }
    assert.equal(jobs.busy(`machine:${machine.id}`), false);
  };
  return {
    root,
    config,
    store,
    jobs,
    driver,
    machine,
    workspace,
    directory,
    machines,
    connected,
    wait,
    close: async () => {
      await machines.close();
      await jobs.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test('real machine archives encrypt backups, restore dirty files and resume only prior ready IDEs', async () => {
  const f = await fixture();
  try {
    const cache = path.join(f.driver.machineRoot(f.machine.id), 'home/.m2/repository');
    await mkdir(cache, { recursive: true });
    await writeFile(path.join(cache, 'keep.cache'), 'cache');
    f.machines.enqueue(f.machines.machine('alice'), 'backup', undefined, 'Fixture');
    assert.throws(
      () =>
        f.jobs.enqueue(
          `workspace:${f.workspace.id}`,
          'quick',
          async () => {},
          () => {},
          [`machine:${f.machine.id}`],
        ),
      /进行中/,
    );
    await f.wait();
    assert.equal(f.machines.machine('alice').job?.status, 'done');
    const backup = f.store.list('backup', 'alice')[0];
    assert.equal(backup.name, 'Fixture');
    assert.equal(
      (await readFile(path.join(f.root, 'backups', `${backup.id}.enc`))).includes('original uncommitted'),
      false,
    );
    await writeFile(path.join(f.directory, 'dirty.txt'), 'later state');
    await writeFile(path.join(f.directory, 'new.txt'), 'later file');
    f.machines.enqueue(f.machines.machine('alice'), 'restore', backup as any);
    await f.wait();
    assert.equal(f.machines.machine('alice').job?.status, 'done');
    assert.equal(await readFile(path.join(f.directory, 'dirty.txt'), 'utf8'), 'original uncommitted');
    await assert.rejects(() => readFile(path.join(f.directory, 'new.txt')), /ENOENT/);
    assert.equal(await readFile(path.join(cache, 'keep.cache'), 'utf8'), 'cache');
    assert.equal(f.store.get<Workspace>('workspace', f.workspace.id)?.status, 'ready');
    assert.throws(() => f.machines.machine('bob'), /尚未/);
  } finally {
    await f.close();
  }
});

test('failed restore preserves its journal and explicit recovery rolls files and metadata back', async () => {
  const f = await fixture();
  try {
    f.machines.enqueue(f.machines.machine('alice'), 'backup');
    await f.wait();
    const backup = f.store.list('backup', 'alice')[0];
    await writeFile(path.join(f.directory, 'dirty.txt'), 'state before failed restore');
    const original = f.driver.restoreMachine.bind(f.driver);
    let fail = true;
    f.driver.restoreMachine = async (...args) => {
      await original(...args);
      if (args[1] === 'apply' && fail) {
        fail = false;
        throw new Error('interrupted after file swaps');
      }
    };
    f.machines.enqueue(f.machines.machine('alice'), 'restore', backup as any);
    await f.wait();
    const failed = f.machines.machine('alice');
    assert.equal(failed.job?.needsRecovery, true);
    assert.throws(() => f.machines.assertAvailable(failed), /中断/);
    assert.equal(await readFile(path.join(f.directory, 'dirty.txt'), 'utf8'), 'original uncommitted');
    f.machines.enqueue(failed, 'recover');
    await f.wait();
    assert.equal(await readFile(path.join(f.directory, 'dirty.txt'), 'utf8'), 'state before failed restore');
    assert.equal(f.machines.machine('alice').job?.needsRecovery, false);
  } finally {
    await f.close();
  }
});

test('idle policy respects live connections and automatic backups run only for stopped machines', async () => {
  const f = await fixture();
  try {
    const machine = f.machines.machine('alice');
    f.machines.savePolicy(machine, { idleMinutes: 1, autoBackupHours: 1 });
    assert.throws(() => f.machines.savePolicy(machine, { idleMinutes: -1, autoBackupHours: 1 }), /0–/);
    f.workspace.lastActivityAt = '2026-01-01T00:00:00Z';
    f.store.put('workspace', f.workspace);
    f.connected.add(f.workspace.id);
    await f.machines.tick(Date.parse('2026-10-02T00:00:00Z'));
    assert.equal(f.store.get<Workspace>('workspace', f.workspace.id)?.status, 'ready');
    assert.equal(f.store.list('backup').length, 0);
    f.connected.clear();
    await f.machines.tick(Date.parse('2026-10-02T00:00:00Z'));
    await f.wait();
    assert.equal(f.store.get<Workspace>('workspace', f.workspace.id)?.status, 'stopped');
    assert.equal(f.store.list('backup')[0].automatic, true);
    await f.machines.tick(Date.parse('2026-10-02T00:01:00Z'));
    await f.wait();
    assert.equal(f.store.list('backup').length, 1);
  } finally {
    await f.close();
  }
});

test('machine metrics and cache cleanup use the configured root on this operating system', async () => {
  const f = await fixture();
  try {
    const metrics = await f.driver.helper(f.workspace, 'machine', { action: 'inspect' });
    assert.ok(Number(metrics.diskTotal) > 0);
    assert.ok(Number(metrics.memoryLimit) > 0);
    await f.driver.helper(f.workspace, 'machine', { action: 'clean-cache' });
    const invalid = path.join(f.root, 'invalid');
    await writeFile(invalid, 'not an archive');
    await assert.rejects(() => f.driver.restoreMachine(f.machine, 'stage', invalid), /command|Command/);
    assert.equal(await readFile(path.join(f.directory, 'dirty.txt'), 'utf8'), 'original uncommitted');
  } finally {
    await f.close();
  }
});
