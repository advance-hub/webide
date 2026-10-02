import { type Connection } from '../../domain/models';
import { HTTPError, requireString } from '../../platform/validation';

import type { APIRouter, RouteServices } from '../context';

export function mountGitConnectionsRoutes(
  router: APIRouter,
  services: Pick<RouteServices, 'access' | 'repositories' | 'store'>,
): void {
  router.get('/api/connections/gitlab', (context) => {
    const project = context.query.projectId
      ? services.access.project(String(context.query.projectId), context.state.owner)
      : undefined;
    const connection = services.repositories.connection(context.state.owner, project);
    context.body = {
      url: connection.url,
      configured: !!connection.token,
      account: context.state.owner,
      provider: connection.provider,
      gitAccount: connection.account,
      inherited: !!project && !services.store.secret(`project:${project.id}`),
      canManage: !!project || services.access.isAdmin(context.state.owner),
    };
  });
  router.post('/api/connections/gitlab', async (context) => {
    const project = context.query.projectId
      ? services.access.project(String(context.query.projectId), context.state.owner)
      : undefined;
    const body = context.state.body;
    if (!project) {
      services.access.admin(context);
    }
    if (project && body.inherit) {
      services.store.db.prepare('DELETE FROM credentials WHERE owner=?').run(`project:${project.id}`);
      context.body = { ok: true };
      return;
    }
    const url = requireString(body.url, '代码源地址', 2000);
    const previous = services.repositories.connection(context.state.owner, project);
    const token =
      typeof body.token === 'string' && body.token ? body.token : previous.url === url ? previous.token : undefined;
    if (!token) {
      throw new HTTPError(400, '请填写代码源令牌');
    }
    const providerValue = body.provider || (previous.url === url ? previous.provider : undefined);
    if (
      providerValue &&
      (typeof providerValue !== 'string' || !['gitlab', 'github', 'gitee'].includes(providerValue))
    ) {
      throw new HTTPError(400, '代码源类型无效');
    }
    const provider = providerValue as Connection['provider'];
    const connection: Connection = {
      url,
      token,
      provider,
      account:
        typeof body.account === 'string'
          ? requireString(body.account, 'Git 账户', 200)
          : previous.url === url
            ? previous.account
            : undefined,
    };
    await services.access.verifyConnection(connection);
    services.store.secret(project ? `project:${project.id}` : 'connection:global', connection);
    context.body = { ok: true };
  });
}
