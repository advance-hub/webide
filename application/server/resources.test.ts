import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import COS from 'cos-nodejs-sdk-v5';

import { Workbench } from './app';
import { loadConfig } from './config';
import { DevelopmentResources } from './resources';
import { Store } from './store';

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webide-resources-'));
  const store = new Store(root);
  const config = { ...loadConfig({}), data: root };
  return {
    root,
    store,
    config,
    resources: new DevelopmentResources(config, store),
    close: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
const listen = async (server: net.Server) => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `127.0.0.1:${(server.address() as net.AddressInfo).port}`;
};
const close = (server: net.Server) => new Promise<void>((resolve) => server.close(() => resolve()));

test('resource profiles encrypt secrets, isolate owners, preserve same endpoints and revoke explicitly', async () => {
  const f = await fixture();
  try {
    const input = { endpoint: '127.0.0.1:6379', password: 'resource-password-never-plain', database: '1' };
    const view = f.resources.save('alice', 'redis', input);
    assert.equal(view.hasPassword, true);
    assert.ok(!('password' in view));
    assert.equal(f.resources.profile('bob', 'redis').configured, false);
    assert.equal(f.resources.save('alice', 'redis', { ...input, password: '' }).hasPassword, true);
    assert.equal(
      f.resources.save('alice', 'redis', { ...input, password: '', endpoint: '127.0.0.1:6380' }).hasPassword,
      false,
    );
    assert.equal(
      f.resources.save('alice', 'redis', { ...input, clearPassword: true, password: '' }).hasPassword,
      false,
    );
    assert.throws(() => f.resources.save('alice', 'redis', { endpoint: 'user:secret@localhost:6379' }), /host:port/);
    assert.throws(() => f.resources.save('alice', 'redis', { endpoint: input.endpoint, database: '-1' }), /非负/);
    assert.throws(
      () =>
        f.resources.save('alice', 'middleware', { endpoint: 'localhost:80', options: { health_path: '//elsewhere' } }),
      /站内/,
    );
    assert.equal(f.resources.save('alice', 'redis', { reset: true }).configured, false);
    assert.equal((await readFile(path.join(f.root, 'workbench.db'))).includes(input.password), false);
  } finally {
    await f.close();
  }
});

test('Redis and RocketMQ probes verify protocol responses split across TCP packets', async () => {
  const f = await fixture();
  const redis = net.createServer((socket) =>
    socket.once('data', (data) => {
      assert.match(data.toString(), /AUTH/);
      assert.match(data.toString(), /resource-pass/);
      socket.write('+OK\r\n+O');
      setTimeout(() => socket.end('K\r\n+PONG\r\n'), 10);
    }),
  );
  const rocket = net.createServer((socket) =>
    socket.once('data', (data) => {
      const request = JSON.parse(data.subarray(8).toString());
      assert.equal(request.code, 106);
      const header = Buffer.from(JSON.stringify({ code: 0, opaque: request.opaque }));
      const body = Buffer.from(JSON.stringify({ brokerAddrTable: [] }));
      const result = Buffer.alloc(8 + header.length + body.length);
      result.writeUInt32BE(result.length - 4);
      result.writeUInt32BE(header.length, 4);
      header.copy(result, 8);
      body.copy(result, 8 + header.length);
      socket.write(result.subarray(0, 3));
      setTimeout(() => socket.end(result.subarray(3)), 10);
    }),
  );
  try {
    f.resources.save('alice', 'redis', { endpoint: await listen(redis), database: '2', password: 'resource-pass' });
    assert.equal((await f.resources.probe('alice', 'redis')).status, 'ready');
    f.resources.save('alice', 'rocketmq', { endpoint: await listen(rocket) });
    assert.equal((await f.resources.probe('alice', 'rocketmq')).status, 'ready');
  } finally {
    await close(redis);
    await close(rocket);
    await f.close();
  }
});

