export type FeatureRuntime =
  'browser' | 'node' | 'electron-main' | 'browser-worker' | 'extension-host' | 'workspace-agent';

export type RuntimeScope =
  'application' | 'workspace' | 'window' | 'session' | 'connection' | 'extension-host' | 'lease' | 'request';

export type FeatureMigrationState = 'legacy' | 'declared' | 'shadow' | 'enabled';

export interface FeatureDefinition {
  readonly id: string;
  readonly runtimes: readonly FeatureRuntime[];
  readonly requires?: readonly FeatureDefinition[];
  readonly critical?: boolean;
}

export interface ProductProfile {
  readonly id: string;
  readonly features: readonly FeatureDefinition[];
  readonly optionalFeatures?: Readonly<Record<string, readonly FeatureDefinition[]>>;
}

export interface RuntimePort<T = unknown> {
  readonly id: string;
  readonly version: number;
  readonly scope: RuntimeScope;
  readonly type?: (value: T) => T;
}

export interface RuntimeBoundaryRequirement {
  readonly port: RuntimePort;
  readonly providerRuntime: FeatureRuntime;
}

export interface FeatureFacet<TModule = unknown> {
  readonly feature: FeatureDefinition;
  readonly runtime: FeatureRuntime;
  readonly module: TModule;
  readonly scope: RuntimeScope;
  readonly provides?: readonly RuntimePort[];
  readonly consumes?: readonly RuntimePort[];
  readonly migrationState?: FeatureMigrationState;
  /** Compatibility flag for callers that have not migrated to migrationState. */
  readonly legacy?: boolean;
}

export interface RuntimePlanEntry<TModule = unknown> {
  readonly featureId: string;
  readonly dependencies: readonly string[];
  readonly module: TModule;
  readonly scope: RuntimeScope;
  readonly critical: boolean;
  readonly provides: readonly RuntimePort[];
  readonly consumes: readonly RuntimePort[];
  readonly migrationState: FeatureMigrationState;
  readonly legacy: boolean;
}

export interface RuntimePlan<TModule = unknown> {
  readonly profileId: string;
  readonly runtime: FeatureRuntime;
  readonly enabledOptions: readonly string[];
  readonly boundaryRequirements: readonly RuntimeBoundaryRequirement[];
  readonly entries: readonly RuntimePlanEntry<TModule>[];
}

export interface CompileRuntimePlanOptions {
  readonly runtime: FeatureRuntime;
  readonly enabledOptions?: readonly string[];
  /** Ports supplied by the runtime boundary instead of another feature in this plan. */
  readonly boundaryRequirements?: readonly RuntimeBoundaryRequirement[];
}

export interface RuntimePortDescriptor {
  readonly id: string;
  readonly version: number;
  readonly scope: RuntimeScope;
}

export interface RuntimeTopologyRuntime {
  readonly runtime: FeatureRuntime;
  readonly enabledOptions: readonly string[];
}

export interface RuntimePlanContractEntry {
  readonly featureId: string;
  readonly provides: readonly RuntimePortDescriptor[];
  readonly consumes: readonly RuntimePortDescriptor[];
}

export interface RuntimePlanContract {
  readonly profileId: string;
  readonly runtime: FeatureRuntime;
  readonly enabledOptions: readonly string[];
  readonly boundaryRequirements: readonly {
    readonly providerRuntime: FeatureRuntime;
    readonly port: RuntimePortDescriptor;
  }[];
  readonly entries: readonly RuntimePlanContractEntry[];
}

export interface RuntimeTopologyLink {
  readonly port: RuntimePortDescriptor;
  readonly consumerRuntime: FeatureRuntime;
  readonly consumerFeatureIds: readonly string[];
  readonly providerRuntime: FeatureRuntime;
  readonly providerFeatureId: string;
}

export interface RuntimeTopology {
  readonly profileId: string;
  readonly enabledOptions: readonly string[];
  readonly runtimes: readonly RuntimeTopologyRuntime[];
  readonly links: readonly RuntimeTopologyLink[];
}

