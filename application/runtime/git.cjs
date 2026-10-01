'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const root = path.resolve(process.argv[2]);
const input = JSON.parse(
  process.argv[3]?.startsWith('@')
    ? fs.readFileSync(process.argv[3].slice(1), 'utf8')
    : Buffer.from(process.argv[3] || 'e30=', 'base64').toString(),
);
const project = path.join(root, 'project');
const git = (args) =>
  spawnSync('git', ['-C', project, ...args], {
    encoding: 'utf8',
    timeout: 110000,
    maxBuffer: 2 * 1024 * 1024,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
const value = (args) => {
  const r = git(args);
  if (r.status !== 0) throw new Error('无法读取 Git 工作区');
  return r.stdout.trim();
};
function status() {
  const state = value(['status', '--porcelain=v1', '--untracked-files=normal']);
  const gd = value(['rev-parse', '--absolute-git-dir']);
  return {
    branch: value(['branch', '--show-current']),
    sha: value(['rev-parse', 'HEAD']),
    dirty: !!state,
    files: state.split('\n').filter(Boolean).slice(0, 100),
    conflicts: value(['diff', '--name-only', '--diff-filter=U']).split('\n').filter(Boolean),
    operation:
      fs.existsSync(path.join(gd, 'rebase-merge')) || fs.existsSync(path.join(gd, 'rebase-apply'))
        ? 'rebase'
        : fs.existsSync(path.join(gd, 'MERGE_HEAD'))
          ? 'merge'
          : '',
    branches: value(['for-each-ref', '--format=%(refname:short)', 'refs/remotes/origin'])
      .split('\n')
      .filter(Boolean)
      .slice(0, 100),
  };
}
function run() {
  if (input.action === 'configure') {
    if (!/^[a-f0-9]{32}$/.test(input.lease) || !/^[a-f0-9]{64}$/.test(input.token)) throw new Error('Git 授权无效');
    const url = new URL(input.url);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
      throw new Error('Git 代理地址无效');
    const common = path.resolve(project, value(['rev-parse', '--git-common-dir']));
    const filename = path.join(common, 'clouddev-bridge.json');
    fs.writeFileSync(filename + '.tmp', JSON.stringify(input), { mode: 0o600 });
    fs.renameSync(filename + '.tmp', filename);
    value(['config', 'credential.useHttpPath', 'true']);
    value([
      'config',
      '--replace-all',
      'credential.helper',
      `!node '${path.join(__dirname, 'git-credential.cjs').replaceAll("'", "'\\''")}' '${filename.replaceAll("'", "'\\''")}'`,
    ]);
    value(['remote', 'set-url', 'origin', input.url]);
    return { configured: true };
  }
  const action = input.action || 'status';
  if (action === 'status') return status();
  if (action === 'export') {
    const branch = value(['branch', '--show-current']);
    if (branch !== input.branch || status().operation) throw new Error('请完成 Git 操作并切回工作区开发分支');
    const sha = value(['rev-parse', 'HEAD']);
    const directory = path.join(root, '.platform');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const bundle = path.join(directory, 'publish-' + randomBytes(16).toString('hex') + '.bundle');
    try {
      value(['bundle', 'create', bundle, 'refs/heads/' + branch]);
      fs.chmodSync(bundle, 0o600);
      if (fs.statSync(bundle).size > 512 * 1024 * 1024) throw new Error('提交包超过 512 MiB');
      return { sha, bundle };
    } catch (error) {
      fs.rmSync(bundle, { force: true });
      throw error;
    }
  }
  if (!['fetch', 'pull', 'merge', 'rebase', 'continue', 'abort'].includes(action)) throw new Error('未知 Git 操作');
  const before = status();
  const branch = input.branch || before.branch;
  if (!branch || branch.startsWith('-') || git(['check-ref-format', '--branch', branch]).status !== 0)
    throw new Error('请选择有效远端分支');
  if (['pull', 'merge', 'rebase'].includes(action) && (before.dirty || before.operation))
    throw new Error('请先提交或暂存修改，并处理当前合并/变基');
  let args;
  if (['fetch', 'pull', 'merge', 'rebase'].includes(action)) {
    const fetched = git(['fetch', '--prune', 'origin']);
    if (fetched.status !== 0) throw new Error('拉取失败，请检查代码源授权或网络后重试');
  }
  if (action === 'pull') args = ['merge', '--ff-only', 'origin/' + branch];
  if (action === 'merge') args = ['merge', '--no-edit', 'origin/' + branch];
  if (action === 'rebase') args = ['rebase', 'origin/' + branch];
  if (action === 'continue' || action === 'abort') {
    if (!before.operation) throw new Error('没有进行中的合并或变基');
    args =
      before.operation === 'merge' && action === 'continue'
        ? ['-c', 'core.editor=true', 'commit', '--no-edit']
        : ['-c', 'core.editor=true', before.operation, '--' + action];
  }
  const outcome = args ? git(args) : { status: 0 };
  return {
    ...status(),
    success: outcome.status === 0,
    message: outcome.status === 0 ? '同步完成' : 'Git 操作未完成；分支与冲突现场已保留，请查看冲突文件或选择合并/变基',
  };
}
try {
  process.stdout.write(JSON.stringify(run()));
} catch (e) {
  process.stdout.write(JSON.stringify({ error: e.message }));
  process.exitCode = 1;
}
