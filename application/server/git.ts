import { execFile } from 'node:child_process';
import { chmod, mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { type Config, HTTPError, requireString, safeRelativePath } from './config';
import { type Entity, Store, now } from './store';

import type { Project as PublicProject, Workspace as PublicWorkspace } from '../src/domain';

const execute = promisify(execFile);
export type Project = PublicProject & Entity;
export type Workspace = PublicWorkspace & Entity;
export interface Connection {
  url: string;
  token?: string;
  provider?: 'gitlab' | 'gitee' | 'github';
  account?: string;
}

export async function command(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number } = {},
): Promise<string> {
  const { stdout } = await execute(file, args, {
    ...options,
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
  });
  return stdout;
}

export class Repositories {
  constructor(
    readonly config: Config,
    readonly store: Store,
  ) {}

  directory(project: Project): string {
    return path.join(this.config.data, 'repositories', `${project.id}.git`);
  }

  connection(owner: string, project?: Project): Connection {
    return ((project && this.store.secret(`project:${project.id}`)) ||
      this.store.secret(`connection:${owner}`) ||
      this.store.secret('connection:global') || { url: this.config.gitlabURL }) as Connection;
  }

  private async environment(project: Project): Promise<NodeJS.ProcessEnv> {
    const connection = this.connection(project.owner, project);
    if (connection.token) {
      this.credentialTarget(project, connection);
    }
    const askpass = path.join(import.meta.dirname, 'git-askpass.cjs');
    await chmod(askpass, 0o755);
    return {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: askpass,
      OPENSUMI_GIT_TOKEN: connection.token || '',
      OPENSUMI_GIT_USERNAME: connection.provider === 'gitee' ? connection.account || 'oauth2' : 'oauth2',
    };
  }

  credentialTarget(project: Project, connection: Connection): URL {
    const target = new URL(project.url);
    const source = new URL(connection.url);
    const prefix = source.pathname.replace(/\/$/, '');
    if (target.origin !== source.origin || (prefix && !target.pathname.startsWith(prefix + '/'))) {
      throw new HTTPError(400, '仓库与代码源凭据的地址不匹配');
    }
    return target;
  }

  async git(project: Project, args: string[], cwd?: string): Promise<string> {
    const env = await this.environment(project);
    try {
      return await command('git', cwd ? ['-C', cwd, ...args] : [`--git-dir=${this.directory(project)}`, ...args], {
        env,
      });
    } catch (error) {
      const message = (error as Error).message;
      throw new Error(env.OPENSUMI_GIT_TOKEN ? message.split(env.OPENSUMI_GIT_TOKEN).join('[redacted]') : message, {
        cause: error,
      });
    }
  }

  validateURL(value: unknown): string {
    const input = requireString(value, '仓库地址', 2000);
    // Local Git fixtures and developer-owned repositories are available only in loopback demo mode.
    if (this.config.localDemo && path.isAbsolute(input)) {
      return input;
    }
    let url: URL;
    try {
      url = new URL(input);
    } catch {
      throw new HTTPError(400, '请输入 HTTP(S) 仓库地址');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new HTTPError(400, '仓库地址不能携带凭据或查询参数');
    }
    if (url.protocol === 'http:' && !this.config.localDemo && process.env.GITLAB_ALLOW_HTTP !== '1') {
      throw new HTTPError(400, '代码源需要 HTTPS');
    }
    return url.href;
  }

  async validateBranch(branch: unknown): Promise<string> {
    const value = requireString(branch, '分支', 200);
    if (value.startsWith('-')) {
      throw new HTTPError(400, '分支无效');
    }
    try {
      await command('git', ['check-ref-format', '--branch', value]);
    } catch {
      throw new HTTPError(400, '分支名称无效');
    }
    return value;
  }

