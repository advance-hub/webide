import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { type Machine } from '../domain/runtime';
import { KubernetesVolumes } from '../infrastructure/kubernetes-volumes';
import { loadConfig } from '../platform/config';
import { Store, newID, now } from '../platform/store';

test('PVC deletion checks every pod page, pins UID and waits for actual disappearance', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webide-pvc-'));
  const store = new Store(root);
  const token = path.join(root, 'service-account');
  await writeFile(token, 'fixture-service-token', { mode: 0o600 });
  const machine: Machine = { id: newID(), owner: 'alice', driver: 'sandbox', createdAt: now() };
  let referenced = true;
  let present = true;
  let deletes = 0;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer fixture-service-token');
    const url = new URL(req.url!, 'http://fixture');
    res.setHeader('Content-Type', 'application/json');
    if (url.pathname.endsWith('/pods')) {
      res.end(
        JSON.stringify(
          url.searchParams.has('continue')
            ? {
                items: referenced
                  ? [{ spec: { volumes: [{ persistentVolumeClaim: { claimName: `opensumi-${machine.id}` } }] } }]
                  : [],
              }
            : { items: [], metadata: { continue: 'second' } },
        ),
      );
    } else if (req.method === 'DELETE') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      assert.deepEqual(JSON.parse(body).preconditions, { uid: 'original-uid', resourceVersion: '12' });
      deletes++;
      present = false;
      res.statusCode = 202;
      res.end('{}');
    } else if (!present) {
      res.statusCode = 404;
      res.end('{}');
    } else {
      res.end(
        JSON.stringify({
          metadata: {
            name: `opensumi-${machine.id}`,
            namespace: 'fixture',
            uid: 'original-uid',
            resourceVersion: '12',
          },
        }),
      );
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const config = {
    ...loadConfig({}),
    data: root,
    kubernetesNamespace: 'fixture',
    kubernetesTokenFile: token,
    kubernetesURL: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  };
  const volumes = new KubernetesVolumes(config, store);
  try {
    await assert.rejects(() => volumes.remove(machine), /Pod 引用/);
    assert.equal(deletes, 0);
    referenced = false;
    machine.volumeUID = 'replacement-uid';
    await assert.rejects(() => volumes.remove(machine), /替换/);
    assert.equal(deletes, 0);
    machine.volumeUID = 'original-uid';
    await volumes.remove(machine);
    assert.equal(deletes, 1);
    await volumes.remove(machine);
    assert.equal(deletes, 1, 'Absent PVC deletion remains idempotent');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
