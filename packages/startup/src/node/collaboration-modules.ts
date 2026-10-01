import { CollaborationModule } from '@opensumi/ide-collaboration/node';

import { CollaborationFeature } from '../product-profile';

import type { ProductModuleBinding } from '../product-runtime-plan';
import type { ConstructorOf, NodeModule } from '@opensumi/ide-core-node';

export const CollaborationNodeBindings: readonly ProductModuleBinding<ConstructorOf<NodeModule>>[] = [
  { feature: CollaborationFeature, module: CollaborationModule },
];