  async import(project: Project): Promise<void> {
    const target = this.directory(project);
    const temporary = `${target}.preparing`;
    await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
    await rm(temporary, { recursive: true, force: true });
    try {
      await command('git', ['clone', '--bare', '--', project.url, temporary], { env: await this.environment(project) });
      const sha = (
        await command('git', [`--git-dir=${temporary}`, 'rev-parse', `refs/heads/${project.branch}^{commit}`])
      ).trim();
      await rename(temporary, target);
      project.sha = sha;
      await this.pin(project, project.branch, sha);
      project.status = 'ready';
      project.error = undefined;
      this.store.put('project', project);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  async fetch(project: Project, branch: string): Promise<string> {
    await this.git(project, ['fetch', '--no-tags', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`]);
    return (await this.git(project, ['rev-parse', `refs/remotes/origin/${branch}^{commit}`])).trim();
  }

  async pin(project: Project, branch: string, sha: string): Promise<void> {
    const directory = path.join(this.config.data, 'baselines', project.id);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await this.git(project, ['update-ref', `refs/opensumi/baselines/${sha}`, sha]);
    await this.git(project, [
      'bundle',
      'create',
      path.join(directory, `${sha}.bundle`),
      `refs/opensumi/baselines/${sha}`,
    ]);
    project.sha = sha;
    project.branch = branch;
    project.baselineHistory = [
      { branch, sha, at: now() },
      ...(project.baselineHistory || []).filter((v) => v.sha !== sha),
    ].slice(0, 20);
  }

  async checkout(project: Project, workspace: Workspace, directory: string): Promise<void> {
    const sha = await this.pinWorkspace(project, workspace);
    await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    await this.git(project, ['worktree', 'add', '--detach', '--', directory, sha]);
    await this.git(project, ['switch', '-C', workspace.branch], directory);
    await this.git(project, ['config', 'remote.origin.url', project.url], directory);
  }

  async pinWorkspace(project: Project, workspace: Workspace): Promise<string> {
    if (typeof workspace.baselineSha === 'string' && /^[a-f0-9]{40}$/.test(workspace.baselineSha)) {
      return workspace.baselineSha;
    }
    const base = workspace.baseBranch || workspace.branch;
    const sha = await this.fetch(project, base);
    await mkdir(path.dirname(this.bundle(project, sha)), { recursive: true, mode: 0o700 });
    await this.git(project, ['update-ref', `refs/opensumi/baselines/${sha}`, sha]);
    await this.git(project, ['bundle', 'create', this.bundle(project, sha), `refs/opensumi/baselines/${sha}`]);
    workspace.sha = sha;
    workspace.baselineSha = sha;
    workspace.baselineBranch = base;
    this.store.put('workspace', workspace);
    return sha;
  }

  bundle(project: Project, sha: string): string {
    if (!/^[a-f0-9]{40}$/.test(sha)) {
      throw new HTTPError(400, '基线提交无效');
    }
    return path.join(this.config.data, 'baselines', project.id, `${sha}.bundle`);
  }

  async removeCheckout(project: Project, directory: string): Promise<void> {
    await this.git(project, ['worktree', 'remove', '--force', '--', directory]);
    await this.git(project, ['worktree', 'prune']);
  }

  async branches(project: Project): Promise<string[]> {
    const output = await this.git(project, ['ls-remote', '--heads', 'origin']);
    return output
      .trim()
      .split('\n')
      .filter(Boolean)
      .slice(0, 1000)
      .map((line) => line.split('\t')[1].replace('refs/heads/', ''));
  }

  async browse(project: Project, input: string): Promise<Record<string, unknown>> {
    const relative = safeRelativePath(input);
    const object = relative ? `${project.sha}:${relative}` : project.sha;
    const kind = relative ? (await this.git(project, ['cat-file', '-t', object])).trim() : 'tree';
    if (kind === 'tree') {
      const rows = (await this.git(project, ['ls-tree', '-l', '-z', object])).split('\0').filter(Boolean);
      return {
        kind: 'directory',
        path: relative,
        truncated: rows.length > 1000,
        entries: rows.slice(0, 1000).map((row) => {
          const [metadata, name] = row.split('\t');
          const [, type, , size] = metadata.trim().split(/\s+/);
          return {
            name,
            path: relative ? `${relative}/${name}` : name,
            kind: type === 'tree' ? 'directory' : 'file',
            size: Number(size) || 0,
          };
        }),
      };
    }
    const size = Number((await this.git(project, ['cat-file', '-s', object])).trim());
    if (size > 256 * 1024) {
      return { kind: 'file', path: relative, size, truncated: true, preview: '文件超过 256 KiB，请在 IDE 中打开' };
    }
    const content = await this.git(project, ['show', object]);
    return {
      kind: 'file',
      path: relative,
      size,
      content: content.includes('\0') ? '二进制文件，请在 IDE 中打开' : content.split('\n').slice(0, 2000).join('\n'),
      truncated: content.split('\n').length > 2000,
    };
  }

  async commits(project: Project): Promise<Record<string, unknown>> {
    const output = await this.git(project, ['log', '-20', '--format=%H%x09%an%x09%aI%x09%s', project.sha]);
    return {
      kind: 'commits',
      path: '',
      commits: output
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((row) => {
          const [sha, author, date, ...subject] = row.split('\t');
          return { sha, author, date, subject: subject.join('\t') };
        }),
    };
  }
}
