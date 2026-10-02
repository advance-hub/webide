import type { IDEProxy } from './ide-proxy';
import type { RuntimeDriver } from '../domain/runtime';
import type { SandboxService } from '../infrastructure/opensandbox';
import type { AccessControl } from '../modules/accounts/access';
import type { GitControl } from '../modules/git/control';
import type { Machines } from '../modules/machines/service';
import type { Repositories } from '../modules/projects/repositories';
import type { DevelopmentResources } from '../modules/resources/service';
import type { WorkspaceOperations } from '../modules/workspaces/operations';
import type { Config } from '../platform/config';
import type { Jobs } from '../platform/jobs';
import type { Store } from '../platform/store';
import type Router from '@koa/router';

export type APIRouter = Router<{ owner: string; body: Record<string, unknown> }>;
/** 组装根提供路由需要的对象，各路由用 Pick 收窄依赖。 */
export interface RouteServices {
  config: Config;
  store: Store;
  repositories: Repositories;
  resources: DevelopmentResources;
  gitControl: GitControl;
  machines: Machines;
  jobs: Jobs;
  driver: RuntimeDriver;
  sandbox?: SandboxService;
  access: AccessControl;
  workspaces: WorkspaceOperations;
  ide: IDEProxy;
}
