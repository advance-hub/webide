import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { test } from 'node:test';

import { readJSONBody } from '../http/json-body';
import { loadConfig } from '../platform/config';
import { HTTPError } from '../platform/validation';
import { Workbench } from '../workbench';

import type { IncomingMessage } from 'node:http';

const request = (chunks: Buffer[]) => Readable.from(chunks) as unknown as IncomingMessage;

test('中文 JSON 跨数据块仍完整，大小上限按原始字节计算', async () => {
  const text = Buffer.from(JSON.stringify({ name: '个人开发机' }));
  const chunks = Array.from(text, (byte) => Buffer.from([byte]));
  assert.deepEqual(await readJSONBody(request(chunks), text.length), { name: '个人开发机' });
  await assert.rejects(
    readJSONBody(request(chunks), text.length - 1),
    (error: unknown) => error instanceof HTTPError && error.status === 413,
  );
});

test('非法 JSON 和非对象输入在 HTTP 边界拒绝，空输入保持兼容', async () => {
  for (const value of ['{', 'null', '[]', '42', '"text"']) {
    await assert.rejects(
      readJSONBody(request([Buffer.from(value)])),
      (error: unknown) => error instanceof HTTPError && error.status === 400,
    );
  }
  assert.deepEqual(await readJSONBody(request([])), {});
});

test('并发关闭等待同一个资源释放结果，释放期间拒绝新请求', { timeout: 10000 }, async () => {
  const data = await mkdtemp(path.join(os.tmpdir(), 'webide-close-'));
  const workbench = new Workbench({ ...loadConfig({}), port: 0, data });
  let finish: (() => void) | undefined;
  try {
    await workbench.listen();
    const address = workbench.server.address() as { port: number };
    let closes = 0;
    workbench.driver.close = () => {
      closes += 1;
      return new Promise<void>((resolve) => {
        finish = resolve;
      });
    };
    const first = workbench.close();
    assert.strictEqual(workbench.close(), first);
    while (!finish) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const response = await fetch(`http://127.0.0.1:${address.port}/api/projects`);
    assert.equal(response.status, 503);
    finish();
    await first;
    assert.equal(closes, 1);
    assert.equal(workbench.server.listening, false);
  } finally {
    finish?.();
    await workbench.close();
    await rm(data, { recursive: true, force: true });
  }
});
