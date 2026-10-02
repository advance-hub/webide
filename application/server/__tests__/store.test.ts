import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { Jobs } from '../platform/jobs';
import { Store } from '../platform/store';

test('metadata, encrypted credentials and sessions survive a restart without crossing accounts', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opensumi-store-'));
  const store = new Store(root);
  try {
    store.put('project', { id: 'one', owner: 'alice', name: 'private' });
    store.secret('connection:alice', { token: 'never-store-plaintext', url: 'https://gitlab.example' });
    const session = store.createSession('alice');
    assert.equal(store.session(session), 'alice');
    assert.equal(store.list('project', 'bob').length, 0);
    assert.throws(() => new Store(root), /already owned/);
    store.close();
    assert.equal(readFileSync(path.join(root, 'workbench.db')).includes('never-store-plaintext'), false);
    const reopened = new Store(root);
    try {
      assert.equal(reopened.get('project', 'one')?.name, 'private');
      assert.deepEqual(reopened.secret('connection:alice'), {
        token: 'never-store-plaintext',
        url: 'https://gitlab.example',
      });
      assert.equal(reopened.session(session), 'alice');
      reopened.revoke(session);
      assert.equal(reopened.session(session), undefined);
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('database enforces one active workspace per account/project/branch and one personal machine', () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opensumi-unique-'));
  const store = new Store(root);
  try {
    store.put('workspace', { id: 'a', owner: 'alice', projectId: 'p', branch: 'main' });
    assert.throws(() => store.put('workspace', { id: 'b', owner: 'alice', projectId: 'p', branch: 'main' }), /UNIQUE/);
    store.put('workspace', { id: 'b', owner: 'bob', projectId: 'p', branch: 'main' });
    store.put('machine', { id: 'm1', owner: 'alice' });
    assert.throws(() => store.put('machine', { id: 'm2', owner: 'alice' }), /UNIQUE/);
    assert.throws(
      () =>
        store.transaction(() => {
          store.put('project', { id: 'rolled-back', owner: 'alice' });
          throw new Error('rollback');
        }),
      /rollback/,
    );
    assert.equal(store.get('project', 'rolled-back'), undefined);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test('lifecycle queues lock each resource across lanes and report a failed task once', async () => {
  const jobs = new Jobs();
  let release: () => void = () => {};
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let failures = 0;
  jobs.enqueue(
    'workspace:a',
    'heavy',
    () => hold,
    () => {
      failures++;
    },
  );
  assert.throws(
    () =>
      jobs.enqueue(
        'workspace:a',
        'quick',
        async () => {},
        () => {},
      ),
    /进行中的任务/,
  );
  jobs.enqueue(
    'workspace:b',
    'quick',
    async () => {
      throw new Error('expected');
    },
    () => {
      failures++;
    },
  );
  release();
  await jobs.close();
  assert.equal(failures, 1);
  assert.equal(jobs.busy('workspace:a'), false);
  assert.throws(
    () =>
      jobs.enqueue(
        'new',
        'heavy',
        async () => {},
        () => {},
      ),
    /关闭/,
  );
});
