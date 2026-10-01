import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Koa from 'koa';

import { createWorkspaceAIConfigMiddleware } from '../src/workspace-ai-config';

test('AI settings expose provider names and preserve existing OpenCode config', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'opensumi-ai-settings-'));
  const config = path.join(home, '.config/opencode/opencode.json');
  const auth = path.join(home, '.local/share/opencode/auth.json');
  await mkdir(path.dirname(config), { recursive: true });
  await mkdir(path.dirname(auth), { recursive: true });
  await writeFile(config, JSON.stringify({ permission: { bash: 'ask' }, model: 'openai/old' }));
  await writeFile(auth, JSON.stringify({ openai: { key: 'test-secret-value' } }));
  const app = new Koa();
  app.use(createWorkspaceAIConfigMiddleware({ home, workspaceId: 'ws-1' }));
  const server = http.createServer(app.callback());
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/__ide/ai/config`;
    const headers = { 'x-workspace-id': 'ws-1', 'x-workspace-origin': 'http://ide.test' };
    const initial = await fetch(url, { headers });
    assert.equal(initial.status, 200);
    const source = await initial.text();
    assert.ok(!source.includes('test-secret-value'));
    const settings = JSON.parse(source);
    assert.deepEqual(settings.connectedProviders, ['openai']);
    assert.equal(settings.model, 'openai/old');

    const missingIdentity = await fetch(url);
    assert.equal(missingIdentity.status, 403);
    const foreignOrigin = await fetch(url, {
      method: 'POST',
      headers: { ...headers, origin: 'http://other.test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai/new', revision: settings.revision }),
    });
    assert.equal(foreignOrigin.status, 403);
    const save = await fetch(url, {
      method: 'POST',
      headers: { ...headers, origin: 'http://ide.test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai/new', revision: settings.revision }),
    });
    assert.equal(save.status, 200);
    assert.deepEqual(JSON.parse(await readFile(config, 'utf8')), { permission: { bash: 'ask' }, model: 'openai/new' });
    const conflict = await fetch(url, {
      method: 'POST',
      headers: { ...headers, origin: 'http://ide.test', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai/old', revision: settings.revision }),
    });
    assert.equal(conflict.status, 409);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
  }
});
