import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { type TestContext, test } from 'node:test';

import { UPSTREAM_BASELINE_FILE, checkUpstream, finishUpstream, prepareUpstream } from './sync-upstream';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1' },
  }).trim();
}

function write(root: string, file: string, value: string | Buffer): void {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, value);
}

function read(root: string, file: string): string {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function commit(root: string, message: string): string {
  git(root, 'add', '.');
  git(root, '-c', 'core.hooksPath=/dev/null', 'commit', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

function fixture(t: TestContext) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opensumi-upstream-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const official = path.join(directory, 'official');
  const fork = path.join(directory, 'fork');
  const destination = path.join(directory, 'prepared');
  for (const root of [official, fork]) {
    fs.mkdirSync(root);
    git(root, 'init', '--initial-branch=main');
    git(root, 'config', 'user.name', 'Upstream test');
    git(root, 'config', 'user.email', 'upstream@example.invalid');
    write(root, 'shared.txt', 'top\na\nb\nc\nd\ne\nf\nbottom\n');
    write(root, 'remove.txt', 'obsolete\n');
    write(root, 'rename old.txt', 'stable file content\n');
    write(root, 'binary.dat', Buffer.from([0, 1, 2, 3]));
  }
  const baseline = commit(official, 'official baseline');
  const initialImport = commit(fork, 'independent imported snapshot');
  const tree = git(official, 'rev-parse', 'HEAD^{tree}');
  assert.equal(git(fork, 'rev-parse', 'HEAD^{tree}'), tree);
  assert.notEqual(initialImport, baseline);
  git(fork, 'fetch', '--no-tags', official, 'main:refs/remotes/fixture/main');
  write(
    fork,
    UPSTREAM_BASELINE_FILE,
    JSON.stringify(
      {
        schemaVersion: 1,
        repository: official,
        branch: 'main',
        baseline: { commit: baseline, tree },
        initialImport: { commit: initialImport, tree },
      },
      null,
      2,
    ) + '\n',
  );
  write(fork, 'shared.txt', read(fork, 'shared.txt').replace('top', 'our Node24 integration'));
  write(fork, 'our-go-agent.txt', 'keep our implementation\n');
  const sourceHead = commit(fork, 'our changes and baseline');
  return { official, fork, destination, baseline, initialImport, sourceHead };
}

test('unchanged upstream leaves HEAD, index, dirty files and untracked files untouched', (t) => {
  const f = fixture(t);
  write(f.fork, 'shared.txt', 'uncommitted change\n');
  write(f.fork, 'scratch.txt', 'untracked\n');
  git(f.fork, 'add', 'our-go-agent.txt');
  const before = git(f.fork, 'status', '--porcelain=v1');
  assert.equal(checkUpstream(f.fork).status, 'current');
  assert.equal(git(f.fork, 'status', '--porcelain=v1'), before);
  assert.equal(git(f.fork, 'rev-parse', 'HEAD'), f.sourceHead);
  assert.equal(read(f.fork, 'shared.txt'), 'uncommitted change\n');
  assert.equal(read(f.fork, 'scratch.txt'), 'untracked\n');
  assert.throws(() => prepareUpstream(f.fork, f.destination), /Commit the current tracked changes/);
  assert.equal(fs.existsSync(f.destination), false);
});

test('three-way delta merges unrelated histories while retaining our edits, renames, deletes and binary changes', (t) => {
  const f = fixture(t);
  write(f.official, 'shared.txt', read(f.official, 'shared.txt').replace('bottom', 'official update'));
  fs.unlinkSync(path.join(f.official, 'remove.txt'));
  fs.renameSync(path.join(f.official, 'rename old.txt'), path.join(f.official, 'rename new.txt'));
  write(f.official, 'new file.txt', 'new upstream feature\n');
  write(f.official, 'binary.dat', Buffer.from([0, 7, 8, 9]));
  const target = commit(f.official, 'upstream update');
  write(f.fork, 'scratch.txt', 'untracked local work\n');
  const before = git(f.fork, 'status', '--porcelain=v1');
  const result = prepareUpstream(f.fork, f.destination);
  assert.equal(result.status, 'prepared');
  assert.equal(git(f.fork, 'rev-parse', 'HEAD'), f.sourceHead);
  assert.equal(git(f.fork, 'status', '--porcelain=v1'), before);
  assert.equal(read(f.fork, 'shared.txt').includes('official update'), false);
  assert.equal(read(f.destination, 'shared.txt'), 'our Node24 integration\na\nb\nc\nd\ne\nf\nofficial update\n');
  assert.equal(read(f.destination, 'our-go-agent.txt'), 'keep our implementation\n');
  assert.equal(fs.existsSync(path.join(f.destination, 'remove.txt')), false);
  assert.equal(fs.existsSync(path.join(f.destination, 'rename old.txt')), false);
  assert.equal(read(f.destination, 'rename new.txt'), 'stable file content\n');
  assert.equal(read(f.destination, 'new file.txt'), 'new upstream feature\n');
  assert.deepEqual(fs.readFileSync(path.join(f.destination, 'binary.dat')), Buffer.from([0, 7, 8, 9]));
  assert.equal(JSON.parse(read(f.destination, UPSTREAM_BASELINE_FILE)).baseline.commit, target);
  assert.equal(JSON.parse(read(f.fork, UPSTREAM_BASELINE_FILE)).baseline.commit, f.baseline);
  assert.match(git(f.destination, 'diff', '--cached', '--name-only'), /upstream-baseline.json/);
  assert.equal(git(f.destination, 'diff', '--name-only'), '');
  commit(f.destination, 'reviewed upstream sync');
  assert.equal(checkUpstream(f.destination).status, 'current');
});

test('conflicts preserve the original checkout and advance the baseline only after explicit resolution', (t) => {
  const f = fixture(t);
  write(f.official, 'shared.txt', read(f.official, 'shared.txt').replace('top', 'official top'));
  const target = commit(f.official, 'conflicting upstream update');
  const result = prepareUpstream(f.fork, f.destination);
  assert.equal(result.status, 'conflicts');
  assert.match(read(f.destination, 'shared.txt'), /<<<<<<< /);
  assert.equal(git(f.fork, 'status', '--porcelain=v1'), '');
  assert.equal(JSON.parse(read(f.destination, UPSTREAM_BASELINE_FILE)).baseline.commit, f.baseline);
  assert.throws(() => finishUpstream(f.destination), /Resolve and stage every upstream conflict/);
  write(f.destination, 'shared.txt', 'reviewed combination of our and official changes\n');
  git(f.destination, 'add', 'shared.txt');
  finishUpstream(f.destination);
  assert.equal(JSON.parse(read(f.destination, UPSTREAM_BASELINE_FILE)).baseline.commit, target);
  assert.equal(git(f.destination, 'ls-files', '-u'), '');
  assert.equal(read(f.fork, 'shared.txt').startsWith('our Node24 integration'), true);
});

test('same tree with new upstream history still advances its baseline in an isolated worktree', (t) => {
  const f = fixture(t);
  git(f.official, '-c', 'core.hooksPath=/dev/null', 'commit', '--allow-empty', '-m', 'metadata only');
  const target = git(f.official, 'rev-parse', 'HEAD');
  const result = prepareUpstream(f.fork, f.destination);
  assert.equal(result.status, 'prepared');
  assert.deepEqual(result.files, []);
  assert.equal(JSON.parse(read(f.destination, UPSTREAM_BASELINE_FILE)).baseline.commit, target);
  assert.equal(git(f.fork, 'rev-parse', 'HEAD'), f.sourceHead);
});

test('rejects a corrupt baseline and upstream history rewrite without creating a worktree', (t) => {
  const f = fixture(t);
  const manifest = JSON.parse(read(f.fork, UPSTREAM_BASELINE_FILE));
  write(
    f.fork,
    UPSTREAM_BASELINE_FILE,
    JSON.stringify({ ...manifest, baseline: { ...manifest.baseline, tree: '0'.repeat(40) } }),
  );
  assert.throws(() => checkUpstream(f.fork), /tree does not match/);
  write(f.fork, UPSTREAM_BASELINE_FILE, JSON.stringify(manifest, null, 2) + '\n');
  git(f.official, 'checkout', '--orphan', 'rewritten');
  commit(f.official, 'rewritten history');
  git(f.official, 'branch', '-f', 'main', 'HEAD');
  assert.throws(() => prepareUpstream(f.fork, f.destination), /no longer descends/);
  assert.equal(fs.existsSync(f.destination), false);
});
