import { createReadStream } from 'node:fs';
import path from 'node:path';

import Router from '@koa/router';
import Koa from 'koa';
import serve from 'koa-static';

import { mountMiddleware } from './middleware';
import { backupRoutes } from './routes/backups';
import { mountGitConnectionsRoutes } from './routes/git-connections';
import { mountMachinesRoutes } from './routes/machines';
import { mavenRoutes } from './routes/maven';
import { mountProjectsRoutes } from './routes/projects';
import { resourceRoutes } from './routes/resources';
import { sandboxRoutes } from './routes/sandboxes';
import { mountSystemRoutes } from './routes/system';
import { mountWorkspacesRoutes } from './routes/workspaces';

import type { RouteServices } from './context';

export function createHTTPApp(services: RouteServices, closing: () => boolean): Koa {
  const app = new Koa();
  const router = new Router<{ owner: string; body: Record<string, unknown> }>();
  mountMiddleware(app, services, closing);
  mountSystemRoutes(router, services);
  mountGitConnectionsRoutes(router, services);
  mountProjectsRoutes(router, services);
  mountWorkspacesRoutes(router, services);
  mountMachinesRoutes(router, services);
  sandboxRoutes(router, services.sandbox, services.store, (context) => services.access.admin(context));
  resourceRoutes(router, services.resources);
  backupRoutes(router, services.machines);
  mavenRoutes(router, services.store, services.driver, services.jobs, (id, owner) =>
    services.access.workspace(id, owner),
  );
  app.use(router.routes()).use(router.allowedMethods());
  app.use(serve(path.join(services.config.root, 'application/dist')));
  app.use((context, next) => {
    if (
      ['GET', 'HEAD'].includes(context.method) &&
      /^\/(?:dashboard|images|development-resources|projects(?:\/[a-f0-9]{32})?|workspaces|environment|sandbox-admin|connection|import)\/?$/.test(
        context.path,
      )
    ) {
      context.type = 'html';
      context.body = createReadStream(path.join(services.config.root, 'application/dist/index.html'));
      return;
    }
    return next();
  });
  app.use((context) => {
    context.status = 404;
    context.body = { error: '接口或资源不存在' };
  });
  return app;
}
