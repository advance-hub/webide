// 按需执行真实 Docker/OpenSandbox 验收，直接调用官方 SDK。
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import WebSocket from 'ws';

import { type Project, type Workspace } from '../server/domain/models';
import { type Machine } from '../server/domain/runtime';
import { loadConfig } from '../server/platform/config';
import { command } from '../server/platform/process';
import { newID, now } from '../server/platform/store';
import { Workbench } from '../server/workbench';

const root = await mkdtemp(path.join(os.tmpdir(), 'webide-remote-'));
const output = path.resolve('output/runtime-profiles/node-control-plane-20261002/remote.json');
const config = {
  ...loadConfig({
    WORKBENCH_RUNTIME_DRIVER: 'sandbox',
    WORKBENCH_LOCAL_DEMO: '0',
    WORKBENCH_VOLUME_BACKEND: 'docker',
    WORKBENCH_DOCKER_CONTEXT: process.env.WEBIDE_ACCEPTANCE_DOCKER_CONTEXT,
    OPEN_SANDBOX_URL: process.env.WEBIDE_ACCEPTANCE_URL,
    OPEN_SANDBOX_API_KEY: process.env.WEBIDE_ACCEPTANCE_KEY,
    OPEN_SANDBOX_IMAGE: process.env.WEBIDE_ACCEPTANCE_IMAGE,
    OPENSUMI_NODE_WATCHER_MODE: 'shared',
    OPEN_SANDBOX_CPU: '2',
    OPEN_SANDBOX_MEMORY: '2Gi',
    OPEN_SANDBOX_PLATFORM: 'linux/amd64',
  }),
  data: path.join(root, 'control'),
  // 此入口验证开发机、运行时和卷；Git HTTP 由 git-control.test.ts 验证。
  gitBridgeURL: 'https://control-plane.fixture.invalid',
  port: 0,
};
assert(
  config.sandboxURL && config.sandboxKey && config.sandboxImage && process.env.WEBIDE_ACCEPTANCE_UPGRADE_IMAGE,
  'Explicit isolated OpenSandbox configuration is required',
);
const workbench = new Workbench(config);
const steps: Array<{ name: string; elapsedMs: number }> = [];
const created: Machine[] = [];
const started = Date.now();
const result: Record<string, unknown> = {
  platform: process.platform,
  node: process.version,
  image: config.sandboxImage,
  steps,
  pass: false,
};
const step = async (name: string, run: () => Promise<void>) => {
  const start = Date.now();
  await run();
  steps.push({ name, elapsedMs: Date.now() - start });
  process.stdout.write(`${name}: passed\n`);
};
async function until(run: () => Promise<boolean>, label: string) {
  const deadline = Date.now() + 300000;
  while (Date.now() < deadline) {
    if (await run()) {
      return;
    }
    await delay(500);
  }
  throw new Error(`${label} timed out`);
}
try {
  await until(
    () =>
      workbench.sandbox!.health().then(
        () => true,
        () => false,
      ),
    'Isolated OpenSandbox API readiness',
  );
  await workbench.listen();
  config.port = (workbench.server.address() as { port: number }).port;
  config.publicURL = `http://127.0.0.1:${config.port}`;
  const sessions = Object.fromEntries(['alice', 'bob'].map((owner) => [owner, workbench.store.createSession(owner)]));
  const request = async (owner: string, route: string, body?: unknown) => {
    const response = await fetch(config.publicURL + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Cookie: `workbench_session=${sessions[owner]}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const value = await response.json();
    assert(response.ok, `${route}: ${JSON.stringify(value)}`);
    return value;
  };
  const projects: Project[] = [];
  const workspaces: Workspace[] = [];
  await step('real-sdk-provision-and-start-two-accounts', async () => {
    for (const owner of ['alice', 'bob']) {
      const source = path.join(root, owner);
      await command('git', ['init', '-b', 'main', source]);
      await command('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
      await command('git', ['-C', source, 'config', 'user.name', 'Fixture']);
      await writeFile(path.join(source, 'README.md'), '# Isolated Node fixture\n');
      await command('git', ['-C', source, 'add', '.']);
      await command('git', ['-C', source, 'commit', '-m', 'fixture']);
      const project = workbench.store.put<Project>('project', {
        id: newID(),
        owner,
        url: source,
        name: owner,
        branch: 'main',
        status: 'importing',
        createdAt: now(),
      } as Project);
      await workbench.repositories.import(project);
      projects.push(project);
      const workspace = await request(owner, '/api/workspaces', {
        projectId: project.id,
        branch: 'feature/node',
        baseBranch: 'main',
      });
      workspaces.push(workspace);
      await until(async () => {
        const current = workbench.store.get<Workspace>('workspace', workspace.id)!;
        if (current.status === 'failed') {
          throw new Error(current.error);
        }
        return current.status === 'ready';
      }, `${owner} IDE start`);
      created.push(workbench.store.list<Machine>('machine', owner)[0]);
    }
  });
  const alice = workbench.store.get<Workspace>('workspace', workspaces[0].id)!;
  const bob = workbench.store.get<Workspace>('workspace', workspaces[1].id)!;
  const directory = workbench.driver.projectDirectory(alice);
  const service = workbench.sandbox!;
  await step('node24-os-and-api-account-isolation', async () => {
    assert.notEqual(alice.envId, bob.envId);
    const identity = await service.run(alice.envId!, 'node --version; uname -m; command -v go || true');
    assert.match(identity, /v24\.16\.0/);
    assert(!identity.split('\n').some((line) => line.endsWith('/go')));
    await service.run(alice.envId!, `printf dirty-original > '${directory}/dirty.txt'`);
    await service.run(bob.envId!, `test ! -e '${directory}/dirty.txt'`);
    const forbidden = await fetch(config.publicURL + `/api/workspaces/${alice.id}/environment`, {
      headers: { Cookie: `workbench_session=${sessions.bob}` },
    });
    assert.equal(forbidden.status, 404);
    const state = await request('alice', `/api/workspaces/${alice.id}/environment`);
    assert(state.ideReady);
    result.runtimeBefore = state.runtime;
    const metrics = await request('alice', '/api/machine/tools', { action: 'inspect' });
    assert(metrics.diskTotal > 0 && metrics.memoryUsed > 0);
    result.metrics = metrics;
  });
  const waitJob = async () =>
    until(async () => {
      const current = await request('alice', '/api/machine');
      if (current.job?.status === 'failed') {
        throw new Error(current.job.error);
      }
      return current.job?.status === 'done';
    }, 'Machine maintenance');
  await step('actual-ide-http-and-websocket-proxy', async () => {
    const entry = await request('alice', `/api/workspaces/${alice.id}/enter`, {});
    const host = `${alice.id}.localhost:${config.port}`;
    const ide = (route: string, cookie = '') =>
      new Promise<{ status: number; cookie: string; body: string }>((resolve, reject) => {
        const req = http.get(
          config.publicURL + route,
          { headers: { Host: host, Cookie: cookie, 'X-Workspace-Id': 'spoofed' }, timeout: 30000 },
          (res) => {
            let body = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => (body += chunk));
            res.once('error', reject);
            res.once('end', () =>
              resolve({ status: res.statusCode!, cookie: res.headers['set-cookie']?.[0]?.split(';')[0] || '', body }),
            );
          },
        );
        req.once('error', reject);
        req.once('timeout', () => req.destroy(new Error('IDE HTTP proxy timed out')));
      });
    const ticket = new URL(entry.url);
    const exchange = await ide(ticket.pathname + ticket.search);
    assert(exchange.cookie, 'One-time entry must issue an IDE session');
    const page = await ide('/', exchange.cookie);
    assert.equal(page.status, 200);
    assert.match(page.body, /<!doctype html>/i);
    const socket = new WebSocket(`ws://127.0.0.1:${config.port}/service`, {
      headers: { Host: host, Cookie: exchange.cookie, Origin: `http://${host}` },
      handshakeTimeout: 30000,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      const closed = new Promise<void>((resolve) => socket.once('close', () => resolve()));
      socket.close();
      await Promise.race([
        closed,
        delay(5000).then(() => {
          throw new Error('IDE WebSocket did not close');
        }),
      ]);
    } finally {
      socket.terminate();
    }
  });
  await step('real-encrypted-backup-and-dirty-file-restore', async () => {
    await request('alice', '/api/machine/backups', { action: 'backup', name: 'Docker fixture' });
    await waitJob();
    const backup = (await request('alice', '/api/machine/backups')).backups[0];
    assert(!(await readFile(path.join(config.data, 'backups', `${backup.id}.enc`))).includes('dirty-original'));
    await service.run(alice.envId!, `printf dirty-later > '${directory}/dirty.txt'`);
    await request('alice', '/api/machine/backups', { action: 'restore', backupId: backup.id });
    await waitJob();
    assert.equal((await service.run(alice.envId!, `cat '${directory}/dirty.txt'`)).trim(), 'dirty-original');
  });
  await step('actual-container-runtime-upgrade-retains-pvc', async () => {
    const before = workbench.store.get<Machine>('machine', created[0].id)!.envId;
    config.sandboxImage = process.env.WEBIDE_ACCEPTANCE_UPGRADE_IMAGE!;
    await request('alice', `/api/workspaces/${alice.id}/update-runtime`, {});
    await waitJob();
    const current = workbench.store.get<Workspace>('workspace', alice.id)!;
    assert.notEqual(current.envId, before);
    assert.equal((await service.run(current.envId!, `cat '${directory}/dirty.txt'`)).trim(), 'dirty-original');
    const state = await request('alice', `/api/workspaces/${alice.id}/environment`);
    assert(state.ideReady);
    result.runtimeAfter = state.runtime;
    assert.notEqual((result.runtimeBefore as any).fingerprint, (state.runtime as any).fingerprint);
  });
  await step('actual-container-and-docker-pvc-release', async () => {
    for (let i = 0; i < workspaces.length; i++) {
      const owner = projects[i].owner;
      const workspace = workspaces[i];
      await request(owner, `/api/workspaces/${workspace.id}/delete`, {});
      await until(async () => !workbench.store.get('workspace', workspace.id), 'Workspace delete');
      await request(owner, '/api/machine/release', {});
      assert.equal(
        (
          await command('docker', [
            ...(config.dockerContext ? ['--context', config.dockerContext] : []),
            'volume',
            'ls',
            '--format',
            '{{.Name}}',
            '--filter',
            `name=^opensumi-${created[i].id}$`,
          ])
        ).trim(),
        '',
      );
      assert.equal((await service.list({ 'opensumi.workspace': created[i].id })).length, 0);
    }
  });
  result.pass = true;
} catch (error) {
  result.error = String((error as Error).stack || error);
  process.exitCode = 1;
} finally {
  // 只清理本轮验收生成的开发机标识。
  for (const machine of workbench.store.list<Machine>('machine')) {
    if (['alice', 'bob'].includes(machine.owner)) {
      try {
        await workbench.driver.release(machine);
      } catch (error) {
        result.cleanupError = String(error);
      }
    }
  }
  await workbench.close();
  result.elapsedMs = Date.now() - started;
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  await rm(root, { recursive: true, force: true });
  process.stdout.write(JSON.stringify({ pass: result.pass, error: result.error }) + '\n');
}