export type FeatureGraphErrorCode =
  | 'INVALID_ID'
  | 'INVALID_FEATURE_RUNTIME'
  | 'INVALID_RUNTIME_SCOPE'
  | 'INVALID_MIGRATION_STATE'
  | 'INVALID_PORT_VERSION'
  | 'UNKNOWN_OPTION'
  | 'DUPLICATE_FEATURE'
  | 'FEATURE_CYCLE'
  | 'DUPLICATE_FACET'
  | 'UNSELECTED_FACET'
  | 'MISSING_FACET'
  | 'FACET_FEATURE_MISMATCH'
  | 'MIGRATION_STATE_MISMATCH'
  | 'DUPLICATE_PORT_PROVIDER'
  | 'MISSING_PORT_PROVIDER'
  | 'PORT_CONTRACT_MISMATCH'
  | 'DUPLICATE_RUNTIME_PLAN'
  | 'DUPLICATE_RUNTIME_PLAN_ENTRY'
  | 'MISSING_RUNTIME_PLAN'
  | 'MISSING_RUNTIME_PLAN_ENTRY'
  | 'UNEXPECTED_RUNTIME_PLAN'
  | 'UNEXPECTED_RUNTIME_PLAN_ENTRY'
  | 'RUNTIME_PLAN_ENTRY_ORDER_MISMATCH'
  | 'RUNTIME_PLAN_PROFILE_MISMATCH'
  | 'RUNTIME_PLAN_OPTIONS_MISMATCH'
  | 'INVALID_BOUNDARY_PROVIDER_RUNTIME'
  | 'MISSING_BOUNDARY_RUNTIME'
  | 'UNUSED_BOUNDARY_PORT'
  | 'MISSING_BOUNDARY_PORT_PROVIDER';

export class FeatureGraphError extends Error {
  constructor(
    public readonly code: FeatureGraphErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'FeatureGraphError';
  }
}

const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;
const runtimeOrder: readonly FeatureRuntime[] = [
  'browser',
  'node',
  'electron-main',
  'browser-worker',
  'extension-host',
  'workspace-agent',
];
const featureRuntimes = new Set<FeatureRuntime>(runtimeOrder);
const runtimeScopes = new Set<RuntimeScope>([
  'application',
  'workspace',
  'window',
  'session',
  'connection',
  'extension-host',
  'lease',
  'request',
]);
const migrationStates = new Set<FeatureMigrationState>(['legacy', 'declared', 'shadow', 'enabled']);

function assertValidId(kind: string, id: string): void {
  if (!idPattern.test(id)) {
    throw new FeatureGraphError('INVALID_ID', `${kind} id must be stable and namespaced, got ${JSON.stringify(id)}`);
  }
}

function assertValidFeature(feature: FeatureDefinition): void {
  assertValidId('Feature', feature.id);
  if (
    feature.runtimes.length === 0 ||
    new Set(feature.runtimes).size !== feature.runtimes.length ||
    feature.runtimes.some((runtime) => !featureRuntimes.has(runtime))
  ) {
    throw new FeatureGraphError(
      'INVALID_FEATURE_RUNTIME',
      `Feature ${feature.id} must declare one or more unique runtime facets`,
    );
  }
}

function assertValidFeatureRuntime(runtime: FeatureRuntime, owner: string): void {
  if (!featureRuntimes.has(runtime)) {
    throw new FeatureGraphError('INVALID_FEATURE_RUNTIME', `${owner} has unknown runtime ${String(runtime)}`);
  }
}

function assertValidRuntimeScope(scope: RuntimeScope, owner: string): void {
  if (!runtimeScopes.has(scope)) {
    throw new FeatureGraphError('INVALID_RUNTIME_SCOPE', `${owner} has unknown scope ${String(scope)}`);
  }
}

export function defineFeature<T extends FeatureDefinition>(definition: T): T {
  assertValidFeature(definition);
  return definition;
}

