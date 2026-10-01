import { HTTPError, safeRelativePath } from './config';
import { type Store, newID, now, publicEntity } from './store';

import type { Workspace } from './git';
import type { Jobs } from './jobs';
import type { RuntimeDriver } from './runtime';
import type { MavenJob, MavenOptions } from '../src/domain';
import type Router from '@koa/router';

export const mavenKey = (workspace: Workspace): string => `maven:${workspace.machineId || workspace.id}`;

function options(body: Record<string, unknown>): MavenOptions {
  const { action: _action, ...value } = body;
  const keys = [
    'pom',
    'profiles',
    'modules',
    'alsoMake',
    'skipTests',
    'offline',
    'updateSnapshots',
    'clean',
    'jdk',
    'timeoutMinutes',
  ];
  if (Object.keys(value).some((key) => !keys.includes(key))) {
    throw new HTTPError(400, 'Maven 参数无效');
  }
  if (
    value.timeoutMinutes !== undefined &&
    (!Number.isInteger(value.timeoutMinutes) || Number(value.timeoutMinutes) < 1 || Number(value.timeoutMinutes) > 60)
  ) {
    throw new HTTPError(400, 'Maven 任务时限为 1–60 分钟');
  }
  if (value.jdk !== undefined && !['8', '11', '17', '21', ''].includes(String(value.jdk))) {
    throw new HTTPError(400, 'JDK 版本无效');
  }
  if (value.pom !== undefined) {
    if (typeof value.pom !== 'string' || value.pom.length > 1024) {
      throw new HTTPError(400, 'POM 无效');
    }
    safeRelativePath(value.pom);
  }
  for (const key of ['profiles', 'modules']) {
    if (
      value[key] !== undefined &&
      (!Array.isArray(value[key]) ||
        value[key].length > 64 ||
        value[key].some(
          (item) =>
            typeof item !== 'string' ||
            !/^[A-Za-z0-9_.:][A-Za-z0-9_./:-]{0,255}$/.test(item) ||
            item.split('/').includes('..'),
        ))
    ) {
      throw new HTTPError(400, 'Profile 或模块参数无效');
    }
  }
  for (const key of ['alsoMake', 'skipTests', 'offline', 'updateSnapshots', 'clean']) {
    if (value[key] !== undefined && typeof value[key] !== 'boolean') {
      throw new HTTPError(400, 'Maven 开关无效');
    }
  }
  if (value.offline && value.updateSnapshots) {
    throw new HTTPError(400, '离线构建不能更新快照');
  }
  if (['test', 'verify'].includes(String(body.action)) && value.skipTests) {
    throw new HTTPError(400, '测试和校验任务不能跳过测试');
  }
  return value as MavenOptions;
}

export function mavenRoutes(
  router: Router<{ owner: string; body: Record<string, unknown> }>,
  store: Store,
  driver: RuntimeDriver,
  jobs: Jobs,
  workspaceFor: (id: string, owner: string) => Workspace,
): void {
  router.get('/api/workspaces/:id/maven', async (context) => {
    const workspace = workspaceFor(String(context.params.id), context.state.owner);
    if (context.query.job) {
      const id = String(context.query.job);
      if (![workspace.mavenJob, ...(workspace.mavenHistory || [])].some((job) => job?.id === id)) {
        throw new HTTPError(404, 'Maven 任务不存在');
      }
      context.body = { log: await driver.helper(workspace, 'maven', { action: 'log', id }) };
    } else {
      context.body = {
        report: await driver.helper(workspace, 'maven', {
          action: 'inspect',
          ...(context.query.pom ? { pom: String(context.query.pom) } : {}),
        }),
      };
    }
  });
  router.post('/api/workspaces/:id/maven', (context) => {
    const workspace = workspaceFor(String(context.params.id), context.state.owner);
    const action = String(context.state.body.action);
    if (!['prepare', 'build', 'test', 'verify', 'install', 'tree'].includes(action)) {
      throw new HTTPError(400, '未知 Maven 操作');
    }
    const configuration = options(context.state.body);
    if (workspace.status !== 'ready' || jobs.busy(`workspace:${workspace.id}`)) {
      throw new HTTPError(409, '工作区尚未就绪或正在处理其他操作');
    }
    const job: MavenJob = { id: newID(), action, status: 'queued', options: configuration, startedAt: now() };
    const persist = (status: string, error?: string) => {
      const current = workspaceFor(workspace.id, workspace.owner);
      if (!current.mavenJob || current.mavenJob.id !== job.id) {
        return;
      }
      current.mavenJob.status = status;
      current.mavenJob.error = error;
      if (['done', 'failed', 'cancelled'].includes(status)) {
        current.mavenJob.finishedAt = now();
      }
      store.put('workspace', current);
    };
    jobs.enqueue(
      mavenKey(workspace),
      'maven',
      async () => {
        if (workspaceFor(workspace.id, workspace.owner).mavenJob?.status === 'cancelling') {
          persist('cancelled');
          return;
        }
        persist('running');
        const report = await driver.helper(workspace, 'maven', { ...configuration, action, id: job.id });
        persist(report.lastStatus === 'cancelled' ? 'cancelled' : 'done');
      },
      (error) => persist('failed', error.message),
    );
    workspace.mavenHistory = [
      ...(workspace.mavenJob ? [workspace.mavenJob] : []),
      ...(workspace.mavenHistory || []),
    ].slice(0, 19);
    workspace.mavenJob = job;
    store.put('workspace', workspace);
    context.status = 202;
    context.body = publicEntity(workspace);
  });
  router.post('/api/workspaces/:id/maven-cancel', async (context) => {
    const workspace = workspaceFor(String(context.params.id), context.state.owner);
    const job = workspace.mavenJob;
    if (!job || job.id !== context.state.body.id || !['queued', 'running', 'cancelling'].includes(job.status)) {
      throw new HTTPError(409, '任务已结束或任务 ID 已变化');
    }
    const queued = job.status === 'queued';
    job.status = 'cancelling';
    store.put('workspace', workspace);
    if (!queued) {
      await driver.helper(workspace, 'maven', { action: 'cancel', id: job.id });
    }
    context.body = { ok: true };
  });
}
