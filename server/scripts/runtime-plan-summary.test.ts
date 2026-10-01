import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { summarizeRuntimePlan } from '../src/runtime-plan-summary';

import type { RuntimePlan, RuntimePlanEntry } from '@opensumi/ide-core-node';

describe('runtime plan health summary', () => {
  it('copies only JSON-safe plan metadata and keeps the snapshot stable', () => {
    const dependencies = ['opensumi.platform.core'];
    const enabledOptions = ['ai'];
    const entries: RuntimePlanEntry<unknown>[] = [
      {
        featureId: 'opensumi.ai.native',
        dependencies,
        module: { secretModuleImplementation: true },
        scope: 'application',
        critical: true,
        migrationState: 'legacy',
        legacy: true,
        provides: [
          {
            id: 'secret.runtime.port',
            version: 1,
            scope: 'application',
            type: (value) => value,
          },
        ],
        consumes: [],
      },
    ];
    const plan: RuntimePlan<unknown> = {
      profileId: 'opensumi.default',
      runtime: 'node',
      enabledOptions,
      boundaryRequirements: [],
      entries,
    };

    const summary = summarizeRuntimePlan(plan, { includeFeatures: true });
    enabledOptions.push('collaboration');
    dependencies.push('late.dependency');
    entries.push({ ...entries[0], featureId: 'late.feature' });

    assert.deepEqual(summary, {
      profileId: 'opensumi.default',
      runtime: 'node',
      enabledOptions: ['ai'],
      featureCount: 1,
      legacyFeatureCount: 1,
      declaredFeatureCount: 0,
      shadowFeatureCount: 0,
      enabledFeatureCount: 0,
      criticalFeatureCount: 1,
      features: [
        {
          id: 'opensumi.ai.native',
          scope: 'application',
          critical: true,
          migrationState: 'legacy',
          legacy: true,
          dependencies: ['opensumi.platform.core'],
        },
      ],
    });
    const serialized = JSON.stringify(summary);
    assert.doesNotMatch(serialized, /secretModuleImplementation|secret\.runtime\.port|provides|consumes/);
  });

  it('omits feature details unless diagnostics explicitly enable them', () => {
    const summary = summarizeRuntimePlan({
      profileId: 'opensumi.default',
      runtime: 'node',
      enabledOptions: [],
      boundaryRequirements: [],
      entries: [],
    });

    assert.equal('features' in summary, false);
    assert.equal(summary.featureCount, 0);
  });

  it('distinguishes declared contracts from real shadow execution', () => {
    const summary = summarizeRuntimePlan({
      profileId: 'opensumi.default',
      runtime: 'node',
      enabledOptions: [],
      boundaryRequirements: [],
      entries: [
        {
          featureId: 'opensumi.files.service',
          dependencies: [],
          module: class FileServiceModule {},
          scope: 'application',
          critical: true,
          migrationState: 'declared',
          legacy: true,
          provides: [],
          consumes: [],
        },
      ],
    });

    assert.equal(summary.legacyFeatureCount, 0);
    assert.equal(summary.declaredFeatureCount, 1);
    assert.equal(summary.shadowFeatureCount, 0);
    assert.equal(summary.enabledFeatureCount, 0);
  });
});
