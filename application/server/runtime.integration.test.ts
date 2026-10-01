import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import WebSocket from 'ws';

import { Workbench } from './app';
import { loadConfig } from './config';
import { type Workspace, command } from './git';

test(
  'real Node IDE: import, start, ticket exchange, HTTP/WebSocket proxy and dirty-file stop/restart',
  { timeout: 120000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opensumi-live-'));
    const config = { ...loadConfig({}), data: path.join(root, 'data'), port: 0 };
    const workbench = new Workbench(config);
    try {
      const source = path.join(root, 'source');
      await command('git', ['init', '-b', 'main', source]);
      await command('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
      await command('git', ['-C', source, 'config', 'user.name', 'Fixture']);
      await writeFile(path.join(source, 'hello.ts'), 'export const greeting = "Node 24";\n');
      await command('git', ['-C', source, 'add', 'hello.ts']);
      await command('git', ['-C', source, 'commit', '-m', 'initial']);
      await workbench.listen();
      config.port = (workbench.server.address() as { port: number }).port;
      config.publicURL = `http://127.0.0.1:${config.port}`;
      assert.equal((await fetch(config.publicURL + '/images')).status, 200);
      assert.equal((await fetch(config.publicURL + '/api/missing')).status, 404);
      const request = async (endpoint: string, body?: unknown) => {
        const response = await fetch(config.publicURL + endpoint, {
          method: body === undefined ? 'GET' : 'POST',
          headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const value = await response.json();
        assert.ok(response.ok, JSON.stringify(value));
        return value;
      };
      const wait = async (check: () => Promise<boolean>) => {
        for (let attempt = 0; attempt < 120; attempt++) {
          if (await check()) {
            return;
          }
          await delay(500);
        }
        throw new Error('Runtime condition did not complete');
      };
      const project = await request('/api/projects', { url: source, name: 'Live fixture', branch: 'main' });
      await wait(
        async () =>
          (await request('/api/projects')).find((p: { id: string; status: string }) => p.id === project.id)?.status ===
          'ready',
      );
      const workspace = await request('/api/workspaces', {
        projectId: project.id,
        branch: 'feature/node',
        baseBranch: 'main',
      });
      await wait(async () => {
        const current = (await request('/api/workspaces')).find((w: Workspace) => w.id === workspace.id);
        if (current.status === 'failed') {
          throw new Error(current.error);
        }
        return current.status === 'ready';
      });
      const repeated = await request('/api/workspaces', { projectId: project.id, branch: 'feature/node' });
      assert.equal(repeated.id, workspace.id);
      const directory = workbench.driver.projectDirectory(workbench.store.get<Workspace>('workspace', workspace.id)!);
      const sha = (await command('git', ['-C', directory, 'rev-parse', 'HEAD'])).trim();
      await writeFile(path.join(directory, 'dirty.txt'), 'keep this uncommitted file');
      const entry = await request(`/api/workspaces/${workspace.id}/enter`, {});
      const host = `${workspace.id}.localhost:${config.port}`;
      const ideHTTP = (url: string, cookie?: string) =>
        new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }>((resolve, reject) => {
          http
            .get(
              config.publicURL + url,
              { headers: { Host: host, ...(cookie ? { Cookie: cookie } : {}) } },
              (response) => {
                let body = '';
                response.on('data', (chunk) => (body += chunk));
                response.on('end', () => resolve({ status: response.statusCode!, headers: response.headers, body }));
              },
            )
            .once('error', reject);
        });
      assert.equal((await ideHTTP('/')).status, 401);
      const ticketPath = new URL(entry.url).pathname + new URL(entry.url).search;
      const exchange = await ideHTTP(ticketPath);
      assert.equal(exchange.status, 302);
      const session = exchange.headers['set-cookie']!.find((value) => value.startsWith('ide_session='))!.split(';')[0];
      assert.equal((await ideHTTP(ticketPath)).status, 401);
      const document = await ideHTTP('/', session);
      assert.equal(document.status, 200);
      assert.ok(document.body.includes(workspace.id));
      const socket = new WebSocket(`ws://127.0.0.1:${config.port}/service`, {
        headers: { Host: host, Cookie: session, Origin: `http://${host}` },
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      socket.close();
      await request(`/api/workspaces/${workspace.id}/stop`, {});
      await wait(
        async () =>
          (await request('/api/workspaces')).find((w: Workspace) => w.id === workspace.id)?.status === 'stopped',
      );
      assert.equal(await readFile(path.join(directory, 'dirty.txt'), 'utf8'), 'keep this uncommitted file');
      await request(`/api/workspaces/${workspace.id}/start`, {});
      await wait(
        async () =>
          (await request('/api/workspaces')).find((w: Workspace) => w.id === workspace.id)?.status === 'ready',
      );
      assert.equal((await command('git', ['-C', directory, 'rev-parse', 'HEAD'])).trim(), sha);
      assert.equal(await readFile(path.join(directory, 'dirty.txt'), 'utf8'), 'keep this uncommitted file');
      await request(`/api/workspaces/${workspace.id}/delete`, {});
      await wait(async () => !(await request('/api/workspaces')).some((w: Workspace) => w.id === workspace.id));
      await request('/api/machine/release', {});
      assert.equal((await request('/api/machine')).machine, null);
    } finally {
      await workbench.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
