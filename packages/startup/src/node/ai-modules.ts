import { AINativeModule } from '@opensumi/ide-ai-native/node';
import { ConstructorOf, NodeModule } from '@opensumi/ide-core-node';

import { AINativeFeature } from '../product-profile';

import type { ProductModuleBinding } from '../product-runtime-plan';

export const AINodeBindings: readonly ProductModuleBinding<ConstructorOf<NodeModule>>[] = [
  { feature: AINativeFeature, module: AINativeModule },
];
export const AINodeModules = AINodeBindings.map((binding) => binding.module);
