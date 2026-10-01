import { NotebookModule } from '@opensumi/ide-notebook/browser';

import { NotebookFeature } from '../product-profile';

import type { ProductModuleBinding } from '../product-runtime-plan';
import type { BrowserModule, ConstructorOf } from '@opensumi/ide-core-browser';

export const NotebookBrowserBindings: readonly ProductModuleBinding<ConstructorOf<BrowserModule>>[] = [
  { feature: NotebookFeature, module: NotebookModule },
];
