import { type Workspace } from '../../domain/models';
import { type Machine, startupRecord } from '../../domain/runtime';
import { newID, now, publicEntity } from '../../platform/store';
import { HTTPError } from '../../platform/validation';

import type { APIRouter, RouteServices } from '../context';

export function mountWorkspacesRoutes(
  router: APIRouter,
  services: Pick<
    RouteServices,
    | 'access'
    | 'config'
    | 'driver'
    | 'gitControl'
    | 'ide'
    | 'jobs'
    | 'machines'
    | 'repositories'
    | 'resources'
    | 'store'
    | 'sharing'
    | 'workspaces'
  >,
): void {
  router.get('/api/workspaces', (context) => {
    context.body = services.sharing
      .visible(context.state.owner)
      .map((w) => services.sharing.describe(w, context.state.owner));
  });
  router.post('/api/workspaces', async (context) => {
    const body = context.state.body;
    const project = services.access.project(String(body.projectId), context.state.owner);
    if (project.status !== 'ready') {
      throw new HTTPError(409, '项目还未导入完成');
    }
    const branch = await services.repositories.validateBranch(body.branch || project.branch);
    const existing = services.store
      .list<Workspace>('workspace', context.state.owner)
      .find((w) => w.projectId === project.id && w.branch === branch && !w.archived);
    if (existing) {
      context.body = publicEntity(existing);
      return;
    }
    const baseBranch = body.baseBranch ? await services.repositories.validateBranch(body.baseBranch) : undefined;
    const workspace = services.store.transaction(() => {
      let machine = services.store.list<Machine>('machine', context.state.owner)[0];
      if (!machine) {
        if (services.store.list('machine').length >= services.config.machineLimit) {
          throw new HTTPError(409, '个人开发机配额已满');
        }
        machine = services.store.put<Machine>('machine', {
          id: newID(),
          owner: context.state.owner,
          driver: services.driver.name,
          createdAt: now(),
        });
      }
      const occupied = new Set(
        services.store
          .list<Workspace>('workspace')
          .filter((item) => item.machineId === machine.id)
          .map((item) => item.idePort),
      );
      let idePort = 12000;
      while (occupied.has(idePort)) {
        idePort++;
      }
      if (idePort > 12999) {
        throw new HTTPError(409, '开发机工作区端口已满');
      }
      return services.store.put<Workspace>('workspace', {
        id: newID(),
        owner: context.state.owner,
        projectId: project.id,
        branch,
        baseBranch,
        machineId: machine.id,
        idePort,
        driver: services.driver.name,
        status: 'queued',
        createdAt: now(),
        updatedAt: now(),
      });
    });
    services.workspaces.lifecycle(workspace, 'start');
    context.status = 202;
    context.body = publicEntity(workspace);
  });
  router.get('/api/workspaces/:id/environment', async (context) => {
    const workspace = services.access.sharedWorkspace(String(context.params.id), context.state.owner);
    const { headers: _headers, ...environment } = await services.driver.inspect(workspace);
    context.body = { ...environment, workspace: services.sharing.describe(workspace, context.state.owner) };
  });
  router.post('/api/workspaces/:id/enter', async (context) => {
    const workspace = services.access.sharedWorkspace(String(context.params.id), context.state.owner);
    if (workspace.status !== 'ready' || !(await services.driver.inspect(workspace)).ideReady) {
      throw new HTTPError(409, 'IDE 未就绪，请启动或重启工作区');
    }
    context.body = { url: services.ide.enter(workspace, context.state.owner) };
  });
  router.post('/api/workspaces/:id/members', async (context) => {
    const id = String(context.params.id);
    const existing = services.access.workspace(id, context.state.owner);
    context.body = await services.jobs.run([`workspace:${id}`, `machine:${existing.machineId}`], async () => {
      const change = services.sharing.change(id, context.state.owner, context.state.body);
      // 首次共享前清除自动预置的账户数据连接；辅助命令失败时不授予访问权。
      if (change.removed) {
        services.store.put('workspace', change.workspace);
        services.ide.revoke(id, change.member);
      }
      if (change.workspace.status === 'ready') {
        try {
          await services.resources.sync(change.workspace, services.driver);
        } catch (error) {
          if (!change.removed) {
            throw error;
          }
          // 撤权已经完成，不能因恢复私人配置失败而把移除报告成失败。
          startupRecord(change.workspace).editorConnections = {
            mysql: false,
            redis: false,
            additionalDatabases: 0,
            error: '成员已移除，编辑器数据连接恢复失败，请重试同步配置',
          };
        }
      }
      services.store.put('workspace', change.workspace);
      return services.sharing.describe(change.workspace, context.state.owner);
    });
  });
  for (const action of ['start', 'stop', 'restart', 'reset', 'delete', 'update-runtime']) {
    router.post(`/api/workspaces/:id/${action}`, (context) => {
      const workspace = services.access.workspace(String(context.params.id), context.state.owner);
      if (
        action === 'reset' &&
        context.state.body.branch !== workspace.branch &&
        context.state.body.confirm !== workspace.branch
      ) {
        throw new HTTPError(400, '请确认工作区分支名');
      }
      if (action === 'update-runtime') {
        services.machines.enqueue(services.machines.machine(workspace.owner), 'upgrade');
        context.status = 202;
        context.body = { ...publicEntity(workspace), status: 'updating' };
        return;
      }
      services.workspaces.lifecycle(workspace, action);
      context.status = 202;
      context.body = publicEntity(workspace);
    });
  }
  router.post('/api/workspaces/:id/git', async (context) => {
    const workspace = services.access.workspace(String(context.params.id), context.state.owner);
    services.machines.assertAvailable(services.machines.machine(workspace.owner));
    context.body = await services.jobs.run([`workspace:${workspace.id}`, `machine:${workspace.machineId}`], () =>
      services.driver.helper(workspace, 'git', context.state.body),
    );
  });
  router.post('/api/workspaces/:id/publish', async (context) => {
    const workspace = services.access.workspace(String(context.params.id), context.state.owner);
    services.machines.assertAvailable(services.machines.machine(workspace.owner));
    context.body = await services.gitControl.publish(
      workspace,
      services.access.project(workspace.projectId, workspace.owner),
      context.state.body,
    );
  });
  router.post('/api/workspaces/:id/editor-connections', async (context) => {
    const workspace = services.access.workspace(String(context.params.id), context.state.owner);
    services.machines.assertAvailable(services.machines.machine(workspace.owner));
    context.body = await services.jobs.run(
      [`workspace:${workspace.id}`, `machine:${workspace.machineId}`],
      async () => {
        await services.resources.sync(workspace, services.driver);
        return startupRecord(workspace).editorConnections;
      },
    );
  });
  router.get('/api/workspaces/:id/services', async (context) => {
    context.body = await services.driver.helper(
      services.access.workspace(String(context.params.id), context.state.owner),
      'services',
      { action: 'status' },
    );
  });
  router.post('/api/workspaces/:id/services', async (context) => {
    const workspace = services.access.workspace(String(context.params.id), context.state.owner);
    services.machines.assertAvailable(services.machines.machine(workspace.owner));
    context.body = await services.jobs.run([`workspace:${workspace.id}`, `machine:${workspace.machineId}`], () =>
      services.driver.helper(workspace, 'services', context.state.body),
    );
  });
  router.post('/api/workspaces/:id/maven-config', async (context) => {
    const workspace = services.access.workspace(String(context.params.id), context.state.owner);
    services.machines.assertAvailable(services.machines.machine(workspace.owner));
    context.body = await services.jobs.run([`workspace:${workspace.id}`, `machine:${workspace.machineId}`], () =>
      services.driver.helper(workspace, 'maven-config', context.state.body),
    );
  });
}
