import type { Machines } from '../../modules/machines/service';
import type { APIRouter } from '../context';

export function backupRoutes(router: APIRouter, machines: Machines): void {
  router.get('/api/machine/backups', (context) => {
    context.set('Cache-Control', 'no-store');
    context.body = machines.listBackups(context.state.owner);
  });
  router.post('/api/machine/backups', async (context) => {
    const result = await machines.backupAction(context.state.owner, context.state.body);
    context.status = result.status;
    context.body = result.body;
  });
}
