import { CollaborationModule } from '@opensumi/ide-collaboration/browser';

import { CollaborationFeature } from '../product-profile';

import type { ProductModuleBinding } from '../product-runtime-plan';
import type { BrowserModule, ConstructorOf } from '@opensumi/ide-core-browser';

export const CollaborationBrowserBindings: readonly ProductModuleBinding<ConstructorOf<BrowserModule>>[] = [
  { feature: CollaborationFeature, module: CollaborationModule },
];
