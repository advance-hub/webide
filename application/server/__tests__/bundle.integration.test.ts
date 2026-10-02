import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { repositoryRoot } from '../platform/paths';

test('编译后的控制面从任意工作目录启动，服务资源路径与源码模式一致', { timeout: 20000 }, async () => {
  const root = repositoryRoot();
  const data = await mkdtemp(path.join(os.tmpdir(), 'webide-bundle-'));
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  const child = spawn(process.execPath, [path.join(root, 'application/server/main.mjs')], {
    cwd: data,
    env: {
      ...process.env,
      WORKBENCH_DATA_DIR: data,
      WORKBENCH_HOST: '127.0.0.1',
      WORKBENCH_PORT: String(port),
      WORKBENCH_PUBLIC_URL: `http://127.0.0.1:${port}`,
      WORKBENCH_LOCAL_DEMO: '1',
      WORKBENCH_RUNTIME_DRIVER: 'local',
      OPEN_SANDBOX_URL: '',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.stderr.on('data', (chunk) => {
    output += chunk;
  });
  const exited = once(child, 'exit');
  try {
    const deadline = Date.now() + 10000;
    while (!output.includes('OpenSumi workbench:') && child.exitCode === null && Date.now() < deadline) {
      await delay(25);
    }
    assert.ok(output.includes('OpenSumi workbench:'), output);
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { runtime: string }).runtime, 'node');
    const page = await fetch(`http://127.0.0.1:${port}/dashboard`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<html lang="zh-CN">/);
    child.kill('SIGTERM');
    const [code] = await exited;
    assert.equal(code, 0, output);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
      await exited;
    }
    await rm(data, { recursive: true, force: true });
  }
});
