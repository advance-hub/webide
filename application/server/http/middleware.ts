import Koa from 'koa';

import { HTTPError } from '../platform/validation';

import { readJSONBody } from './json-body';

import type { RouteServices } from './context';

export function mountMiddleware(
  app: Koa,
  services: Pick<RouteServices, 'config' | 'gitControl' | 'access' | 'ide'>,
  closing: () => boolean,
): void {
  app.use(async (context, next) => {
    context.set('X-Content-Type-Options', 'nosniff');
    try {
      if (closing()) {
        throw new HTTPError(503, '服务正在关闭');
      }
      if (context.path.startsWith('/git/')) {
        await services.gitControl.bridge(context);
        return;
      }
      const workspaceId = services.ide.workspaceHost(context.req);
      if (workspaceId) {
        await services.ide.proxyIDE(context, workspaceId);
        return;
      }
      if (!['GET', 'HEAD', 'OPTIONS'].includes(context.method)) {
        const origin = context.get('Origin');
        if (
          origin &&
          origin !== new URL(services.config.publicURL).origin &&
          !((services.config.localDemo || process.env.WORKBENCH_DEV === '1') && origin === 'http://127.0.0.1:8792')
        ) {
          throw new HTTPError(403, '请求来源不匹配');
        }
        if (!context.is('application/json')) {
          throw new HTTPError(415, '需要 JSON 请求');
        }
        context.state.body = await readJSONBody(context.req);
      }
      if (context.path.startsWith('/api/') && !['/api/config', '/api/login'].includes(context.path)) {
        context.state.owner = services.access.owner(context);
      }
      await next();
    } catch (error) {
      context.status = error instanceof HTTPError ? error.status : 500;
      context.body = { error: (error as Error).message };
    }
  });
}
