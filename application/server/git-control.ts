import { timingSafeEqual } from 'node:crypto';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { Transform } from 'node:stream';

import { type Config, HTTPError, requireString } from './config';
import { type Connection, type Project, Repositories, type Workspace } from './git';
import { Jobs } from './jobs';
import { boundedHTTP } from './resources';
import { type RuntimeDriver } from './runtime';
import { type Entity, Store, hash, newID } from './store';

import type Koa from 'koa';

interface GitLease extends Entity {
  project: string;
  machine: string;
  digest: string;
}

/** Repository-scoped capabilities keep source credentials out of the IDE. */
export class GitControl {
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly repositories: Repositories,
    readonly driver: RuntimeDriver,
    readonly jobs: Jobs,
  ) {}

  async install(workspace: Workspace, project: Project): Promise<void> {
    if (this.config.localDemo && path.isAbsolute(project.url)) {
      return;
    }
    const lease = hash(`${workspace.machineId}:${project.id}`).slice(0, 32);
    const saved = this.store.secret(`git-lease:${lease}`) as { token: string } | undefined;
    const token = saved?.token || newID() + newID();
    this.store.secret(`git-lease:${lease}`, { token });
    this.store.put<GitLease>('git-lease', {
      id: lease,
      owner: workspace.owner,
      machine: String(workspace.machineId),
      project: project.id,
      digest: hash(token),
    });
    const origin = new URL(this.config.gitBridgeURL || this.config.publicURL);
    if (
      origin.username ||
      origin.password ||
      origin.search ||
      origin.hash ||
      !['http:', 'https:'].includes(origin.protocol) ||
      (!this.config.localDemo && origin.protocol !== 'https:')
    ) {
      throw new HTTPError(400, 'Git 凭据桥需要安全的控制面地址');
    }
    origin.pathname = `/git/${lease}.git`;
    await this.driver.helper(workspace, 'git', { action: 'configure', lease, token, url: origin.href });
  }

  async bridge(context: Koa.Context): Promise<void> {
    const match = /^\/git\/([a-f0-9]{32})\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/.exec(context.path);
    if (!match) {
      throw new HTTPError(404, 'Git 仓库不存在');
    }
    const lease = this.store.get<GitLease>('git-lease', match[1]);
    const credentials = /^Basic ([A-Za-z0-9+/=]+)$/.exec(context.get('Authorization'));
    const [user, ...password] = credentials ? Buffer.from(credentials[1], 'base64').toString().split(':') : [];
    if (
      !lease ||
      user !== lease.id ||
      !timingSafeEqual(Buffer.from(hash(password.join(':'))), Buffer.from(lease.digest))
    ) {
      context.set('WWW-Authenticate', 'Basic realm="WebIDE Git"');
      throw new HTTPError(401, 'Git 授权不可用，请重新启动工作区');
    }
    const machine = this.store.get('machine', lease.machine);
    const project = this.store.get<Project>('project', lease.project);
    if (machine?.owner !== lease.owner || project?.owner !== lease.owner) {
      throw new HTTPError(403, 'Git 授权已撤销');
    }
    const query = new URLSearchParams(context.querystring);
    const service = query.get('service');
    if (!(
      (context.method === 'GET' &&
        match[2] === 'info/refs' &&
        query.size === 1 &&
        ['git-upload-pack', 'git-receive-pack'].includes(service || '')) ||
      (context.method === 'POST' && match[2] !== 'info/refs' && !context.querystring)
    )) {
      throw new HTTPError(400, '不支持的 Git 请求');
    }
    const connection = this.repositories.connection(lease.owner, project);
    const target = this.repositories.credentialTarget(project, connection);
    target.pathname = target.pathname.replace(/\/$/, '') + '/' + match[2];
    target.search = context.querystring;
    const headers: Record<string, string> = {};
    for (const header of ['content-type', 'content-encoding', 'git-protocol']) {
      if (context.get(header)) {
        headers[header] = context.get(header);
      }
    }
    if (connection.token) {
      headers.Authorization =
        'Basic ' +
        Buffer.from(
          `${connection.provider === 'gitee' ? connection.account || 'oauth2' : 'oauth2'}:${connection.token}`,
        ).toString('base64');
    }
    context.respond = false;
    await new Promise<void>((resolve, reject) => {
      let bytes = 0;
      const limiter = new Transform({
        transform(chunk, _encoding, done) {
          bytes += chunk.length;
          done(bytes > 512 * 1024 * 1024 ? new Error('Git 请求超过 512 MiB') : null, chunk);
        },
      });
      const request = (target.protocol === 'https:' ? https : http).request(
        target,
        { method: context.method, headers, timeout: 600000, agent: false },
        (response) => {
          if (response.statusCode! >= 300 && response.statusCode! < 400) {
            response.destroy();
            request.destroy(new Error('代码源重定向被拒绝'));
            return;
          }
          context.res.statusCode = response.statusCode || 502;
          for (const header of ['content-type', 'cache-control', 'content-encoding']) {
            if (response.headers[header]) {
              context.res.setHeader(header, response.headers[header]!);
            }
          }
          response.once('error', reject);
          response.pipe(context.res);
          context.res.once('finish', resolve);
        },
      );
      limiter.once('error', (error) => request.destroy(error));
      request.once('error', () => {
        if (!context.res.headersSent) {
          context.res.statusCode = 502;
          context.res.end('Git 代码源请求失败');
          resolve();
        } else {
          context.res.destroy();
          reject(new Error('Git 代码源请求失败'));
        }
      });
      request.once('timeout', () => request.destroy(new Error('Git 请求超时')));
      context.req.once('aborted', () => request.destroy());
      context.res.once('close', () => {
        if (!context.res.writableFinished) {
          request.destroy();
        }
      });
      context.req.pipe(limiter).pipe(request);
    });
  }

  async publish(workspace: Workspace, project: Project, input: Record<string, unknown>) {
    return this.jobs.run([`workspace:${workspace.id}`, `machine:${workspace.machineId}`], async () => {
      if (
        workspace.status !== 'ready' ||
        !this.driver.exportBranch ||
        !(await this.driver.inspect(workspace)).ideReady
      ) {
        throw new HTTPError(409, '请先让 IDE 进入就绪状态');
      }
      const target = await this.repositories.validateBranch(
        input.targetBranch || workspace.baseBranch || project.branch,
      );
      if (target === workspace.branch) {
        throw new HTTPError(400, '请使用独立开发分支创建 MR/PR');
      }
      const title = requireString(input.title || `${workspace.branch} → ${target}`, 'MR/PR 标题', 255);
      if (!(await this.repositories.branches(project)).includes(target)) {
        throw new HTTPError(400, '目标分支不存在');
      }
      const directory = path.join(this.config.data, 'publish');
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const stage = await mkdtemp(path.join(directory, 'branch-'));
      const ref = `refs/workbench/publish/${workspace.id}`;
      let sha: string;
      try {
        const bundle = path.join(stage, 'branch.bundle');
        sha = await this.driver.exportBranch(workspace, bundle);
        if (!/^[a-f0-9]{40}$/.test(sha)) {
          throw new HTTPError(502, '发布提交无效');
        }
        await this.repositories.git(project, ['bundle', 'verify', bundle]);
        await this.repositories.git(project, ['fetch', '--no-tags', bundle, `+refs/heads/${workspace.branch}:${ref}`]);
        if ((await this.repositories.git(project, ['rev-parse', `${ref}^{commit}`])).trim() !== sha) {
          throw new HTTPError(409, '提交包与工作区 HEAD 不一致');
        }
        await this.repositories.git(project, ['push', 'origin', `${ref}:refs/heads/${workspace.branch}`]);
        workspace.publishedSha = sha;
        this.store.put('workspace', workspace);
      } finally {
        await this.repositories.git(project, ['update-ref', '-d', ref]).catch(() => undefined);
        await rm(stage, { recursive: true, force: true });
      }
      try {
        const url = await ensureMergeRequest(
          this.repositories.connection(workspace.owner, project),
          project,
          workspace.branch,
          target,
          title,
        );
        workspace.mergeRequestUrl = url;
        this.store.put('workspace', workspace);
        return { sha, mergeRequestUrl: url };
      } catch (error) {
        throw new HTTPError(502, `提交 ${sha.slice(0, 8)} 已推送；${(error as Error).message}，重试会复用现有 MR/PR`);
      }
    });
  }
}

