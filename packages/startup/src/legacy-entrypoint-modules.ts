import type { OpenSumiProductRuntimePlan } from './product-runtime-plan';

export interface LegacyEntrypointModuleComposition<TModule> {
  readonly runtimePlan: OpenSumiProductRuntimePlan<TModule>;
  /**
   * The exact framework-owned module prefix used to compile `runtimePlan`.
   * Constructor identity makes a plan/common-module mismatch fail closed.
   */
  readonly frameworkModules: readonly TModule[];
  readonly beforeOptionalModules?: readonly TModule[];
  readonly afterOptionalModules?: readonly TModule[];
}

/**
 * Reuses a ProductProfile runtime plan without changing a legacy entrypoint's
 * integration-module positions. The plan owns framework and optional feature
 * order; product shells such as file serving, remote opener and samples remain
 * explicitly placed by the entrypoint.
 */
export function composeLegacyEntrypointModules<TModule>({
  runtimePlan,
  frameworkModules,
  beforeOptionalModules = [],
  afterOptionalModules = [],
}: LegacyEntrypointModuleComposition<TModule>): TModule[] {
  if (
    !Number.isSafeInteger(runtimePlan.frameworkEntryCount) ||
    runtimePlan.frameworkEntryCount < 0 ||
    runtimePlan.frameworkEntryCount > runtimePlan.entries.length
  ) {
    throw new Error(
      `Legacy entrypoint runtime plan has invalid framework entry count ${runtimePlan.frameworkEntryCount} ` +
        `for ${runtimePlan.entries.length} entries`,
    );
  }

  if (frameworkModules.length !== runtimePlan.frameworkEntryCount) {
    throw new Error(
      `Legacy entrypoint framework module count ${frameworkModules.length} does not match ` +
        `runtime plan framework entry count ${runtimePlan.frameworkEntryCount}`,
    );
  }

  for (let index = 0; index < runtimePlan.frameworkEntryCount; index++) {
    const planEntry = runtimePlan.entries[index];
    if (planEntry.module !== frameworkModules[index]) {
      throw new Error(
        `Legacy entrypoint framework module at index ${index} does not match runtime plan feature ${planEntry.featureId}`,
      );
    }
  }

  const optionalModules = runtimePlan.entries.slice(runtimePlan.frameworkEntryCount).map((entry) => entry.module);

  return [...frameworkModules, ...beforeOptionalModules, ...optionalModules, ...afterOptionalModules];
}