test('Nacos and Elasticsearch probes perform authenticated HTTP reads without redirecting credentials', async () => {
  const f = await fixture();
  let redirected = 0;
  const server = http.createServer(async (request, response) => {
    if (request.url === '/nacos/v1/auth/login') {
      let body = '';
      for await (const chunk of request) {
        body += chunk;
      }
      assert.equal(new URLSearchParams(body).get('password'), 'nacos-pass');
      response.end(JSON.stringify({ accessToken: 'fixture-access' }));
    } else if (request.url?.startsWith('/nacos/v1/ns/service/list')) {
      assert.equal(new URL(request.url, 'http://fixture').searchParams.get('accessToken'), 'fixture-access');
      response.end(JSON.stringify({ doms: [] }));
    } else if (request.url === '/redirect') {
      response.writeHead(302, { Location: '/stolen' });
      response.end();
    } else if (request.url === '/stolen') {
      redirected++;
      response.end('{}');
    } else {
      assert.equal(request.headers.authorization, 'Basic ' + Buffer.from('elastic:elastic-pass').toString('base64'));
      response.end('{}');
    }
  });
  try {
    const endpoint = await listen(server);
    f.resources.save('alice', 'nacos', { endpoint, username: 'nacos', password: 'nacos-pass' });
    assert.equal((await f.resources.probe('alice', 'nacos')).status, 'ready');
    f.resources.save('alice', 'elasticsearch', { endpoint, username: 'elastic', password: 'elastic-pass' });
    assert.equal((await f.resources.probe('alice', 'elasticsearch')).status, 'ready');
    f.resources.save('alice', 'elasticsearch', {
      endpoint,
      username: 'elastic',
      password: 'elastic-pass',
      options: { health_path: '/redirect' },
    });
    const result = await f.resources.probe('alice', 'elasticsearch');
    assert.equal(result.status, 'failed');
    assert.ok(!JSON.stringify(result).includes('elastic-pass'));
    assert.equal(redirected, 0);
  } finally {
    await close(server);
    await f.close();
  }
});

test('official COS SDK lists scoped objects and bounds downloaded UTF-8 text even if Range is ignored', async () => {
  const f = await fixture();
  const server = http.createServer((request, response) => {
    assert.match(request.headers.authorization || '', /q-sign-algorithm=sha1/);
    const url = new URL(request.url!, 'http://fixture');
    if (url.searchParams.has('prefix')) {
      assert.equal(url.searchParams.get('prefix'), 'team/');
      response.setHeader('Content-Type', 'application/xml');
      response.end(
        '<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>team/hello.txt</Key><Size>5</Size><LastModified>now</LastModified></Contents><CommonPrefixes><Prefix>team/sub/</Prefix></CommonPrefixes></ListBucketResult>',
      );
    } else {
      response.end(
        url.pathname.endsWith('large.txt')
          ? Buffer.alloc(65537, 65)
          : url.pathname.endsWith('invalid.txt')
            ? Buffer.from([255])
            : '你好',
      );
    }
  });
  try {
    const endpoint = await listen(server);
    const resources = new DevelopmentResources(
      f.config,
      f.store,
      (profile) =>
        new COS({
          SecretId: profile.secretId,
          SecretKey: profile.secretKey,
          Domain: endpoint,
          Protocol: 'http:',
          Timeout: 2000,
        }),
    );
    resources.save('alice', 'cos', {
      bucket: 'fixture-1234',
      region: 'ap-beijing',
      prefix: 'team',
      secretId: 'fixture-id',
      secretKey: 'fixture-key',
    });
    assert.equal((await resources.objects('alice')).objects[0].key, 'team/hello.txt');
    assert.equal((await resources.text('alice', 'team/hello.txt')).content, '你好');
    await assert.rejects(() => resources.text('alice', 'outside.txt'), /前缀/);
    await assert.rejects(() => resources.objects('alice', '../outside'), /项目内/);
    await assert.rejects(() => resources.text('alice', 'team/large.txt'), /64 KiB/);
    await assert.rejects(() => resources.text('alice', 'team/invalid.txt'), /UTF-8/);
  } finally {
    await close(server);
    await f.close();
  }
});

test('resource control-plane routes expose masked summaries, scoped credentials and probes', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webide-resource-api-'));
  const wb = new Workbench({ ...loadConfig({}), data: root, port: 0 });
  try {
    await wb.listen();
    const base = `http://127.0.0.1:${(wb.server.address() as net.AddressInfo).port}`;
    const saved = await fetch(base + '/api/development-resources/redis', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: 'localhost:6379', password: 'api-secret' }),
    });
    assert.equal(saved.status, 200);
    assert.ok(!(await saved.text()).includes('api-secret'));
    const summary = await fetch(base + '/api/development-resources');
    assert.equal(summary.headers.get('cache-control'), 'no-store');
    assert.ok(!(await summary.text()).includes('api-secret'));
    assert.equal((await (await fetch(base + '/api/development-resources/redis')).json()).password, 'api-secret');
    assert.equal((await fetch(base + '/api/development-resources/invalid')).status, 404);
  } finally {
    await wb.close();
    await rm(root, { recursive: true, force: true });
  }
});
