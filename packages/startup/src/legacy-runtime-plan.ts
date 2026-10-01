import {
  FeatureDefinition,
  FeatureFacet,
  FeatureMigrationState,
  FeatureRuntime,
  ProductProfile,
  RuntimeBoundaryRequirement,
  RuntimePlan,
  RuntimePort,
  RuntimeScope,
  compileRuntimePlan,
  defineFeatureFacet,
  fromLegacyModule,
} from '@opensumi/ide-core-common';

export interface RuntimeFacetOptions {
  readonly scope?: RuntimeScope;
  readonly provides?: readonly RuntimePort[];
  readonly consumes?: readonly RuntimePort[];
  readonly migrationState?: FeatureMigrationState;
}

export interface LegacyRuntimeCatalog<TModule> {
  readonly profile: ProductProfile;
  readonly runtime: FeatureRuntime;
  readonly scope: RuntimeScope;
  readonly features: readonly FeatureDefinition[];
  readonly modules: readonly TModule[];
  readonly enabledOptions?: readonly string[];
  readonly facetOptions?: Readonly<Record<string, RuntimeFacetOptions>>;
  readonly boundaryRequirements?: readonly RuntimeBoundaryRequirement[];
}

/**
 * Adapts an ordered module list into the new runtime plan without changing
 * construction order. Facets default to legacy; per-feature options move one
 * capability at a time to an explicit Port/Scope contract. The length and
 * metadata checks prevent declarations from silently drifting from modules.
 */
export function compileLegacyRuntimePlan<TModule>(catalog: LegacyRuntimeCatalog<TModule>): RuntimePlan<TModule> {
  if (catalog.features.length !== catalog.modules.length) {
    throw new Error(
      `Legacy ${catalog.runtime} catalog has ${catalog.features.length} features but ${catalog.modules.length} modules`,
    );
  }

  const featureIds = new Set(catalog.features.map((feature) => feature.id));
  for (const featureId of Object.keys(catalog.facetOptions || {})) {
    if (!featureIds.has(featureId)) {
      throw new Error(`Runtime facet options reference ${featureId}, which is not in the ${catalog.runtime} catalog`);
    }
  }

  return compileRuntimePlan(
    catalog.profile,
    catalog.features.map((feature, index): FeatureFacet<TModule> => {
      const options = catalog.facetOptions?.[feature.id];
      if (!options) {
        return fromLegacyModule(feature, catalog.runtime, catalog.modules[index], {
          scope: catalog.scope,
        });
      }

      return defineFeatureFacet({
        feature,
        runtime: catalog.runtime,
        module: catalog.modules[index],
        scope: options.scope || catalog.scope,
        provides: options.provides,
        consumes: options.consumes,
        migrationState: options.migrationState || 'declared',
        legacy: options.migrationState !== 'enabled',
      });
    }),
    {
      runtime: catalog.runtime,
      enabledOptions: catalog.enabledOptions,
      boundaryRequirements: catalog.boundaryRequirements,
    },
  );
}
