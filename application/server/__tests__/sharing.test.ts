import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import WebSocket, { WebSocketServer } from 'ws';

import { type Workspace } from '../domain/models';
import { type RuntimeDriver } from '../domain/runtime';
import { loadConfig } from '../platform/config';
import { hash, newID, now } from '../platform/store';
import { Workbench } from '../workbench';

test('五个独立账户通过邀请访问同一 IDE；管理权限、跨工作区隔离和即时撤销贯通', { timeout: 20000 }, async () => {
  const data = await mkdtemp(path.join(os.tmpdir(), 'webide-sharing-'));
  const received: http.IncomingHttpHeaders[] = [];
  const upstream = http.createServer((req, res) => {
    received.push(req.headers);
    res.end('IDE');
  });
  const ws = new WebSocketServer({ server: upstream });
  ws.on('connection', (socket) => socket.on('message', (value) => socket.send(value)));
  upstream.listen(0, '127.0.0.1');
  await once(upstream, 'listening');
  const endpoint = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  const workbench = new Workbench(
    { ...loadConfig({}), localDemo: false, driver: 'sandbox', data, port: 0 },
    () =>
      ({
        name: 'sandbox',
        inspect: async () => ({
          exists: true,
          phase: 'Running',
          ideReady: true,
          endpoint,
          headers: { Authorization: 'Bearer internal-runtime-token' },
        }),
        helper: async () => ({}),
        close: async () => {},
      }) as unknown as RuntimeDriver,
  );
  const sockets: WebSocket[] = [];
  try {
    await workbench.listen();
    workbench.config.port = (workbench.server.address() as { port: number }).port;
    workbench.config.publicURL = `http://127.0.0.1:${workbench.config.port}`;
    const users = ['owner', 'alice', 'bob', 'carol', 'dave', 'outsider'];
    const sessions = Object.fromEntries(
      users.map((id) => {
        workbench.store.put('user', { id, owner: id, name: id === 'owner' ? '所有者' : '同名昵称', username: id });
        return [id, workbench.store.createSession(id)];
      }),
    );
    const request = async (actor: string, route: string, body?: unknown) => {
      const response = await fetch(workbench.config.publicURL + '/api' + route, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Cookie: `workbench_session=${sessions[actor]}`, 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, value: await response.json() };
    };
    const workspace = workbench.store.put<Workspace>('workspace', {
      id: newID(),
      owner: 'owner',
      projectId: newID(),
      branch: 'main',
      status: 'stopped',
      createdAt: now(),
      updatedAt: now(),
    });
    const unrelated = workbench.store.put<Workspace>('workspace', { ...workspace, id: newID(), branch: 'other' });
    assert.equal((await request('alice', `/workspaces/${workspace.id}/enter`, {})).status, 404);
    for (const actor of users.slice(1, 5)) {
      assert.equal((await request('owner', `/workspaces/${workspace.id}/members`, { username: actor })).status, 200);
    }
    assert.equal((await request('owner', `/workspaces/${workspace.id}/members`, { username: 'outsider' })).status, 409);
    assert.equal((await request('owner', `/workspaces/${workspace.id}/members`, { username: 'alice' })).status, 200);
    assert.equal((await request('owner', `/workspaces/${workspace.id}/members`, { username: 'owner' })).status, 400);
    assert.equal((await request('owner', `/workspaces/${workspace.id}/members`, { username: 'missing' })).status, 404);
    assert.equal((await request('owner', `/workspaces/${workspace.id}/members`, { username: '同名昵称' })).status, 404);
    workspace.members = workbench.store.get<Workspace>('workspace', workspace.id)!.members;
    workspace.status = 'ready';
    workbench.store.put('workspace', workspace);
    const listed = await request('alice', '/workspaces');
    assert.equal(listed.value.length, 1);
    assert.equal(listed.value[0].accessRole, 'member');
    assert.equal(listed.value[0].members[0], hash('alice'));
    assert.equal(
      (await request('owner', '/workspaces')).value.find((w: Workspace) => w.id === workspace.id).accessRole,
      'owner',
    );
    for (const route of ['stop', 'restart', 'delete', 'reset', 'update-runtime', 'publish', 'members']) {
      assert.equal((await request('alice', `/workspaces/${workspace.id}/${route}`, {})).status, 404);
    }
    assert.equal((await request('alice', `/workspaces/${unrelated.id}/environment`)).status, 404);
    const host = `${workspace.id}.localhost:${workbench.config.port}`;
    const ide = (route: string, cookie = '') =>
      new Promise<{ status: number; cookie: string }>((resolve, reject) => {
        http
          .get(
            workbench.config.publicURL + route,
            { headers: { Host: host, Cookie: cookie, Authorization: 'spoofed', 'X-Opensumi-User': 'spoofed' } },
            (res) => {
              res.resume();
              res.once('end', () =>
                resolve({ status: res.statusCode!, cookie: res.headers['set-cookie']?.[0].split(';')[0] || '' }),
              );
            },
          )
          .once('error', reject);
      });
    const cookies: string[] = [];
    for (const actor of users.slice(0, 5)) {
      const entry = await request(actor, `/workspaces/${workspace.id}/enter`, {});
      assert.equal(entry.status, 200);
      const url = new URL(entry.value.url);
      const exchanged = await ide(url.pathname + url.search);
      assert.equal(exchanged.status, 302);
      cookies.push(exchanged.cookie);
      assert.equal((await ide('/', exchanged.cookie)).status, 200);
      const identity = JSON.parse(Buffer.from(String(received.at(-1)!['x-opensumi-user']), 'base64url').toString());
      assert.equal(identity.id, hash(actor));
      assert.equal(received.at(-1)!.authorization, 'Bearer internal-runtime-token');
      assert.equal(received.at(-1)!.cookie, undefined);
      const socket = new WebSocket(`ws://127.0.0.1:${workbench.config.port}/collaboration/y-room-opensumi`, {
        headers: { Host: host, Cookie: exchanged.cookie, Origin: `http://${host}` },
      });
      sockets.push(socket);
      await once(socket, 'open');
    }
    assert.equal((await ide('/runtime/shutdown', cookies[1])).status, 403);
    assert.equal((await ide('/assets/../runtime/shutdown', cookies[1])).status, 403);
    assert.equal((await ide('/assets/%2e%2e/runtime/shutdown', cookies[1])).status, 403);
    const pending = (await request('alice', `/workspaces/${workspace.id}/enter`, {})).value.url;
    const closed = once(sockets[1], 'close');
    const originalHelper = workbench.driver.helper;
    workbench.driver.helper = async () => {
      throw new Error('模拟编辑器数据连接同步失败');
    };
    assert.equal(
      (await request('owner', `/workspaces/${workspace.id}/members`, { username: hash('alice'), remove: true })).status,
      200,
    );
    await closed;
    assert.equal((await ide('/', cookies[1])).status, 401);
    assert.equal((await ide(new URL(pending).search)).status, 401);
    assert.equal((await request('alice', '/workspaces')).value.length, 0);
    assert.equal((await ide('/', cookies[2])).status, 200);
    assert.equal(sockets[2].readyState, WebSocket.OPEN);
    assert.match(
      workbench.store.get<Workspace>('workspace', workspace.id)!.startup!.editorConnections!.error!,
      /成员已移除/,
    );
    assert.equal((await request('owner', `/workspaces/${workspace.id}/members`, { username: 'outsider' })).status, 500);
    assert.equal((await request('outsider', `/workspaces/${workspace.id}/enter`, {})).status, 404);
    workbench.driver.helper = originalHelper;
  } finally {
    sockets.forEach((socket) => socket.terminate());
    await workbench.close();
    ws.clients.forEach((socket) => socket.terminate());
    ws.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(data, { recursive: true, force: true });
  }
});