export function defineProductProfile<T extends ProductProfile>(profile: T): T {
  assertValidId('Product profile', profile.id);
  return profile;
}

function assertValidRuntimePort(port: RuntimePort): void {
  assertValidId('Runtime port', port.id);
  if (!Number.isSafeInteger(port.version) || port.version <= 0) {
    throw new FeatureGraphError('INVALID_PORT_VERSION', `Runtime port ${port.id} must have a positive integer version`);
  }
  assertValidRuntimeScope(port.scope, `Runtime port ${port.id}`);
}

export function defineRuntimePort<T>(port: RuntimePort<T>): RuntimePort<T> {
  assertValidRuntimePort(port);
  return port;
}

function assertSamePortContract(consumer: RuntimePort, provider: RuntimePort, featureId: string): void {
  if (consumer.version !== provider.version || consumer.scope !== provider.scope) {
    throw new FeatureGraphError(
      'PORT_CONTRACT_MISMATCH',
      `Feature ${featureId} consumes ${consumer.id}@${consumer.version} (${consumer.scope}), ` +
        `but the runtime provides ${provider.id}@${provider.version} (${provider.scope})`,
    );
  }
}

function compareRuntimes(left: FeatureRuntime, right: FeatureRuntime): number {
  return runtimeOrder.indexOf(left) - runtimeOrder.indexOf(right);
}

function describeRuntimePort(port: RuntimePort): RuntimePortDescriptor {
  return {
    id: port.id,
    version: port.version,
    scope: port.scope,
  };
}

export function defineFeatureFacet<TModule>(facet: FeatureFacet<TModule>): FeatureFacet<TModule> {
  assertValidFeatureRuntime(facet.runtime, `Feature ${facet.feature.id} facet`);
  assertValidRuntimeScope(facet.scope, `Feature ${facet.feature.id} facet`);
  if (!facet.feature.runtimes.includes(facet.runtime)) {
    throw new FeatureGraphError(
      'FACET_FEATURE_MISMATCH',
      `Feature ${facet.feature.id} does not declare the ${facet.runtime} runtime`,
    );
  }
  resolveFacetMigration(facet);
  return facet;
}

function resolveFacetMigration(facet: FeatureFacet): {
  migrationState: FeatureMigrationState;
  legacy: boolean;
} {
  const migrationState = facet.migrationState ?? (facet.legacy ? 'legacy' : 'enabled');
  if (!migrationStates.has(migrationState)) {
    throw new FeatureGraphError(
      'INVALID_MIGRATION_STATE',
      `Feature ${facet.feature.id} has unknown migration state ${String(migrationState)}`,
    );
  }
  const legacy = facet.legacy ?? migrationState !== 'enabled';
  if (legacy !== (migrationState !== 'enabled')) {
    throw new FeatureGraphError(
      'MIGRATION_STATE_MISMATCH',
      `Feature ${facet.feature.id} migration state ${migrationState} conflicts with legacy=${String(legacy)}`,
    );
  }
  return { migrationState, legacy };
}

export function fromLegacyModule<TModule>(
  feature: FeatureDefinition,
  runtime: FeatureRuntime,
  module: TModule,
  options: Omit<FeatureFacet<TModule>, 'feature' | 'runtime' | 'module' | 'migrationState' | 'legacy'>,
): FeatureFacet<TModule> {
  return defineFeatureFacet({
    feature,
    runtime,
    module,
    migrationState: 'legacy',
    legacy: true,
    ...options,
  });
}