/** Read-before-create plus a conflict re-read makes publish retries idempotent. */
export async function ensureMergeRequest(
  connection: Connection,
  project: Project,
  source: string,
  target: string,
  title: string,
): Promise<string> {
  if (!connection.token) {
    throw new Error('请配置具有 MR/PR 权限的代码源令牌');
  }
  const repository = new URL(project.url);
  const origin = new URL(connection.url);
  if (repository.origin !== origin.origin) {
    throw new HTTPError(400, '仓库与代码源地址不匹配');
  }
  const provider =
    connection.provider ||
    (repository.hostname === 'github.com' ? 'github' : /gitee/i.test(repository.hostname) ? 'gitee' : 'gitlab');
  const name = repository.pathname.slice(origin.pathname.replace(/\/$/, '').length).replace(/^\/+|\.git\/?$/g, '');
  const segments = name.split('/');
  if (segments.some((v) => !v || v === '.' || v === '..') || (provider !== 'gitlab' && segments.length !== 2)) {
    throw new HTTPError(400, '仓库路径无效');
  }
  const api =
    provider === 'github'
      ? repository.hostname === 'github.com'
        ? 'https://api.github.com'
        : origin.href.replace(/\/$/, '') + '/api/v3'
      : origin.href.replace(/\/$/, '') + `/api/${provider === 'gitee' ? 'v5' : 'v4'}`;
  const endpoint = new URL(
    provider === 'gitlab'
      ? `${api}/projects/${encodeURIComponent(name)}/merge_requests`
      : `${api}/repos/${segments.map(encodeURIComponent).join('/')}/pulls`,
  );
  const query = new URLSearchParams(
    provider === 'gitlab'
      ? { state: 'opened', source_branch: source, target_branch: target }
      : { state: 'open', head: provider === 'github' ? `${segments[0]}:${source}` : source, base: target },
  );
  query.set('per_page', '100');
  const headers: Record<string, string> =
    provider === 'gitlab'
      ? { 'PRIVATE-TOKEN': connection.token }
      : {
          Authorization: `${provider === 'gitee' ? 'token' : 'Bearer'} ${connection.token}`,
          Accept: 'application/vnd.github+json',
        };
  const find = async () => {
    const response = await boundedHTTP(new URL(endpoint.href + '?' + query), 'GET', headers);
    if (response.status !== 200) {
      throw new Error(`${provider} MR/PR 查询失败（HTTP ${response.status}）`);
    }
    const data = JSON.parse(response.body.toString());
    if (!Array.isArray(data)) {
      throw new Error('MR/PR 响应无效');
    }
    return data.find((item) =>
      provider === 'gitlab'
        ? item.source_branch === source && item.target_branch === target
        : item.head?.ref === source && item.base?.ref === target,
    )?.[provider === 'gitlab' ? 'web_url' : 'html_url'];
  };
  let url = await find();
  if (!url) {
    const payload =
      provider === 'gitlab'
        ? { source_branch: source, target_branch: target, title }
        : { head: source, base: target, title };
    const result = await boundedHTTP(
      endpoint,
      'POST',
      { ...headers, 'Content-Type': 'application/json' },
      JSON.stringify(payload),
    );
    if ([409, 422].includes(result.status)) {
      url = await find();
    } else if (result.status === 201) {
      url = JSON.parse(result.body.toString())[provider === 'gitlab' ? 'web_url' : 'html_url'];
    } else {
      throw new Error(`${provider} MR/PR 创建失败（HTTP ${result.status}）`);
    }
  }
  const address = new URL(String(url));
  if (
    !['http:', 'https:'].includes(address.protocol) ||
    address.username ||
    address.password ||
    address.origin !== repository.origin
  ) {
    throw new Error('MR/PR 地址无效');
  }
  return address.href;
}
