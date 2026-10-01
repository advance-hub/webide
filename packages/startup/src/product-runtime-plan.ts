import { compileRuntimePlan, defineFeatureFacet } from '@opensumi/ide-core-common';

import {
  CommonBrowserFeatures,
  CommonNodeFeatures,
  OpenSumiDefaultProductProfile,
  OpenSumiProductOption,
  OptionalBrowserFeatures,
  OptionalNodeFeatures,
} from './product-profile';
import { CommonBrowserBoundaryRequirements, CommonBrowserFacetOptions, CommonNodeFacetOptions } from './runtime-facets';

import type { FeatureDefinition, RuntimePlan } from '@opensumi/ide-core-common';

export type OpenSumiProductRuntime = 'browser' | 'node';

export interface ProductModuleBinding<TModule> {
  readonly feature: FeatureDefinition;
  readonly module: TModule;
}

export type LoadedProductOption<TModule> = {
  readonly id: OpenSumiProductOption;
} & (
  | { readonly bindings: readonly ProductModuleBinding<TModule>[]; readonly modules?: never }
  | {
      /** @deprecated Bind each module to its feature explicitly. */ readonly modules: readonly TModule[];
      readonly bindings?: never;
    }
);

export type OpenSumiProductRuntimeCatalog<TModule> = {
  readonly runtime: OpenSumiProductRuntime;
  readonly options?: readonly LoadedProductOption<TModule>[];
} & (
  | { readonly commonBindings: readonly ProductModuleBinding<TModule>[]; readonly commonModules?: never }
  | {
      /** @deprecated Only for existing integrations; product entrypoints use bindings. */ readonly commonModules: readonly TModule[];
      readonly commonBindings?: never;
    }
);

/**
 * A compiled OpenSumi product plan with an explicit boundary between the
 * framework-owned prefix and its optional feature tail.
 */
export interface OpenSumiProductRuntimePlan<TModule = unknown> extends RuntimePlan<TModule> {
  readonly frameworkEntryCount: number;
}

const runtimeCatalog = {
  browser: {
    scope: 'window',
    commonFeatures: CommonBrowserFeatures,
    optionalFeatures: OptionalBrowserFeatures,
    facetOptions: CommonBrowserFacetOptions,
    boundaryRequirements: CommonBrowserBoundaryRequirements,
  },
  node: {
    scope: 'application',
    commonFeatures: CommonNodeFeatures,
    optionalFeatures: OptionalNodeFeatures,
    facetOptions: CommonNodeFacetOptions,
    boundaryRequirements: [],
  },
} as const;

/**
 * Compiles the framework-owned portion of a Browser or Node product runtime.
 * Optional module code remains dynamically loaded by the product entrypoint;
 * this function only binds those loaded constructors to stable feature ids and
 * returns the canonical profile order.
 */
export function compileOpenSumiProductRuntimePlan<TModule>(
  catalog: OpenSumiProductRuntimeCatalog<TModule>,
): OpenSumiProductRuntimePlan<TModule> {
  const runtime = runtimeCatalog[catalog.runtime];
  const bindings = catalog.commonBindings
    ? [...catalog.commonBindings]
    : bindLegacyModules(runtime.commonFeatures, catalog.commonModules!, `Legacy ${catalog.runtime} catalog`);
  validateBindings(bindings, runtime.commonFeatures, `${catalog.runtime} common`);
  const enabledOptions: OpenSumiProductOption[] = [];
  const seenOptions = new Set<OpenSumiProductOption>();

  for (const option of catalog.options || []) {
    if (seenOptions.has(option.id)) {
      throw new Error(`OpenSumi ${catalog.runtime} runtime loads product option ${option.id} more than once`);
    }
    seenOptions.add(option.id);

    const optionFeatures = runtime.optionalFeatures[option.id];
    if (!optionFeatures) {
      throw new Error(`OpenSumi product profile has no option ${String(option.id)}`);
    }
    const optionBindings =
      option.bindings ||
      bindLegacyModules(optionFeatures, option.modules!, `OpenSumi ${catalog.runtime} option ${option.id}`);
    validateBindings(optionBindings, optionFeatures, `${catalog.runtime} option ${option.id}`);

    enabledOptions.push(option.id);
    bindings.push(...optionBindings);
  }

  const plan = compileRuntimePlan(
    OpenSumiDefaultProductProfile,
    bindings.map(({ feature, module }) => {
      const options = runtime.facetOptions[feature.id];
      return defineFeatureFacet({
        feature,
        module,
        runtime: catalog.runtime,
        scope: options?.scope || runtime.scope,
        provides: options?.provides,
        consumes: options?.consumes,
        migrationState: options?.migrationState || (options ? 'declared' : 'legacy'),
        legacy: options?.migrationState !== 'enabled',
      });
    }),
    {
      runtime: catalog.runtime,
      enabledOptions,
      boundaryRequirements: runtime.boundaryRequirements,
    },
  );

  return {
    ...plan,
    frameworkEntryCount: runtime.commonFeatures.length,
  };
}

function bindLegacyModules<TModule>(
  features: readonly FeatureDefinition[],
  modules: readonly TModule[],
  label: string,
): ProductModuleBinding<TModule>[] {
  if (features.length !== modules.length) {
    throw new Error(`${label} has ${features.length} features but ${modules.length} modules`);
  }
  return features.map((feature, index) => ({ feature, module: modules[index] }));
}

function validateBindings<TModule>(
  bindings: readonly ProductModuleBinding<TModule>[],
  expected: readonly FeatureDefinition[],
  label: string,
): void {
  const seen = new Set<string>();
  for (const binding of bindings) {
    if (!expected.includes(binding.feature) || seen.has(binding.feature.id) || binding.module === undefined) {
      throw new Error(`Invalid or duplicate feature binding ${binding.feature.id} in OpenSumi ${label}`);
    }
    seen.add(binding.feature.id);
  }
  for (const feature of expected) {
    if (!seen.has(feature.id)) {
      throw new Error(`Missing feature binding ${feature.id} in OpenSumi ${label}`);
    }
  }
}