function resolveFeatureOrder(profile: ProductProfile, enabledOptions: readonly string[]): FeatureDefinition[] {
  assertValidId('Product profile', profile.id);
  const enabled = new Set(enabledOptions);
  const optionalFeatures = profile.optionalFeatures || {};

  for (const option of enabled) {
    if (!Object.prototype.hasOwnProperty.call(optionalFeatures, option)) {
      throw new FeatureGraphError('UNKNOWN_OPTION', `Product profile ${profile.id} has no optional feature ${option}`);
    }
  }

  const roots = [...profile.features];
  for (const [option, features] of Object.entries(optionalFeatures)) {
    assertValidId('Product option', option);
    if (enabled.has(option)) {
      roots.push(...features);
    }
  }

  const definitions = new Map<string, FeatureDefinition>();
  const state = new Map<string, 'visiting' | 'visited'>();
  const stack: string[] = [];
  const ordered: FeatureDefinition[] = [];

  const visit = (feature: FeatureDefinition): void => {
    assertValidFeature(feature);
    const existing = definitions.get(feature.id);
    if (existing && existing !== feature) {
      throw new FeatureGraphError(
        'DUPLICATE_FEATURE',
        `Feature id ${feature.id} is backed by more than one definition object`,
      );
    }
    definitions.set(feature.id, feature);

    const currentState = state.get(feature.id);
    if (currentState === 'visited') {
      return;
    }
    if (currentState === 'visiting') {
      const cycleStart = stack.indexOf(feature.id);
      const cycle = [...stack.slice(cycleStart), feature.id];
      throw new FeatureGraphError('FEATURE_CYCLE', `Feature dependency cycle: ${cycle.join(' -> ')}`);
    }

    state.set(feature.id, 'visiting');
    stack.push(feature.id);
    for (const dependency of feature.requires || []) {
      visit(dependency);
    }
    stack.pop();
    state.set(feature.id, 'visited');
    ordered.push(feature);
  };

  for (const feature of roots) {
    visit(feature);
  }
  return ordered;
}

