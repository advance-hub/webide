import assert from 'node:assert/strict';
import { test } from 'node:test';

import { SandboxClients } from '../infrastructure/sandbox-clients';
import { HTTPError } from '../platform/validation';

import type { Sandbox } from '@alibaba-group/opensandbox';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function fixture() {
  let closes = 0;
  return {
    client: {
      close: async () => {
        closes++;
      },
    } as Sandbox,
    closes: () => closes,
  };
}
const full = (error: unknown) => error instanceof HTTPError && error.status === 503;

test('并发与后续请求共享一次 SDK 连接，沙箱和请求超时分别隔离', async () => {
  const started = deferred<void>();
  const connected = deferred<Sandbox>();
  const values = [fixture(), fixture(), fixture()];
  const calls: Array<[string, number]> = [];
  const pool = new SandboxClients(async (id, timeout) => {
    calls.push([id, timeout]);
    if (calls.length === 1) {
      started.resolve();
      return connected.promise;
    }
    return values[calls.length - 1].client;
  });
  try {
    const first = pool.use('a', async (client) => client, 120);
    const second = pool.use('a', async (client) => client, 120);
    await started.promise;
    assert.equal(calls.length, 1);
    connected.resolve(values[0].client);
    assert.deepEqual(await Promise.all([first, second]), [values[0].client, values[0].client]);
    assert.equal(await pool.use('a', async (client) => client, 120), values[0].client);
    assert.equal(await pool.use('a', async (client) => client, 135), values[1].client);
    assert.equal(await pool.use('b', async (client) => client, 120), values[2].client);
    assert.deepEqual(calls, [
      ['a', 120],
      ['a', 135],
      ['b', 120],
    ]);
    assert.deepEqual(
      values.map((value) => value.closes()),
      [0, 0, 0],
    );
  } finally {
    await pool.close();
  }
  assert.deepEqual(
    values.map((value) => value.closes()),
    [1, 1, 1],
  );
});

test('连接失败不缓存，命令失败后最后一个借用者离开才关闭旧客户端', async () => {
  const old = fixture();
  const next = fixture();
  let calls = 0;
  const pool = new SandboxClients(async () => {
    calls++;
    if (calls === 1) {
      throw new Error('端点暂不可用');
    }
    return calls === 2 ? old.client : next.client;
  });
  const active = deferred<void>();
  const release = deferred<void>();
  try {
    await assert.rejects(
      pool.use('a', async () => undefined, 120),
      /端点暂不可用/,
    );
    const held = pool.use(
      'a',
      async () => {
        active.resolve();
        await release.promise;
      },
      120,
    );
    await active.promise;
    await assert.rejects(
      pool.use(
        'a',
        async () => {
          throw new Error('命令失败');
        },
        120,
      ),
      /命令失败/,
    );
    assert.equal(old.closes(), 0);
    assert.equal(await pool.use('a', async (client) => client, 120), next.client);
    release.resolve();
    await held;
    await pool.close();
    assert.equal(old.closes(), 1);
    assert.equal(next.closes(), 1);
  } finally {
    release.resolve();
    await pool.close();
  }
});

test('容量包括正在借用的客户端，回收空闲传输后才创建下一份连接', async () => {
  const first = fixture();
  const second = fixture();
  const active = deferred<void>();
  const release = deferred<void>();
  let calls = 0;
  const pool = new SandboxClients(async () => (++calls === 1 ? first.client : second.client), 1);
  try {
    const held = pool.use(
      'a',
      async () => {
        active.resolve();
        await release.promise;
      },
      120,
    );
    await active.promise;
    await assert.rejects(
      pool.use('b', async () => undefined, 120),
      full,
    );
    assert.equal(calls, 1);
    release.resolve();
    await held;
    assert.equal(await pool.use('b', async (client) => client, 120), second.client);
    assert.equal(first.closes(), 1);
  } finally {
    release.resolve();
    await pool.close();
  }
});

test('空闲计时不回收活跃租约，停止访问后定时释放传输', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: 1000 });
  const value = fixture();
  const active = deferred<void>();
  const release = deferred<void>();
  const pool = new SandboxClients(async () => value.client, 1, 1000);
  try {
    const held = pool.use(
      'a',
      async () => {
        active.resolve();
        await release.promise;
      },
      120,
    );
    await active.promise;
    t.mock.timers.tick(5000);
    assert.equal(value.closes(), 0);
    release.resolve();
    await held;
    t.mock.timers.tick(1000);
    await Promise.resolve();
    assert.equal(value.closes(), 1);
  } finally {
    release.resolve();
    await pool.close();
  }
});

test('退役传输尚未释放时仍占容量，并发新请求合并为同一个替代客户端', async () => {
  const closing = deferred<void>();
  const closeStarted = deferred<void>();
  const old = {
    close: async () => {
      closeStarted.resolve();
      await closing.promise;
    },
  } as unknown as Sandbox;
  const next = fixture();
  let calls = 0;
  const pool = new SandboxClients(async () => (++calls === 1 ? old : next.client), 1);
  try {
    await pool.use('a', async () => undefined, 120);
    const first = pool.use('b', async (client) => client, 120);
    const second = pool.use('b', async (client) => client, 120);
    await closeStarted.promise;
    assert.equal(calls, 1);
    closing.resolve();
    assert.deepEqual(await Promise.all([first, second]), [next.client, next.client]);
    assert.equal(calls, 2);
  } finally {
    closing.resolve();
    await pool.close();
  }
});

test('关闭取消迟到连接、拒绝新借用并等待活跃任务，重复关闭只释放一次', async () => {
  const value = fixture();
  const connecting = deferred<Sandbox>();
  const started = deferred<AbortSignal>();
  const pool = new SandboxClients(async (_id, _timeout, signal) => {
    started.resolve(signal);
    return connecting.promise;
  });
  let ran = false;
  const pending = pool.use(
    'a',
    async () => {
      ran = true;
    },
    120,
  );
  const rejected = assert.rejects(pending, full);
  const signal = await started.promise;
  const closing = pool.close();
  assert.equal(pool.close(), closing);
  assert.equal(signal.aborted, true);
  await assert.rejects(
    pool.use('b', async () => undefined, 120),
    full,
  );
  connecting.resolve(value.client);
  await rejected;
  await closing;
  assert.equal(ran, false);
  assert.equal(value.closes(), 1);

  const active = deferred<void>();
  const release = deferred<void>();
  const running = new SandboxClients(async () => value.client);
  const held = running.use(
    'a',
    async () => {
      active.resolve();
      await release.promise;
    },
    120,
  );
  await active.promise;
  const drained = running.close();
  assert.equal(value.closes(), 1);
  release.resolve();
  await held;
  await drained;
  assert.equal(value.closes(), 2);
});

test('SDK 传输释放失败在服务关闭时保留，任务异常不会被清理异常覆盖', async () => {
  const client = {
    close: async () => {
      throw new Error('释放失败');
    },
  } as unknown as Sandbox;
  const pool = new SandboxClients(async () => client);
  await assert.rejects(
    pool.use(
      'a',
      async () => {
        throw new Error('原始失败');
      },
      120,
    ),
    /原始失败/,
  );
  await assert.rejects(pool.close(), /释放失败/);
});
