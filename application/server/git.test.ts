import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { loadConfig } from './config';
import { type Project, Repositories, type Workspace, command } from './git';
import { Store, newID, now } from './store';

test('real Git imports, browses, fetches a new branch baseline, and preserves dirty worktrees', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'opensumi-git-'));
  const store = new Store(path.join(root, 'data'));
  try {
    const source = path.join(root, 'source');
    await command('git', ['init', '-b', 'main', source]);
    await command('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
    await command('git', ['-C', source, 'config', 'user.name', 'Fixture']);
    await writeFile(path.join(source, 'hello.txt'), 'first\n');
    await command('git', ['-C', source, 'add', 'hello.txt']);
    await command('git', ['-C', source, 'commit', '-m', 'initial']);
    const repositories = new Repositories({ ...loadConfig({}), data: store.root }, store);
    const project: Project = {
      id: newID(),
      owner: 'alice',
      name: 'fixture',
      url: source,
      branch: 'main',
      sha: '',
      status: 'queued',
      createdAt: now(),
    };
    await repositories.import(project);
    assert.equal(project.status, 'ready');
    assert.equal((await repositories.browse(project, 'hello.txt')).content, 'first\n');
    await assert.rejects(() => repositories.browse(project, '../outside'), /路径/);
    const workspace: Workspace = {
      id: newID(),
      owner: 'alice',
      projectId: project.id,
      branch: 'feature/one',
      baseBranch: 'main',
      status: 'queued',
      createdAt: now(),
      updatedAt: now(),
    };
    const directory = path.join(root, 'workspace/project');
    await repositories.checkout(project, workspace, directory);
    const pinned = workspace.sha;
    await writeFile(path.join(directory, 'hello.txt'), 'uncommitted\n');
    await writeFile(path.join(source, 'hello.txt'), 'second\n');
    await command('git', ['-C', source, 'commit', '-am', 'second']);
    const latest = await repositories.fetch(project, 'main');
    assert.notEqual(latest, pinned);
    await repositories.pin(project, 'main', latest);
    assert.equal(workspace.sha, pinned);
    assert.equal(await readFile(path.join(directory, 'hello.txt'), 'utf8'), 'uncommitted\n');
    assert.deepEqual(await repositories.branches(project), ['main']);
    await repositories.removeCheckout(project, directory);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
