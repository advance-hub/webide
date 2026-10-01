import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const UPSTREAM_BASELINE_FILE = 'upstream-baseline.json';
const PENDING_FILE = 'opensumi-upstream-sync.json';

interface Revision {
  commit: string;
  tree: string;
}

export interface UpstreamBaseline {
  schemaVersion: 1;
  repository: string;
  branch: string;
  baseline: Revision;
  initialImport: Revision;
}

interface PendingSync {
  state: 'applying' | 'applied' | 'conflicts';
  sourceHead: string;
  baseline: UpstreamBaseline;
  target: Revision;
}

export interface UpstreamSyncResult {
  status: 'current' | 'available' | 'prepared' | 'conflicts';
  baseline: string;
  target: string;
  files: string[];
  worktree?: string;
  branch?: string;
}

function git(root: string, args: string[], input?: Buffer) {
  const result = spawnSync('git', ['-C', root, ...args], {
    input,
    encoding: 'buffer',
    maxBuffer: 128 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

function checkedGit(root: string, args: string[], input?: Buffer): Buffer {
  const result = git(root, args, input);
  if (result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.stderr.toString().trim()}`);
  }
  return result.stdout;
}

function revision(root: string, ref: string): Revision {
  return {
    commit: checkedGit(root, ['rev-parse', '--verify', `${ref}^{commit}`])
      .toString()
      .trim(),
    tree: checkedGit(root, ['rev-parse', '--verify', `${ref}^{tree}`])
      .toString()
      .trim(),
  };
}

function assertRevision(root: string, value: Revision): void {
  if (!value || !/^[a-f0-9]{40}$/.test(value.commit) || !/^[a-f0-9]{40}$/.test(value.tree)) {
    throw new Error('Invalid upstream baseline revision');
  }
  if (revision(root, value.commit).tree !== value.tree) {
    throw new Error(`Upstream baseline tree does not match commit ${value.commit}`);
  }
}

function readBaseline(root: string): UpstreamBaseline {
  const manifest: UpstreamBaseline = JSON.parse(fs.readFileSync(path.join(root, UPSTREAM_BASELINE_FILE), 'utf8'));
  if (
    manifest.schemaVersion !== 1 ||
    typeof manifest.repository !== 'string' ||
    !manifest.repository ||
    manifest.repository.startsWith('-') ||
    typeof manifest.branch !== 'string'
  ) {
    throw new Error('Invalid upstream baseline manifest');
  }
  checkedGit(root, ['check-ref-format', `refs/heads/${manifest.branch}`]);
  assertRevision(root, manifest.baseline);
  assertRevision(root, manifest.initialImport);
  if (git(root, ['merge-base', '--is-ancestor', manifest.initialImport.commit, 'HEAD']).status !== 0) {
    throw new Error('The current branch does not contain the recorded initial import');
  }
  return manifest;
}

function pendingPath(root: string): string {
  return path.resolve(root, checkedGit(root, ['rev-parse', '--git-path', PENDING_FILE]).toString().trim());
}

function assertCleanTrackedFiles(root: string): void {
  if (checkedGit(root, ['status', '--porcelain=v1', '--untracked-files=no']).length > 0) {
    throw new Error('Commit the current tracked changes before preparing an upstream worktree; check is read-only');
  }
}

function changedFiles(root: string, from: string, to: string): string[] {
  return checkedGit(root, ['diff', '--name-only', '-z', from, to]).toString().split('\0').filter(Boolean);
}

/** Fetches official objects without changing HEAD, the index, or working files. */
export function checkUpstream(root: string): UpstreamSyncResult {
  const manifest = readBaseline(root);
  const ref = `refs/remotes/opensumi-sync/${manifest.branch}`;
  checkedGit(root, ['fetch', '--no-tags', manifest.repository, `+refs/heads/${manifest.branch}:${ref}`]);
  const target = revision(root, ref);
  // An upstream rewrite needs a new baseline decision, not a blind unrelated-history merge.
  if (git(root, ['merge-base', '--is-ancestor', manifest.baseline.commit, target.commit]).status !== 0) {
    throw new Error(
      'Upstream history no longer descends from the recorded baseline; review the baseline before syncing',
    );
  }
  return {
    status: target.commit === manifest.baseline.commit ? 'current' : 'available',
    baseline: manifest.baseline.commit,
    target: target.commit,
    files: changedFiles(root, manifest.baseline.commit, target.commit),
  };
}

/** Applies only the upstream delta to a new branch/worktree based on our exact HEAD. */
export function prepareUpstream(root: string, worktree: string, branch?: string): UpstreamSyncResult {
  assertCleanTrackedFiles(root);
  const sourceHead = revision(root, 'HEAD').commit;
  const manifest = readBaseline(root);
  const result = checkUpstream(root);
  if (result.status === 'current') {
    return result;
  }
  assertCleanTrackedFiles(root);
  if (revision(root, 'HEAD').commit !== sourceHead) {
    throw new Error('HEAD changed while fetching upstream; retry from the intended branch');
  }
  const destination = path.resolve(worktree);
  if (fs.existsSync(destination)) {
    throw new Error(`Upstream worktree destination already exists: ${destination}`);
  }
  const branchName = branch || `codex/upstream-${result.target.slice(0, 12)}`;
  checkedGit(root, ['check-ref-format', `refs/heads/${branchName}`]);
  if (git(root, ['show-ref', '--verify', '--quiet', `refs/heads/${branchName}`]).status === 0) {
    throw new Error(`Branch already exists: ${branchName}`);
  }
  if (result.files.includes(UPSTREAM_BASELINE_FILE)) {
    throw new Error(`Upstream now owns ${UPSTREAM_BASELINE_FILE}; review the metadata path before syncing`);
  }
  const patch = checkedGit(root, [
    'diff',
    '--binary',
    '--full-index',
    '--find-renames',
    manifest.baseline.commit,
    result.target,
  ]);
  checkedGit(root, ['worktree', 'add', '-b', branchName, destination, sourceHead]);
  const pending: PendingSync = {
    state: 'applying',
    sourceHead,
    baseline: manifest,
    target: revision(root, result.target),
  };
  const savePending = () => fs.writeFileSync(pendingPath(destination), `${JSON.stringify(pending, null, 2)}\n`);
  savePending();
  if (patch.length > 0) {
    const applied = git(destination, ['apply', '--3way', '--index'], patch);
    if (applied.status !== 0) {
      if (checkedGit(destination, ['ls-files', '-u']).length > 0 && !/^error:/m.test(applied.stderr.toString())) {
        pending.state = 'conflicts';
        savePending();
        return { ...result, status: 'conflicts', worktree: destination, branch: branchName };
      }
      throw new Error(
        `Upstream patch failed in ${destination}; the original checkout is unchanged. ${applied.stderr.toString().trim()}`,
      );
    }
  }
  pending.state = 'applied';
  savePending();
  finishUpstream(destination);
  return { ...result, status: 'prepared', worktree: destination, branch: branchName };
}

/** Run after resolving and staging conflicts, before committing the prepared change. */
export function finishUpstream(root: string): void {
  const statePath = pendingPath(root);
  const pending: PendingSync = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (!['applied', 'conflicts'].includes(pending.state)) {
    throw new Error(
      'Upstream patch did not finish applying; inspect the failed preparation before advancing the baseline',
    );
  }
  assertRevision(root, pending.target);
  if (revision(root, 'HEAD').commit !== pending.sourceHead) {
    throw new Error('Prepared HEAD changed; finish upstream resolution before committing');
  }
  if (checkedGit(root, ['ls-files', '-u']).length > 0) {
    throw new Error('Resolve and stage every upstream conflict before finishing');
  }
  if (git(root, ['diff', '--quiet']).status !== 0) {
    throw new Error('Stage resolved working files before finishing upstream sync');
  }
  const manifest = readBaseline(root);
  if (JSON.stringify(manifest) !== JSON.stringify(pending.baseline)) {
    throw new Error('The upstream baseline changed during preparation');
  }
  fs.writeFileSync(
    path.join(root, UPSTREAM_BASELINE_FILE),
    `${JSON.stringify({ ...manifest, baseline: pending.target }, null, 2)}\n`,
  );
  checkedGit(root, ['add', '--', UPSTREAM_BASELINE_FILE]);
  fs.unlinkSync(statePath);
}

export function runUpstreamCli(args = process.argv.slice(2)): number {
  const [command = 'check', ...options] = args;
  const root = checkedGit(process.cwd(), ['rev-parse', '--show-toplevel']).toString().trim();
  if (command === 'finish' && options.length === 0) {
    finishUpstream(root);
    console.log('Upstream conflicts resolved; baseline staged. Review, test and commit this worktree.');
    return 0;
  }
  if (command !== 'check' && command !== 'prepare') {
    throw new Error('Usage: sync-upstream.ts check | prepare --worktree PATH [--branch NAME] | finish');
  }
  const parsed = new Map<string, string>();
  for (let index = 0; index < options.length; index += 2) {
    if (!['--worktree', '--branch'].includes(options[index]) || !options[index + 1] || parsed.has(options[index])) {
      throw new Error('Expected --worktree PATH and optional --branch NAME');
    }
    parsed.set(options[index], options[index + 1]);
  }
  if (command === 'check' && parsed.size > 0) {
    throw new Error('check does not accept worktree or branch options');
  }
  if (command === 'prepare' && !parsed.has('--worktree')) {
    throw new Error('prepare requires --worktree PATH');
  }
  const result =
    command === 'check'
      ? checkUpstream(root)
      : prepareUpstream(root, parsed.get('--worktree')!, parsed.get('--branch'));
  console.log(JSON.stringify(result, null, 2));
  if (result.status === 'conflicts') {
    console.log('Resolve and stage conflicts in the new worktree, then run pnpm upstream:finish there.');
    return 2;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = runUpstreamCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
