import path from 'node:path';

import { type Connection, type Project } from '../../domain/models';
import { newID, now, publicEntity } from '../../platform/store';
import { HTTPError, requireString } from '../../platform/validation';

import type { APIRouter, RouteServices } from '../context';

export function mountProjectsRoutes(
  router: APIRouter,
  services: Pick<RouteServices, 'access' | 'jobs' | 'repositories' | 'store' | 'workspaces'>,
): void {
  router.get('/api/projects', (context) => {
    context.body = services.store.list<Project>('project', context.state.owner).map(publicEntity);
  });
  router.post('/api/projects', async (context) => {
    const body = context.state.body;
    const project: Project = {
      id: newID(),
      owner: context.state.owner,
      name: requireString(body.name || path.basename(String(body.url)).replace(/\.git$/, ''), '项目名', 120),
      url: services.repositories.validateURL(body.url),
      branch: await services.repositories.validateBranch(body.branch || 'main'),
      sha: '',
      status: 'queued',
      createdAt: now(),
    };
    if (body.connection) {
      const connection = body.connection as Connection;
      await services.access.verifyConnection(connection);
      services.store.secret(`project:${project.id}`, connection);
    }
    services.store.put('project', project);
    services.workspaces.importProject(project);
    context.status = 202;
    context.body = publicEntity(project);
  });
  router.get('/api/projects/:id/branches', async (context) => {
    const branches = await services.repositories.branches(
      services.access.project(String(context.params.id), context.state.owner),
    );
    context.body = { branches, truncated: branches.length >= 1000 };
  });
  router.get('/api/projects/:id/repository', async (context) => {
    context.body = await services.repositories.browse(
      services.access.project(String(context.params.id), context.state.owner),
      String(context.query.path || ''),
    );
  });
  router.get('/api/projects/:id/commits', async (context) => {
    context.body = await services.repositories.commits(
      services.access.project(String(context.params.id), context.state.owner),
    );
  });
  router.post('/api/projects/:id/retry', (context) => {
    const project = services.access.project(String(context.params.id), context.state.owner);
    services.workspaces.importProject(project);
    context.status = 202;
    context.body = publicEntity(project);
  });
  router.post('/api/projects/:id/baseline', async (context) => {
    const project = services.access.project(String(context.params.id), context.state.owner);
    const body = context.state.body;
    if (body.expectedSha !== project.sha) {
      throw new HTTPError(409, '基线已更新，请刷新页面');
    }
    const branch = await services.repositories.validateBranch(body.branch || project.branch);
    if (body.sha && !/^[a-f0-9]{40}$/.test(String(body.sha))) {
      throw new HTTPError(400, '需要完整提交 SHA');
    }
    services.jobs.enqueue(
      `project:${project.id}`,
      'heavy',
      async () => {
        const latest = await services.repositories.fetch(project, branch);
        const sha = String(body.sha || latest);
        await services.repositories.git(project, ['cat-file', '-e', `${sha}^{commit}`]);
        await services.repositories.pin(project, branch, sha);
        project.baselineStatus = 'ready';
        project.baselineError = undefined;
        project.baselineUpdatedAt = now();
        services.store.put('project', project);
      },
      (error) => {
        project.baselineStatus = 'failed';
        project.baselineError = error.message;
        services.store.put('project', project);
      },
    );
    project.baselineStatus = 'queued';
    services.store.put('project', project);
    context.status = 202;
    context.body = publicEntity(project);
  });
}
