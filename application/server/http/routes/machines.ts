import { type Workspace } from '../../domain/models';
import { type Machine } from '../../domain/runtime';
import { publicEntity } from '../../platform/store';
import { HTTPError } from '../../platform/validation';

import type { APIRouter, RouteServices } from '../context';

export function mountMachinesRoutes(
  router: APIRouter,
  services: Pick<RouteServices, 'config' | 'driver' | 'jobs' | 'machines' | 'store'>,
): void {
  router.get('/api/machine', (context) => {
    const machine = services.store.list<Machine>('machine', context.state.owner)[0];
    context.body = {
      machine: machine ? publicEntity(machine) : null,
      allocated: services.store.list('machine').length,
      limit: services.config.machineLimit,
      workspaces: services.store.list<Workspace>('workspace', context.state.owner).filter((w) => !w.archived).length,
      legacyWorkspaces: 0,
      ...services.machines.view(machine),
    };
  });
  router.post('/api/machine/release', async (context) => {
    if (services.store.list<Workspace>('workspace', context.state.owner).some((w) => !w.archived)) {
      throw new HTTPError(409, '请先删除开发机上的工作区');
    }
    const machine = services.store.list<Machine>('machine', context.state.owner)[0];
    if (machine) {
      services.machines.assertAvailable(machine);
      await services.jobs.run([`machine:${machine.id}`], async () => {
        await services.driver.release(machine);
        services.store.delete('machine', machine.id);
      });
    }
    context.body = { ok: true };
  });
  router.post('/api/machine/tools', async (context) => {
    const machine = services.machines.machine(context.state.owner);
    services.machines.assertAvailable(machine);
    if (context.state.body.action === 'policy-save') {
      context.body = await services.jobs.run([`machine:${machine.id}`], async () =>
        services.machines.savePolicy(machine, context.state.body),
      );
      return;
    }
    const workspace = services.store.list<Workspace>('workspace', context.state.owner).find((w) => !w.archived);
    if (!workspace) {
      throw new HTTPError(409, '尚未创建工作区');
    }
    const body = context.state.body;
    const action = String(body.action || 'inspect');
    context.body = await services.jobs.run([`machine:${machine.id}`], () =>
      services.driver.helper(workspace, action.startsWith('preferences-') ? 'preferences' : 'machine', {
        ...body,
        action: action.replace('preferences-', ''),
      }),
    );
  });
}
