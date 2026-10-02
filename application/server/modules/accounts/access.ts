import Koa from 'koa';

import { type Connection, type Project, type Workspace } from '../../domain/models';
import { type Config } from '../../platform/config';
import { Store } from '../../platform/store';
import { HTTPError, requireString } from '../../platform/validation';

/** 统一校验账户、项目和工作区归属，错误响应不泄露其他账户记录。 */
export class AccessControl {
  constructor(
    readonly config: Config,
    readonly store: Store,
  ) {}
  owner(context: Koa.Context): string {
    if (this.config.localDemo) {
      return 'local-developer';
    }
    const owner = this.store.session(context.cookies.get('workbench_session') || '');
    if (!owner) {
      throw new HTTPError(401, '请先登录工作台');
    }
    return owner;
  }

  project(id: string, owner: string): Project {
    const project = this.store.get<Project>('project', id);
    if (!project || project.owner !== owner) {
      throw new HTTPError(404, '项目不存在');
    }
    return project;
  }
  workspace(id: string, owner: string): Workspace {
    const workspace = this.store.get<Workspace>('workspace', id);
    if (!workspace || workspace.owner !== owner) {
      throw new HTTPError(404, '工作区不存在');
    }
    return workspace;
  }

  isAdmin(owner: string): boolean {
    return this.config.localDemo || this.config.adminUsers.includes(owner);
  }

  admin(context: Koa.Context): void {
    if (!this.isAdmin(context.state.owner)) {
      throw new HTTPError(403, '需要工作台管理员权限');
    }
  }

  async verifyConnection(connection: Connection): Promise<{ id: string; name: string }> {
    const url = new URL(requireString(connection.url, '代码源地址', 2000));
    if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) {
      throw new HTTPError(400, '代码源地址无效');
    }
    if (url.protocol === 'http:' && !this.config.localDemo && process.env.GITLAB_ALLOW_HTTP !== '1') {
      throw new HTTPError(400, '代码源需要 HTTPS');
    }
    const provider =
      connection.provider || (/gitee/i.test(url.host) ? 'gitee' : url.hostname === 'github.com' ? 'github' : 'gitlab');
    if (!['gitlab', 'github', 'gitee'].includes(provider)) {
      throw new HTTPError(400, '代码源类型无效');
    }
    const endpoint =
      provider === 'github'
        ? url.hostname === 'github.com'
          ? 'https://api.github.com/user'
          : `${url.href.replace(/\/$/, '')}/api/v3/user`
        : `${url.href.replace(/\/$/, '')}/api/${provider === 'gitee' ? 'v5' : 'v4'}/user`;
    const headers: Record<string, string> =
      provider === 'gitlab'
        ? { 'PRIVATE-TOKEN': connection.token || '' }
        : { Authorization: `Bearer ${connection.token || ''}` };
    const response = await fetch(endpoint, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      throw new HTTPError(400, `代码源验证失败 (${response.status})`);
    }
    const user = (await response.json()) as { id: string; name?: string; username?: string; login?: string };
    return { id: String(user.id), name: user.name || user.username || user.login || String(user.id) };
  }
}