export function compileRuntimePlan<TModule>(
  profile: ProductProfile,
  facets: readonly FeatureFacet<TModule>[],
  options: CompileRuntimePlanOptions,
): RuntimePlan<TModule> {
  assertValidFeatureRuntime(options.runtime, `Product profile ${profile.id}`);
  const enabledOptions = options.enabledOptions || [];
  const orderedFeatures = resolveFeatureOrder(profile, enabledOptions);
  const selectedFeatures = new Set(orderedFeatures.map((feature) => feature.id));
  const facetByFeature = new Map<string, FeatureFacet<TModule>>();

  for (const facet of facets) {
    assertValidFeatureRuntime(facet.runtime, `Feature ${facet.feature.id} facet`);
    if (facet.runtime !== options.runtime) {
      continue;
    }
    assertValidFeature(facet.feature);
    assertValidRuntimeScope(facet.scope, `Feature ${facet.feature.id} facet`);
    if (!selectedFeatures.has(facet.feature.id)) {
      throw new FeatureGraphError(
        'UNSELECTED_FACET',
        `Feature ${facet.feature.id} has a ${options.runtime} facet but is not selected by product profile ${profile.id}`,
      );
    }
    const existing = facetByFeature.get(facet.feature.id);
    if (existing) {
      throw new FeatureGraphError(
        'DUPLICATE_FACET',
        `Feature ${facet.feature.id} has more than one ${options.runtime} facet`,
      );
    }
    facetByFeature.set(facet.feature.id, facet);
  }

  const portProviders = new Map<string, { owner: string; port: RuntimePort }>();
  const entries: RuntimePlanEntry<TModule>[] = [];

  for (const boundary of options.boundaryRequirements || []) {
    assertValidFeatureRuntime(boundary.providerRuntime, `Runtime port ${boundary.port.id} boundary provider`);
    if (boundary.providerRuntime === options.runtime) {
      throw new FeatureGraphError(
        'INVALID_BOUNDARY_PROVIDER_RUNTIME',
        `${options.runtime} runtime port ${boundary.port.id} cannot be supplied by its own boundary`,
      );
    }
    assertValidRuntimePort(boundary.port);
    const previousProvider = portProviders.get(boundary.port.id);
    if (previousProvider) {
      throw new FeatureGraphError(
        'DUPLICATE_PORT_PROVIDER',
        `Runtime port ${boundary.port.id} is provided more than once by the ${options.runtime} boundary`,
      );
    }
    portProviders.set(boundary.port.id, {
      owner: `${boundary.providerRuntime} -> ${options.runtime} boundary`,
      port: boundary.port,
    });
  }

  for (const feature of orderedFeatures) {
    if (!feature.runtimes.includes(options.runtime)) {
      continue;
    }
    const facet = facetByFeature.get(feature.id);
    if (!facet) {
      throw new FeatureGraphError(
        'MISSING_FACET',
        `Feature ${feature.id} declares ${options.runtime} but the runtime catalog has no matching facet`,
      );
    }
    if (facet.feature !== feature) {
      throw new FeatureGraphError(
        'FACET_FEATURE_MISMATCH',
        `The ${options.runtime} facet for ${feature.id} references a different feature definition`,
      );
    }

    const provides = facet.provides || [];
    for (const port of provides) {
      assertValidRuntimePort(port);
      const previousProvider = portProviders.get(port.id);
      if (previousProvider) {
        throw new FeatureGraphError(
          'DUPLICATE_PORT_PROVIDER',
          `Runtime port ${port.id} is provided by both ${previousProvider.owner} and ${feature.id}`,
        );
      }
      portProviders.set(port.id, { owner: feature.id, port });
    }

    const consumes = facet.consumes || [];
    for (const port of consumes) {
      assertValidRuntimePort(port);
    }

    const migration = resolveFacetMigration(facet);
    entries.push({
      featureId: feature.id,
      dependencies: (feature.requires || [])
        .filter((dependency) => selectedFeatures.has(dependency.id) && dependency.runtimes.includes(options.runtime))
        .map((dependency) => dependency.id),
      module: facet.module,
      scope: facet.scope,
      critical: feature.critical ?? true,
      provides,
      consumes,
      migrationState: migration.migrationState,
      legacy: migration.legacy,
    });
  }

  for (const entry of entries) {
    for (const consumer of entry.consumes) {
      const provider = portProviders.get(consumer.id);
      if (!provider) {
        throw new FeatureGraphError(
          'MISSING_PORT_PROVIDER',
          `Feature ${entry.featureId} consumes runtime port ${consumer.id}, but ${options.runtime} has no provider`,
        );
      }
      assertSamePortContract(consumer, provider.port, entry.featureId);
    }
  }

  return {
    profileId: profile.id,
    runtime: options.runtime,
    enabledOptions: Object.keys(profile.optionalFeatures || {}).filter((option) => enabledOptions.includes(option)),
    boundaryRequirements: [...(options.boundaryRequirements || [])],
    entries,
  };
}

/** Copies only stable, JSON-safe contract metadata from an executable plan. */
export function toRuntimePlanContract(plan: RuntimePlan): RuntimePlanContract {
  return {
    profileId: plan.profileId,
    runtime: plan.runtime,
    enabledOptions: [...plan.enabledOptions],
    boundaryRequirements: plan.boundaryRequirements.map((requirement) => ({
      providerRuntime: requirement.providerRuntime,
      port: describeRuntimePort(requirement.port),
    })),
    entries: plan.entries.map((entry) => ({
      featureId: entry.featureId,
      provides: entry.provides.map(describeRuntimePort),
      consumes: entry.consumes.map(describeRuntimePort),
    })),
  };
}

