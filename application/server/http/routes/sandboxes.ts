import { HTTPError, requireString } from '../../platform/validation';

import type { Machine } from '../../domain/runtime';
import type { SandboxService } from '../../infrastructure/opensandbox';
import type { Store } from '../../platform/store';
import type Router from '@koa/router';
import type Koa from 'koa';

export function sandboxRoutes(
  router: Router<{ owner: string; body: Record<string, unknown> }>,
  service: SandboxService | undefined,
  store: Store,
  admin: (context: Koa.Context) => void,
): void {
  const access = (context: Koa.Context): SandboxService => {
    admin(context);
    if (!service) {
      throw new HTTPError(503, '尚未配置 OPEN_SANDBOX_URL');
    }
    return service;
  };
  router.get('/api/sandboxes', async (context) => {
    const sandbox = access(context);
    const records = await sandbox.list();
    context.body = {
      items: records.map((info) => {
        const machine = store.list<Machine>('machine').find((item) => item.envId === info.id);
        return {
          ...sandbox.record(info),
          workspaceOwner: machine ? store.get('user', machine.owner)?.name || machine.owner : undefined,
        };
      }),
    };
  });
  router.post('/api/sandboxes', (context) => {
    access(context);
    throw new HTTPError(410, '请通过工作区创建个人开发机，避免绕过配额');
  });
  router.get('/api/sandboxes/:id', async (context) => {
    const sandbox = access(context);
    context.body = sandbox.record(await sandbox.manager.getSandboxInfo(String(context.params.id)));
  });
  for (const action of ['renew', 'pause', 'resume', 'delete', 'restart', 'snapshot', 'snapshots', 'exec']) {
    router.post(`/api/sandboxes/:id/${action}`, async (context) => {
      const sandbox = access(context);
      const id = String(context.params.id);
      const body = context.state.body;
      const managed = store.list<Machine>('machine').some((machine) => machine.envId === id);
      if (action === 'restart' || (managed && ['pause', 'delete'].includes(action))) {
        throw new HTTPError(410, '受管理开发机请通过工作区停启或回收，不能破坏其文件');
      }
      switch (action) {
        case 'renew': {
          const seconds = Number(body.timeoutSeconds || 86400);
          if (!Number.isInteger(seconds) || seconds < 60 || seconds > 2592000) {
            throw new HTTPError(400, '续期范围为 1 分钟至 30 天');
          }
          await sandbox.manager.renewSandbox(id, seconds);
          break;
        }
        case 'pause':
          await sandbox.manager.pauseSandbox(id);
          break;
        case 'resume':
          await sandbox.manager.resumeSandbox(id);
          break;
        case 'delete':
          await sandbox.manager.killSandbox(id);
          break;
        case 'snapshot':
        case 'snapshots':
          context.body = await sandbox.manager.createSnapshot(id, {
            name: typeof body.name === 'string' ? body.name.slice(0, 120) : undefined,
          });
          return;
        case 'exec':
          context.body = { output: await sandbox.run(id, requireString(body.command, '命令', 32000)) };
          return;
      }
      context.body = { ok: true };
    });
  }
  router.get('/api/snapshots', async (context) => {
    const sandbox = access(context);
    const items = [];
    for (let page = 1; page <= 100; page++) {
      const result = await sandbox.manager.listSnapshots({ page, pageSize: 100 });
      items.push(...result.items);
      if (result.items.length < 100) {
        context.body = { items };
        return;
      }
    }
    throw new HTTPError(502, '快照数量超过分页上限');
  });
  router.post('/api/snapshots/:id/delete', async (context) => {
    await access(context).manager.deleteSnapshot(String(context.params.id));
    context.body = { ok: true };
  });
}
