import type { RuntimeDriver } from '../../domain/runtime';
import type { Jobs } from '../../platform/jobs';
import type { Store } from '../../platform/store';
import type { AccessControl } from '../accounts/access';
import type { GitControl } from '../git/control';
import type { Machines } from '../machines/service';
import type { Repositories } from '../projects/repositories';
import type { DevelopmentResources } from '../resources/service';

export interface WorkspaceServices {
  store: Store;
  repositories: Repositories;
  resources: DevelopmentResources;
  gitControl: GitControl;
  machines: Machines;
  jobs: Jobs;
  driver: RuntimeDriver;
  access: AccessControl;
}