function assertRuntimePlanShape(profile: ProductProfile, plan: RuntimePlanContract): void {
  const uniqueEnabledOptions = new Set(plan.enabledOptions);
  if (uniqueEnabledOptions.size !== plan.enabledOptions.length) {
    throw new FeatureGraphError(
      'RUNTIME_PLAN_OPTIONS_MISMATCH',
      `Runtime plan ${plan.runtime} enables the same product option more than once`,
    );
  }

  for (const option of plan.enabledOptions) {
    if (!Object.prototype.hasOwnProperty.call(profile.optionalFeatures || {}, option)) {
      throw new FeatureGraphError(
        'UNKNOWN_OPTION',
        `Runtime plan ${plan.runtime} enables unknown product option ${option}`,
      );
    }
  }

  const actualFeatureIds = new Set<string>();
  for (const entry of plan.entries) {
    assertValidId('Feature', entry.featureId);
    if (actualFeatureIds.has(entry.featureId)) {
      throw new FeatureGraphError(
        'DUPLICATE_RUNTIME_PLAN_ENTRY',
        `Runtime plan ${plan.runtime} contains feature ${entry.featureId} more than once`,
      );
    }
    actualFeatureIds.add(entry.featureId);
  }
}

function assertRuntimePlanEntriesMatchProfile(
  profile: ProductProfile,
  plan: RuntimePlanContract,
  selectedFeatures: readonly FeatureDefinition[],
): void {
  const expectedFeatures = selectedFeatures.filter((feature) => feature.runtimes.includes(plan.runtime));
  const expectedFeatureIds = new Set(expectedFeatures.map((feature) => feature.id));
  const actualFeatureIds = new Set(plan.entries.map((entry) => entry.featureId));

  for (const entry of plan.entries) {
    if (!expectedFeatureIds.has(entry.featureId)) {
      throw new FeatureGraphError(
        'UNEXPECTED_RUNTIME_PLAN_ENTRY',
        `Runtime plan ${plan.runtime} contains feature ${entry.featureId}, ` +
          `but it is not selected for product profile ${profile.id} on that runtime`,
      );
    }
  }

  for (const feature of expectedFeatures) {
    if (!actualFeatureIds.has(feature.id)) {
      throw new FeatureGraphError(
        'MISSING_RUNTIME_PLAN_ENTRY',
        `Runtime plan ${plan.runtime} is missing feature ${feature.id} selected by product profile ${profile.id}`,
      );
    }
  }

  const expectedOrder = expectedFeatures.map((feature) => feature.id);
  const actualOrder = plan.entries.map((entry) => entry.featureId);
  if (expectedOrder.some((featureId, index) => featureId !== actualOrder[index])) {
    throw new FeatureGraphError(
      'RUNTIME_PLAN_ENTRY_ORDER_MISMATCH',
      `Runtime plan ${plan.runtime} feature order does not match product profile ${profile.id}: ` +
        `expected ${expectedOrder.join(', ')}, got ${actualOrder.join(', ')}`,
    );
  }
}

/**
 * Validates the contracts between already compiled runtime plans and projects
 * them into a constructor-free topology suitable for diagnostics and CI.
 */
