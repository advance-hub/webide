import { type DevelopmentResources, publicProfile, resourceIDs } from '../../modules/resources/service';
import { HTTPError } from '../../platform/validation';

import type { APIRouter } from '../context';

export function resourceRoutes(router: APIRouter, service: DevelopmentResources): void {
  router.get('/api/development-resources', (c) => {
    c.set('Cache-Control', 'no-store');
    c.body = resourceIDs.map((id) => publicProfile(service.profile(c.state.owner, id)));
  });
  router.get('/api/development-resources/:id', (c) => {
    if (!service.config.localDemo && new URL(service.config.publicURL).protocol !== 'https:') {
      throw new HTTPError(403, '凭据读取需要 HTTPS');
    }
    c.set('Cache-Control', 'no-store');
    const p = service.profile(c.state.owner, String(c.params.id));
    c.body = { ...publicProfile(p), password: p.password, secretId: p.secretId, secretKey: p.secretKey };
  });
  router.post('/api/development-resources/:id', (c) => {
    c.body = service.save(c.state.owner, String(c.params.id), c.state.body);
  });
  router.post('/api/development-resources/:id/probe', async (c) => {
    c.body = await service.probe(c.state.owner, String(c.params.id));
  });
  router.get('/api/development-resources/cos/objects', async (c) => {
    try {
      c.body = await service.objects(c.state.owner, String(c.query.prefix || ''), String(c.query.marker || ''));
    } catch (error) {
      if (error instanceof HTTPError) {
        throw error;
      }
      throw new HTTPError(502, 'COS 列表读取失败');
    }
  });
  router.get('/api/development-resources/cos/text', async (c) => {
    c.set('Cache-Control', 'no-store');
    try {
      c.body = await service.text(c.state.owner, String(c.query.key || ''));
    } catch (error) {
      if (error instanceof HTTPError) {
        throw error;
      }
      throw new HTTPError(502, 'COS 文本读取失败');
    }
  });
}
