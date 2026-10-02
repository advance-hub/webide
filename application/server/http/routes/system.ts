import { DockerEngine } from '../../infrastructure/docker';
import { hash } from '../../platform/store';
import { HTTPError, requireString } from '../../platform/validation';

import type { APIRouter, RouteServices } from '../context';

export function mountSystemRoutes(
  router: APIRouter,
  services: Pick<RouteServices, 'access' | 'config' | 'driver' | 'repositories' | 'sandbox' | 'store'>,
): void {
  const docker = new DockerEngine(services.config);
  router.get('/healthz', (context) => {
    context.body = { status: 'ok', runtime: 'node', node: process.version, driver: services.driver.name };
  });
  router.get('/api/config', (context) => {
    context.body = {
      gitlabURL: services.repositories.connection('local-developer').url,
      localDemo: services.config.localDemo,
      driver: services.driver.name,
      sandboxAdmin: !!services.config.sandboxURL,
    };
  });
  router.post('/api/login', async (context) => {
    let owner = 'local-developer';
    let name = '本地开发者';
    if (!services.config.localDemo) {
      const token = requireString(context.state.body.token, '令牌', 4000);
      const user = await services.access.verifyConnection({ url: services.config.gitlabURL, token });
      owner = `${services.config.gitlabURL}:${user.id}`;
      name = user.name;
      services.store.put('user', { id: owner, owner, name });
    }
    context.cookies.set('workbench_session', services.store.createSession(owner), {
      httpOnly: true,
      sameSite: 'strict',
      secure: services.config.publicURL.startsWith('https:'),
      maxAge: 86400000,
    });
    context.body = { id: hash(owner), name, mode: services.config.localDemo ? 'demo' : 'gitlab' };
  });
  router.get('/api/me', (context) => {
    const owner = context.state.owner;
    context.body = {
      id: hash(owner),
      name: services.store.get('user', owner)?.name || '本地开发者',
      mode: services.config.localDemo ? 'demo' : 'gitlab',
    };
  });
  router.post('/api/logout', (context) => {
    services.store.revoke(context.cookies.get('workbench_session') || '');
    context.cookies.set('workbench_session', '', { maxAge: 0 });
    context.body = { ok: true };
  });
  router.get('/api/catalog', (context) => {
    context.body = {
      environment: {
        driver: services.driver.name,
        imageConfigured: !!services.config.sandboxImage,
        cpu: services.config.sandboxCPU,
        memory: services.config.sandboxMemory,
        storageClass: services.config.storageClass,
        storageMode: services.driver.name === 'local' ? 'host' : services.config.storageMode,
      },
    };
  });
  router.get('/api/runtime', async (context) => {
    if (services.driver.name === 'sandbox') {
      await services.sandbox!.health();
    }
    context.body = { status: 'connected', driver: services.driver.name, node: process.version };
  });
  router.get('/api/images', async (context) => {
    const images = await docker.images();
    if (services.sandbox) {
      for (const sandbox of await services.sandbox.list()) {
        const image = images.find((item) => item.tags.includes(sandbox.image?.uri || ''));
        if (image) {
          image.inUse++;
        }
      }
    }
    context.body = { images };
  });
  router.post('/api/images/:reference/delete', async (context) => {
    services.access.admin(context);
    const reference = String(context.params.reference);
    if (services.sandbox && (await services.sandbox.list()).some((info) => info.image?.uri === reference)) {
      throw new HTTPError(409, '镜像仍关联运行环境');
    }
    await docker.removeImage(reference);
    context.body = { ok: true };
  });
}
