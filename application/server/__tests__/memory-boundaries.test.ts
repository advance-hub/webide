import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import WebSocket from 'ws';

import { IDEProxy } from '../http/ide-proxy';
import { IDE_MESSAGE_LIMIT, IDE_SEND_BUFFER_LIMIT, bridgeWebSockets } from '../http/websocket-bridge';
import { loadConfig } from '../platform/config';
import { ExpiringMap } from '../platform/expiring-map';
import { Store } from '../platform/store';
import { readTextTail } from '../platform/text-tail';
import { HTTPError } from '../platform/validation';
import { runtimeFingerprint } from '../runtime/fingerprint';

import type { RuntimeDriver } from '../domain/runtime';
import type { AccessControl } from '../modules/accounts/access';

test('认证缓存定时过期，满容量保留有效会话，消费票据只有一次', () => {
  let clock = 1000;
  const cache = new ExpiringMap<{ expires: number; owner: string }>(2, () => clock);
  assert.equal(cache.set('a', { expires: 1500, owner: 'alice' }), true);
  assert.equal(cache.set('b', { expires: 4000, owner: 'bob' }), true);
  assert.equal(cache.set('c', { expires: 5000, owner: 'carol' }), false);
  assert.equal(cache.get('b')?.owner, 'bob');
  clock = 1500;
  assert.equal(cache.set('c', { expires: 5000, owner: 'carol' }), true);
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.take('b')?.owner, 'bob');
  assert.equal(cache.take('b'), undefined);
  clock = 5000;
  cache.pruneExpired();
  assert.equal(cache.size, 0);
});

test('没有新请求时代理也回收过期票据，关闭时释放认证缓存和定时器', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webide-auth-cache-'));
  const store = new Store(root);
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 });
  const proxy = new IDEProxy(loadConfig({}), store, {} as RuntimeDriver, {} as AccessControl);
  const caches = proxy as unknown as { tickets: ExpiringMap<{ expires: number }> };
  try {
    proxy.enter({ id: 'a'.repeat(32), owner: 'alice' } as Parameters<typeof proxy.enter>[0]);
    assert.equal(caches.tickets.size, 1);
    t.mock.timers.tick(60_000);
    assert.equal(caches.tickets.size, 0);
    proxy.dispose();
    assert.throws(
      () => proxy.enter({ id: 'a'.repeat(32), owner: 'alice' } as Parameters<typeof proxy.enter>[0]),
      (error) => error instanceof HTTPError && error.status === 503,
    );
    t.mock.timers.tick(60_000);
    assert.equal(caches.tickets.size, 0);
  } finally {
    proxy.dispose();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

class SocketFixture extends EventEmitter {
  readyState: number = WebSocket.OPEN;
  bufferedAmount = 0;
  terminated = false;
  sent: { data: WebSocket.RawData; binary: boolean }[] = [];
  sendError?: Error;
  send(data: WebSocket.RawData, options: { binary: boolean }, callback: (error?: Error) => void): void {
    this.sent.push({ data, binary: options.binary });
    callback(this.sendError);
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = WebSocket.CLOSED;
  }
  close(): void {
    this.readyState = WebSocket.CLOSED;
  }
}
const connect = () => {
  const client = new SocketFixture();
  const upstream = new SocketFixture();
  bridgeWebSockets(client as unknown as WebSocket, upstream as unknown as WebSocket);
  return { client, upstream };
};

test('代理保持文本与二进制边界，在慢端入队前关闭双端并停止后续发送', () => {
  const { client, upstream } = connect();
  const text = Buffer.from('中文消息');
  client.emit('message', text, false);
  upstream.emit('message', Buffer.from([0, 255]), true);
  assert.deepEqual(upstream.sent, [{ data: text, binary: false }]);
  assert.equal(client.sent[0].binary, true);
  upstream.bufferedAmount = IDE_SEND_BUFFER_LIMIT - 1;
  client.emit('message', Buffer.from([1, 2]), true);
  assert.equal(client.terminated, true);
  assert.equal(upstream.terminated, true);
  client.emit('message', text, false);
  assert.equal(upstream.sent.length, 1);
});

test('代理拒绝超大消息，处理分片字节数、异步发送失败和已经关闭的端点', () => {
  const oversized = connect();
  oversized.client.emit('message', Buffer.allocUnsafe(IDE_MESSAGE_LIMIT + 1), true);
  assert.equal(oversized.upstream.sent.length, 0);
  assert.equal(oversized.client.terminated, true);
  const fragmented = connect();
  fragmented.upstream.bufferedAmount = IDE_SEND_BUFFER_LIMIT - 2;
  fragmented.client.emit('message', [Buffer.from([1]), Buffer.from([2, 3])], true);
  assert.equal(fragmented.upstream.sent.length, 0);
  assert.equal(fragmented.upstream.terminated, true);
  const failed = connect();
  failed.client.sendError = new Error('连接已断开');
  failed.upstream.emit('message', Buffer.from('reply'), false);
  assert.equal(failed.client.terminated, true);
  assert.equal(failed.upstream.terminated, true);
  const closed = connect();
  closed.upstream.readyState = WebSocket.CLOSED;
  closed.client.emit('message', Buffer.from('discard'), false);
  assert.equal(closed.upstream.sent.length, 0);
});

test('大日志仅保留尾部，中文与四字节字符的输出和原字符截取一致', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webide-log-tail-'));
  try {
    const file = path.join(root, 'ide.log');
    for (const text of ['', '启动失败：中文🚀', 'x'.repeat(1024 * 1024) + '中文🚀'.repeat(3000)]) {
      await writeFile(file, text);
      assert.equal(await readTextTail(file), text.slice(-4000));
      assert.equal(await readTextTail(file, 7), text.slice(-7));
    }
    await assert.rejects(readTextTail(file, 0), RangeError);
    await assert.rejects(readTextTail(path.join(root, 'missing')), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('流式运行指纹与原算法逐字节一致，产物变化仍使指纹变化', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webide-fingerprint-'));
  const names = [
    '.cache/runtime-artifacts/a.json',
    '.cache/runtime-artifacts/z.json',
    'pnpm-lock.yaml',
    'server/dist/main.js',
    'server/dist/start-server.js',
  ];
  try {
    for (const name of names) {
      await mkdir(path.dirname(path.join(root, name)), { recursive: true });
      await writeFile(path.join(root, name), (name + '中文\n').repeat(5000));
    }
    const expected = createHash('sha256');
    for (const name of names) {
      if (name.endsWith('.json')) {
        expected.update(path.basename(name));
      }
      expected.update(await readFile(path.join(root, name)));
    }
    const previous = await runtimeFingerprint(root);
    assert.equal(previous, expected.digest('hex'));
    await writeFile(path.join(root, 'server/dist/main.js'), '升级后的产物');
    assert.notEqual(await runtimeFingerprint(root), previous);
    await rm(path.join(root, 'server/dist/main.js'));
    await assert.rejects(runtimeFingerprint(root), /ENOENT/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
