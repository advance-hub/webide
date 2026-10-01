import { AINativeModule } from '@opensumi/ide-ai-native/browser';
import { BrowserModule, ConstructorOf } from '@opensumi/ide-core-browser';
import { DesignModule } from '@opensumi/ide-design/browser';

import { AIDesignFeature, AINativeFeature } from '../product-profile';

import type { ProductModuleBinding } from '../product-runtime-plan';

export const AIBrowserBindings: readonly ProductModuleBinding<ConstructorOf<BrowserModule>>[] = [
  { feature: AIDesignFeature, module: DesignModule },
  { feature: AINativeFeature, module: AINativeModule },
];
export const AIBrowserModules = AIBrowserBindings.map((binding) => binding.module);
