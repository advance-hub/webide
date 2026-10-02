import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import WebSocket from 'ws';

import { type Workspace } from '../domain/models';
import { type Machine } from '../domain/runtime';
import { loadConfig } from '../platform/config';
import { Store, newID, now } from '../platform/store';
import { LocalRuntime } from '../runtime/local';

test(
  'a replacement controller authenticates an orphan IDE, refuses a forged journal and stops an active connection',
  { timeout: 60000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'webide-orphan-'));
    const config = { ...loadConfig({ OPENSUMI_NODE_WATCHER_MODE: 'shared' }), data: root };
    const store = new Store(root);
    const first = new LocalRuntime(config, store);
    const replacement = new LocalRuntime(config, store);
    const machine = store.put<Machine>('machine', { id: newID(), owner: 'alice', driver: 'local', createdAt: now() });
    const workspace = store.put<Workspace>('workspace', {
      id: newID(),
      owner: 'alice',
      projectId: newID(),
      machineId: machine.id,
      branch: 'main',
      status: 'ready',
      createdAt: now(),
      updatedAt: now(),
    });
    const directory = first.projectDirectory(workspace);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, 'dirty.txt'), 'preserved');
    let socket: WebSocket | undefined;
    try {
      await first.provision(machine);
      await first.start(workspace);
      assert.equal((await replacement.inspect(workspace)).recovered, true);
      const journal = path.join(first.root(workspace), '.platform/ide-owner.json');
      const original = await readFile(journal, 'utf8');
      const owner = JSON.parse(original);
      await writeFile(journal, JSON.stringify({ ...owner, token: '0'.repeat(64) }));
      assert.equal((await replacement.inspect(workspace)).phase, 'unowned');
      await assert.rejects(() => replacement.stop(workspace), /所有权/);
      process.kill(owner.pid, 0);
      await writeFile(journal, original);
      socket = new WebSocket(`ws://127.0.0.1:${workspace.idePort}/service`, {
        headers: { 'X-Workspace-Id': workspace.id },
      });
      await new Promise<void>((resolve, reject) => {
        socket!.once('open', resolve);
        socket!.once('error', reject);
      });
      const closed = new Promise<void>((resolve) => socket!.once('close', () => resolve()));
      await replacement.stop(workspace);
      await closed;
      assert.throws(() => process.kill(owner.pid, 0), /ESRCH/);
      assert.equal(await readFile(path.join(directory, 'dirty.txt'), 'utf8'), 'preserved');
      const log = await readFile(path.join(first.root(workspace), '.platform/ide.log'), 'utf8');
      const report = JSON.parse(
        log
          .split('\n')
          .find((line) => line.startsWith('OpenSumi server shutdown: '))!
          .slice('OpenSumi server shutdown: '.length),
      );
      assert.equal(report.timedOut, false);
      assert.equal(report.phases.length, 4);
      assert(report.phases.every((phase: { status: string }) => phase.status === 'completed'));
    } finally {
      socket?.terminate();
      await first.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