export function compileRuntimeTopology(
  profile: ProductProfile,
  runtimePlans: readonly RuntimePlanContract[],
): RuntimeTopology {
  assertValidId('Product profile', profile.id);
  const planByRuntime = new Map<FeatureRuntime, RuntimePlanContract>();

  for (const plan of runtimePlans) {
    assertValidFeatureRuntime(plan.runtime, `Runtime plan ${plan.profileId}`);
    if (plan.profileId !== profile.id) {
      throw new FeatureGraphError(
        'RUNTIME_PLAN_PROFILE_MISMATCH',
        `Runtime plan ${plan.runtime} belongs to ${plan.profileId}, expected ${profile.id}`,
      );
    }
    assertRuntimePlanShape(profile, plan);
    if (planByRuntime.has(plan.runtime)) {
      throw new FeatureGraphError(
        'DUPLICATE_RUNTIME_PLAN',
        `Product profile ${profile.id} has more than one ${plan.runtime} runtime plan`,
      );
    }
    planByRuntime.set(plan.runtime, plan);
  }

  const plans = [...planByRuntime.values()].sort((left, right) => compareRuntimes(left.runtime, right.runtime));
  const enabledOptions: string[] = [];
  for (const [option, features] of Object.entries(profile.optionalFeatures || {})) {
    // An option is selected by the runtimes of its declared roots. Dependency
    // runtimes do not need to repeat that option flag; they are validated from
    // the global selected-feature closure below.
    const optionRuntimes = new Set(features.flatMap((feature) => feature.runtimes));
    const relevantPlans = plans.filter((plan) => optionRuntimes.has(plan.runtime));
    const selections = relevantPlans.map((plan) => plan.enabledOptions.includes(option));
    if (selections.some(Boolean) && !selections.every(Boolean)) {
      throw new FeatureGraphError(
        'RUNTIME_PLAN_OPTIONS_MISMATCH',
        `Runtime plans for ${profile.id} disagree on product option ${option}: ` +
          relevantPlans.map((plan) => `${plan.runtime}=${String(plan.enabledOptions.includes(option))}`).join(', '),
      );
    }
    if (selections.length > 0 && selections.every(Boolean)) {
      enabledOptions.push(option);
    }
  }

  const selectedFeatures = resolveFeatureOrder(profile, enabledOptions);
  const expectedRuntimes = new Set(selectedFeatures.flatMap((feature) => feature.runtimes));
  for (const plan of plans) {
    assertRuntimePlanEntriesMatchProfile(profile, plan, selectedFeatures);
  }
  for (const runtime of runtimeOrder) {
    if (expectedRuntimes.has(runtime) && !planByRuntime.has(runtime)) {
      throw new FeatureGraphError(
        'MISSING_RUNTIME_PLAN',
        `Product profile ${profile.id} selects features for ${runtime}, but that runtime plan is absent`,
      );
    }
  }
  for (const plan of plans) {
    if (!expectedRuntimes.has(plan.runtime)) {
      throw new FeatureGraphError(
        'UNEXPECTED_RUNTIME_PLAN',
        `Product profile ${profile.id} selects no features for ${plan.runtime}, but that runtime plan is present`,
      );
    }
  }

  for (const plan of plans) {
    const contractProviders = new Map<string, { owner: string; port: RuntimePortDescriptor }>();
    for (const requirement of plan.boundaryRequirements) {
      assertValidFeatureRuntime(requirement.providerRuntime, `Runtime port ${requirement.port.id} boundary provider`);
      if (requirement.providerRuntime === plan.runtime) {
        throw new FeatureGraphError(
          'INVALID_BOUNDARY_PROVIDER_RUNTIME',
          `${plan.runtime} runtime port ${requirement.port.id} cannot be supplied by its own boundary`,
        );
      }
      assertValidRuntimePort(requirement.port);
      const previousProvider = contractProviders.get(requirement.port.id);
      if (previousProvider) {
        throw new FeatureGraphError(
          'DUPLICATE_PORT_PROVIDER',
          `Runtime port ${requirement.port.id} is provided by both ${previousProvider.owner} and ` +
            `${requirement.providerRuntime} -> ${plan.runtime} boundary`,
        );
      }
      contractProviders.set(requirement.port.id, {
        owner: `${requirement.providerRuntime} -> ${plan.runtime} boundary`,
        port: requirement.port,
      });
    }
    for (const entry of plan.entries) {
      for (const port of entry.provides) {
        assertValidRuntimePort(port);
        const previousProvider = contractProviders.get(port.id);
        if (previousProvider) {
          throw new FeatureGraphError(
            'DUPLICATE_PORT_PROVIDER',
            `Runtime port ${port.id} is provided by both ${previousProvider.owner} and ${entry.featureId}`,
          );
        }
        contractProviders.set(port.id, { owner: entry.featureId, port });
      }
      for (const port of entry.consumes) {
        assertValidRuntimePort(port);
      }
    }
    for (const entry of plan.entries) {
      for (const consumer of entry.consumes) {
        const provider = contractProviders.get(consumer.id);
        if (!provider) {
          throw new FeatureGraphError(
            'MISSING_PORT_PROVIDER',
            `Feature ${entry.featureId} consumes runtime port ${consumer.id}, but ${plan.runtime} has no provider`,
          );
        }
        assertSamePortContract(consumer, provider.port, entry.featureId);
      }
    }
  }

  const links: RuntimeTopologyLink[] = [];
  for (const consumerPlan of plans) {
    for (const boundary of consumerPlan.boundaryRequirements) {
      const providerPlan = planByRuntime.get(boundary.providerRuntime);
      if (!providerPlan) {
        throw new FeatureGraphError(
          'MISSING_BOUNDARY_RUNTIME',
          `${consumerPlan.runtime} runtime expects ${boundary.port.id} from ${boundary.providerRuntime}, ` +
            'but that runtime plan is absent',
        );
      }

      const consumerFeatureIds = [
        ...new Set(
          consumerPlan.entries
            .filter((entry) => entry.consumes.some((port) => port.id === boundary.port.id))
            .map((entry) => entry.featureId),
        ),
      ];
      if (consumerFeatureIds.length === 0) {
        throw new FeatureGraphError(
          'UNUSED_BOUNDARY_PORT',
          `${consumerPlan.runtime} boundary declares ${boundary.port.id} from ${boundary.providerRuntime}, ` +
            'but no feature consumes it',
        );
      }

      const providers = providerPlan.entries.filter((entry) =>
        entry.provides.some((port) => port.id === boundary.port.id),
      );
      if (providers.length === 0) {
        throw new FeatureGraphError(
          'MISSING_BOUNDARY_PORT_PROVIDER',
          `${consumerPlan.runtime} runtime consumes ${boundary.port.id} from ${boundary.providerRuntime}, ` +
            'but that runtime plan has no feature provider',
        );
      }
      if (providers.length > 1) {
        throw new FeatureGraphError(
          'DUPLICATE_PORT_PROVIDER',
          `${boundary.providerRuntime} runtime has more than one feature provider for ${boundary.port.id}`,
        );
      }

      const providerPort = providers[0].provides.find((port) => port.id === boundary.port.id)!;
      assertSamePortContract(boundary.port, providerPort, consumerFeatureIds.join(','));
      links.push({
        port: describeRuntimePort(boundary.port),
        consumerRuntime: consumerPlan.runtime,
        consumerFeatureIds,
        providerRuntime: providerPlan.runtime,
        providerFeatureId: providers[0].featureId,
      });
    }
  }

  return {
    profileId: profile.id,
    enabledOptions: [...enabledOptions],
    runtimes: plans.map((plan) => ({
      runtime: plan.runtime,
      enabledOptions: [...plan.enabledOptions],
    })),
    links,
  };
}

