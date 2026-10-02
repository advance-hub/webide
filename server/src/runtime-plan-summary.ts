import type { FeatureMigrationState, RuntimePlan } from '@opensumi/ide-core-node';

export interface RuntimePlanFeatureHealthSummary {
  readonly id: string;
  readonly scope: string;
  readonly critical: boolean;
  readonly migrationState: FeatureMigrationState;
  readonly legacy: boolean;
  readonly dependencies: readonly string[];
}

export interface RuntimePlanHealthSummary {
  readonly profileId: string;
  readonly runtime: string;
  readonly enabledOptions: readonly string[];
  readonly featureCount: number;
  readonly legacyFeatureCount: number;
  readonly declaredFeatureCount: number;
  readonly shadowFeatureCount: number;
  readonly enabledFeatureCount: number;
  readonly criticalFeatureCount: number;
  readonly features?: readonly RuntimePlanFeatureHealthSummary[];
}

/* * 将运行计划转换为可以通过健康检查接口公开的数据。 */
export function summarizeRuntimePlan(
  plan: RuntimePlan<unknown>,
  options: { includeFeatures?: boolean } = {},
): RuntimePlanHealthSummary {
  const summary: RuntimePlanHealthSummary = {
    profileId: plan.profileId,
    runtime: plan.runtime,
    enabledOptions: [...plan.enabledOptions],
    featureCount: plan.entries.length,
    legacyFeatureCount: plan.entries.filter((entry) => entry.migrationState === 'legacy').length,
    declaredFeatureCount: plan.entries.filter((entry) => entry.migrationState === 'declared').length,
    shadowFeatureCount: plan.entries.filter((entry) => entry.migrationState === 'shadow').length,
    enabledFeatureCount: plan.entries.filter((entry) => entry.migrationState === 'enabled').length,
    criticalFeatureCount: plan.entries.filter((entry) => entry.critical).length,
  };

  if (!options.includeFeatures) {
    return summary;
  }

  return {
    ...summary,
    features: plan.entries.map((entry) => ({
      id: entry.featureId,
      scope: entry.scope,
      critical: entry.critical,
      migrationState: entry.migrationState,
      legacy: entry.legacy,
      dependencies: [...entry.dependencies],
    })),
  };
}
