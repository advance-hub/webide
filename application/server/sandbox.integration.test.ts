import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import WebSocket, { WebSocketServer } from 'ws';

import { Workbench } from './app';
import { loadConfig } from './config';
import { newID, now } from './store';

import type { Workspace } from './git';
import type { Machine } from './runtime';

test(
  'official OpenSandbox SDK: concurrent provision, persistence before readiness, admin and authenticated HTTP/WS proxy',
  { timeout: 20000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opensumi-sdk-'));
    const sandboxes: Record<string, unknown>[] = [];
    const creates: Record<string, unknown>[] = [];
    const traffic: { path: string; headers: http.IncomingHttpHeaders }[] = [];
    let origin = '';
    let workbench: Workbench;
    const ws = new WebSocketServer({ noServer: true });
    const lifecycle = http.createServer(async (request, response) => {
      try {
        const url = new URL(request.url!, origin);
        let text = '';
        for await (const chunk of request) {
          text += chunk;
        }
        const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
        const json = (value: unknown, status = 200) => {
          response.writeHead(status, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(value));
        };
        if (url.pathname.startsWith('/v1/')) {
          assert.equal(request.headers['open-sandbox-api-key'], 'control-secret');
        }
        if (url.pathname === '/v1/sandboxes') {
          if (request.method === 'POST') {
            creates.push(body);
            const info = {
              id: newID(),
              createdAt: now(),
              expiresAt: null,
              status: { state: 'Running' },
              metadata: body.metadata,
              image: body.image,
            };
            sandboxes.push(info);
            json(info, 202);
          } else {
            const filter = new URLSearchParams(url.searchParams.get('metadata') || '');
            json({
              items: sandboxes.filter((info) =>
                [...filter].every(([key, value]) => (info.metadata as Record<string, string>)[key] === value),
              ),
            });
          }
          return;
        }
        const endpoint = url.pathname.match(/^\/v1\/sandboxes\/([^/]+)\/endpoints\/(\d+)$/);
        if (endpoint) {
          json({
            endpoint: new URL(origin).host + `/proxy/${endpoint[1]}/${endpoint[2]}`,
            headers: { 'X-Access-Token': 'execd-secret' },
          });
          return;
        }
        const info = url.pathname.match(/^\/v1\/sandboxes\/([^/]+)$/);
        if (info) {
          const entry = sandboxes.find((item) => item.id === info[1]);
          if (!entry) {
            json({ code: 'SANDBOX_NOT_FOUND', message: 'missing' }, 404);
            return;
          }
          json(entry);
          return;
        }
        if (url.pathname.startsWith('/proxy/')) {
          traffic.push({ path: url.pathname, headers: request.headers });
          assert.equal(request.headers['x-access-token'], 'execd-secret');
          if (url.pathname.endsWith('/ping')) {
            assert.ok(
              workbench.store.list<Machine>('machine')[0].envId,
              'persist the allocated sandbox before readiness',
            );
          }
          response.end('IDE fixture');
          return;
        }
        json({ error: `Unsupported fixture route ${url.pathname}` }, 404);
      } catch (error) {
        response.writeHead(500);
        response.end(String(error));
      }
    });
    lifecycle.on('upgrade', (request, socket, head) => {
      traffic.push({ path: request.url!, headers: request.headers });
      if (!request.url?.endsWith('/service') || request.headers['x-access-token'] !== 'execd-secret') {
        socket.destroy();
        return;
      }
      ws.handleUpgrade(request, socket, head, (client) =>
        client.on('message', (data, binary) => client.send(data, { binary })),
      );
    });
    await new Promise<void>((resolve) => lifecycle.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(lifecycle.address() as { port: number }).port}`;
    const config = {
      ...loadConfig({
        WORKBENCH_RUNTIME_DRIVER: 'sandbox',
        OPEN_SANDBOX_URL: origin,
        OPEN_SANDBOX_API_KEY: 'control-secret',
        OPEN_SANDBOX_IMAGE: 'opensumi:fixture',
        WORKBENCH_LOCAL_DEMO: '0',
        WORKBENCH_ADMIN_USERS: 'admin',
      }),
      data: root,
      port: 0,
    };
    workbench = new Workbench(config);
    try {
      const machine: Machine = { id: newID(), owner: 'alice', driver: 'sandbox', createdAt: now() };
      workbench.store.put('machine', machine);
      const repeated = { ...machine };
      await Promise.all([workbench.driver.provision(machine), workbench.driver.provision(repeated)]);
      assert.equal(creates.length, 1);
      assert.equal(repeated.envId, machine.envId);
      assert.equal(
        (creates[0].volumes as { pvc: { deleteOnSandboxTermination: boolean } }[])[0].pvc.deleteOnSandboxTermination,
        false,
      );
      assert.ok(creates[0].timeout == null, 'manual cleanup has no expiration');
      const workspace: Workspace = {
        id: newID(),
        owner: 'alice',
        projectId: newID(),
        machineId: machine.id,
        branch: 'main',
        status: 'ready',
        envId: machine.envId,
        idePort: 12000,
        createdAt: now(),
        updatedAt: now(),
      };
      workbench.store.put('workspace', workspace);
      await workbench.listen();
      config.port = (workbench.server.address() as { port: number }).port;
      config.publicURL = `http://127.0.0.1:${config.port}`;
      const session = workbench.store.createSession('alice');
      const get = (endpoint: string, token = session) =>
        fetch(config.publicURL + endpoint, { headers: { Cookie: `workbench_session=${token}` } });
      assert.equal((await get('/api/sandboxes')).status, 403);
      assert.equal((await get('/api/sandboxes', workbench.store.createSession('admin'))).status, 200);
      const environment = await (await get(`/api/workspaces/${workspace.id}/environment`)).text();
      assert.ok(!environment.includes('control-secret') && !environment.includes('execd-secret'));
      const entered = await fetch(config.publicURL + `/api/workspaces/${workspace.id}/enter`, {
        method: 'POST',
        headers: { Cookie: `workbench_session=${session}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      const entry = (await entered.json()) as { url: string };
      const host = `${workspace.id}.localhost:${config.port}`;
      const ide = (url: string, cookie?: string) =>
        new Promise<{ headers: http.IncomingHttpHeaders; status: number; body: string }>((resolve, reject) => {
          http
            .get(
              config.publicURL + url,
              {
                headers: {
                  Host: host,
                  Cookie: cookie || '',
                  Authorization: 'browser-secret',
                  'X-Workspace-Id': 'spoofed',
                },
              },
              (response) => {
                let body = '';
                response.on('data', (data) => (body += data));
                response.on('end', () => resolve({ headers: response.headers, status: response.statusCode!, body }));
              },
            )
            .once('error', reject);
        });
      const ticket = new URL(entry.url);
      const exchange = await ide(ticket.pathname + ticket.search);
      const ideCookie = exchange.headers['set-cookie']![0].split(';')[0];
      assert.equal((await ide('/assets/app.js?v=1', ideCookie)).body, 'IDE fixture');
      const socket = new WebSocket(`ws://127.0.0.1:${config.port}/service`, {
        headers: { Host: host, Cookie: ideCookie, Origin: `http://${host}` },
      });
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      const echo = new Promise<string>((resolve) => socket.once('message', (data) => resolve(data.toString())));
      socket.send('roundtrip');
      assert.equal(await echo, 'roundtrip');
      socket.close();
      for (const request of traffic.filter((item) => item.path.includes('/12000/') && !item.path.endsWith('/readyz'))) {
        assert.equal(request.headers['x-workspace-id'], workspace.id);
        assert.equal(request.headers.cookie, undefined);
        assert.equal(request.headers.authorization, undefined);
        assert.ok(request.path.startsWith(`/proxy/${machine.envId}/12000/`));
      }
      sandboxes.length = 0;
      config.storageMode = 'retained';
      await assert.rejects(() => workbench.driver.provision(machine), /原沙箱已丢失/);
      assert.equal(creates.length, 1, 'retained data loss must never create an empty replacement');
    } finally {
      await workbench.close();
      for (const client of ws.clients) {
        client.terminate();
      }
      ws.close();
      await new Promise<void>((resolve) => lifecycle.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  },
);