export function explainRuntimePlan(plan: RuntimePlan): string {
  const options = plan.enabledOptions.length > 0 ? ` options=${plan.enabledOptions.join(',')}` : '';
  const lines = [`profile=${plan.profileId} runtime=${plan.runtime}${options}`];
  for (const entry of plan.entries) {
    const dependencies = entry.dependencies.length > 0 ? ` requires=${entry.dependencies.join(',')}` : '';
    lines.push(
      `${entry.featureId} scope=${entry.scope} critical=${String(entry.critical)} migration=${entry.migrationState} legacy=${String(entry.legacy)}${dependencies}`,
    );
  }
  return lines.join('\n');
}

export function explainRuntimeTopology(topology: RuntimeTopology): string {
  const options = topology.enabledOptions.length > 0 ? ` options=${topology.enabledOptions.join(',')}` : '';
  const lines = [
    `profile=${topology.profileId} runtimes=${topology.runtimes.map(({ runtime }) => runtime).join(',')}${options}`,
  ];
  for (const link of topology.links) {
    lines.push(
      `${link.port.id}@${link.port.version} scope=${link.port.scope} ` +
        `${link.providerRuntime}:${link.providerFeatureId} -> ` +
        `${link.consumerRuntime}:${link.consumerFeatureIds.join(',')}`,
    );
  }
  return lines.join('\n');
}
