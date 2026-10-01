import {
  RUNTIME_TOPOLOGY_CONTRACT_LIMITS,
  RuntimeTopologyContractError,
  assertRuntimeTopologyContract,
  compileRuntimePlan,
  compileRuntimeTopologyContract,
  defineFeature,
  defineFeatureFacet,
  defineProductProfile,
  defineRuntimePort,
  digestRuntimePlanContract,
  digestRuntimeTopologyContract,
  isRuntimeTopologyContract,
  normalizeRuntimePlanContract,
  parseRuntimePlanContract,
  parseRuntimeTopologyContract,
  serializeRuntimePlanContract,
  serializeRuntimeTopologyContract,
  toRuntimePlanContract,
} from '../src/feature';

import type { RuntimePlanContract, RuntimeTopologyContractV1 } from '../src/feature';

function expectContractError(action: () => unknown, code: RuntimeTopologyContractError['code'], path?: string): void {
  try {
    action();
    throw new Error(`Expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(RuntimeTopologyContractError);
    expect(error).toMatchObject({ code, ...(path ? { path } : {}) });
  }
}

function createGoldenPlans(moduleSuffix = 'one'): {
  profile: ReturnType<typeof defineProductProfile>;
  plans: RuntimePlanContract[];
} {
  const core = defineFeature({ id: 'opensumi.core', runtimes: ['browser', 'node'] });
  const diskPort = defineRuntimePort({
    id: 'opensumi.files.disk',
    version: 1,
    scope: 'connection',
    type: (value: { readonly path: string }) => value,
  });
  const profile = defineProductProfile({ id: 'opensumi.default', features: [core] });
  class SecretBrowserModule {}
  class SecretNodeModule {}
  const browserPlan = compileRuntimePlan(
    profile,
    [
      defineFeatureFacet({
        feature: core,
        runtime: 'browser',
        module: { constructor: SecretBrowserModule, moduleSuffix },
        scope: 'window',
        consumes: [diskPort],
      }),
    ],
    {
      runtime: 'browser',
      boundaryRequirements: [{ providerRuntime: 'node', port: diskPort }],
    },
  );
  const nodePlan = compileRuntimePlan(
    profile,
    [
      defineFeatureFacet({
        feature: core,
        runtime: 'node',
        module: { constructor: SecretNodeModule, moduleSuffix },
        scope: 'application',
        provides: [diskPort],
      }),
    ],
    { runtime: 'node' },
  );

  return {
    profile,
    plans: [toRuntimePlanContract(nodePlan), toRuntimePlanContract(browserPlan)],
  };
}

function createPermutationPlans(options: {
  reverseBoundaries?: boolean;
  reversePorts?: boolean;
  nodeRepeatsBrowserOnlyOption?: boolean;
}): {
  profile: ReturnType<typeof defineProductProfile>;
  plans: RuntimePlanContract[];
} {
  const core = defineFeature({ id: 'opensumi.core', runtimes: ['browser', 'node'] });
  const notebook = defineFeature({ id: 'opensumi.notebook', runtimes: ['browser'] });
  const firstPort = defineRuntimePort({ id: 'opensumi.port.first', version: 1, scope: 'connection' });
  const secondPort = defineRuntimePort({ id: 'opensumi.port.second', version: 1, scope: 'session' });
  const profile = defineProductProfile({
    id: 'opensumi.full',
    features: [core],
    optionalFeatures: { notebook: [notebook] },
  });
  const ports = options.reversePorts ? [secondPort, firstPort] : [firstPort, secondPort];
  const boundaries = [
    { providerRuntime: 'node' as const, port: firstPort },
    { providerRuntime: 'node' as const, port: secondPort },
  ];
  if (options.reverseBoundaries) {
    boundaries.reverse();
  }

  const browserPlan = compileRuntimePlan(
    profile,
    [
      defineFeatureFacet({
        feature: core,
        runtime: 'browser',
        module: 'BrowserCoreModule',
        scope: 'window',
        consumes: ports,
      }),
      defineFeatureFacet({
        feature: notebook,
        runtime: 'browser',
        module: 'NotebookModule',
        scope: 'window',
      }),
    ],
    { runtime: 'browser', enabledOptions: ['notebook'], boundaryRequirements: boundaries },
  );
  const nodePlan = compileRuntimePlan(
    profile,
    [
      defineFeatureFacet({
        feature: core,
        runtime: 'node',
        module: 'NodeCoreModule',
        scope: 'application',
        provides: ports,
      }),
    ],
    {
      runtime: 'node',
      enabledOptions: options.nodeRepeatsBrowserOnlyOption ? ['notebook'] : [],
    },
  );

  return {
    profile,
    plans: [toRuntimePlanContract(browserPlan), toRuntimePlanContract(nodePlan)],
  };
}

describe('RuntimeTopologyContract', () => {
  it('strictly normalizes, serializes, parses, and digests one runtime plan', () => {
    expect.hasAssertions();
    const { plans } = createGoldenPlans();
    const browserPlan = plans.find((plan) => plan.runtime === 'browser')!;
    const normalized = normalizeRuntimePlanContract(browserPlan);
    const serialized = serializeRuntimePlanContract(browserPlan);

    expect(normalized).toEqual(browserPlan);
    expect(serialized).toBe(
      '{"profileId":"opensumi.default","runtime":"browser","enabledOptions":[],"boundaryRequirements":[{"providerRuntime":"node","port":{"id":"opensumi.files.disk","version":1,"scope":"connection"}}],"entries":[{"featureId":"opensumi.core","provides":[],"consumes":[{"id":"opensumi.files.disk","version":1,"scope":"connection"}]}]}',
    );
    expect(parseRuntimePlanContract(serialized)).toEqual(normalized);
    expect(digestRuntimePlanContract(browserPlan)).toBe(
      'v1:sha256:e46e26ad3e7d1fe50b08214cd8d97867ea75f51ff97634c1998c8ebdcc8583c1',
    );

    const reversedOptionOrder = normalizeRuntimePlanContract({
      ...browserPlan,
      enabledOptions: ['notebook', 'ai'],
    });
    expect(reversedOptionOrder.enabledOptions).toEqual(['notebook', 'ai']);
  });

  it('normalizes plan sets while preserving behaviorally significant entry order', () => {
    expect.hasAssertions();
    const canonical = createPermutationPlans({});
    const permuted = createPermutationPlans({ reverseBoundaries: true, reversePorts: true });
    const canonicalBrowser = canonical.plans.find((plan) => plan.runtime === 'browser')!;
    const permutedBrowser = permuted.plans.find((plan) => plan.runtime === 'browser')!;

    expect(serializeRuntimePlanContract(permutedBrowser)).toBe(serializeRuntimePlanContract(canonicalBrowser));
    expect(digestRuntimePlanContract(permutedBrowser)).toBe(digestRuntimePlanContract(canonicalBrowser));

    const reversedEntries = { ...canonicalBrowser, entries: [...canonicalBrowser.entries].reverse() };
    expect(normalizeRuntimePlanContract(reversedEntries).entries.map((entry) => entry.featureId)).toEqual(
      reversedEntries.entries.map((entry) => entry.featureId),
    );
    expect(digestRuntimePlanContract(reversedEntries)).not.toBe(digestRuntimePlanContract(canonicalBrowser));
  });

  it('strictly rejects malformed, oversized, extended, and duplicate-provider plans', () => {
    expect.hasAssertions();
    const { plans } = createGoldenPlans();
    const browserPlan = plans.find((plan) => plan.runtime === 'browser')!;

    expectContractError(
      () => normalizeRuntimePlanContract({ ...browserPlan, futureField: true }),
      'UNKNOWN_KEY',
      '$.futureField',
    );
    expectContractError(
      () => parseRuntimePlanContract(' '.repeat(RUNTIME_TOPOLOGY_CONTRACT_LIMITS.maxBytes + 1)),
      'LIMIT_EXCEEDED',
      '$',
    );
    expectContractError(
      () =>
        normalizeRuntimePlanContract({
          ...browserPlan,
          entries: browserPlan.entries.map((entry) => ({ ...entry, provides: [...entry.consumes] })),
        }),
      'DUPLICATE_PORT',
      '$.entries[0].provides[0]',
    );
    expectContractError(
      () =>
        parseRuntimePlanContract(
          JSON.stringify({
            ...browserPlan,
            boundaryRequirements: browserPlan.boundaryRequirements.map((requirement) => ({
              ...requirement,
              port: { ...requirement.port, implementation: 'secret' },
            })),
          }),
        ),
      'UNKNOWN_KEY',
      '$.boundaryRequirements[0].port.implementation',
    );
  });

  it('creates a constructor-free versioned contract and stable SHA-256 digest', () => {
    expect.hasAssertions();
    const { profile, plans } = createGoldenPlans();
    const contract = compileRuntimeTopologyContract(profile, plans);
    const serialized = serializeRuntimeTopologyContract(contract);

    expect(contract).toEqual({
      kind: 'opensumi.runtime-topology',
      version: 1,
      profileId: 'opensumi.default',
      enabledOptions: [],
      runtimes: [
        {
          runtime: 'browser',
          boundaryRequirements: [
            {
              providerRuntime: 'node',
              port: { id: 'opensumi.files.disk', version: 1, scope: 'connection' },
            },
          ],
          entries: [
            {
              featureId: 'opensumi.core',
              provides: [],
              consumes: [{ id: 'opensumi.files.disk', version: 1, scope: 'connection' }],
            },
          ],
        },
        {
          runtime: 'node',
          boundaryRequirements: [],
          entries: [
            {
              featureId: 'opensumi.core',
              provides: [{ id: 'opensumi.files.disk', version: 1, scope: 'connection' }],
              consumes: [],
            },
          ],
        },
      ],
    });
    expect(serialized).toBe(
      '{"kind":"opensumi.runtime-topology","version":1,"profileId":"opensumi.default","enabledOptions":[],"runtimes":[{"runtime":"browser","boundaryRequirements":[{"providerRuntime":"node","port":{"id":"opensumi.files.disk","version":1,"scope":"connection"}}],"entries":[{"featureId":"opensumi.core","provides":[],"consumes":[{"id":"opensumi.files.disk","version":1,"scope":"connection"}]}]},{"runtime":"node","boundaryRequirements":[],"entries":[{"featureId":"opensumi.core","provides":[{"id":"opensumi.files.disk","version":1,"scope":"connection"}],"consumes":[]}]}]}',
    );
    expect(serialized).not.toMatch(/SecretBrowserModule|SecretNodeModule|moduleSuffix|"type"/);
    expect(digestRuntimeTopologyContract(contract)).toBe(
      'v1:sha256:393843115785f2b3c1024299dd35f345f8b26692c232a06cdee1c068fc4b1282',
    );
    expect(parseRuntimeTopologyContract(serialized)).toEqual(contract);
    expect(isRuntimeTopologyContract(contract)).toBe(true);
  });

  it('normalizes set-like arrays and ignores options irrelevant to a runtime', () => {
    expect.hasAssertions();
    const canonical = createPermutationPlans({});
    const permuted = createPermutationPlans({
      reverseBoundaries: true,
      reversePorts: true,
      nodeRepeatsBrowserOnlyOption: true,
    });
    const canonicalContract = compileRuntimeTopologyContract(canonical.profile, canonical.plans);
    const permutedContract = compileRuntimeTopologyContract(permuted.profile, permuted.plans);

    expect(serializeRuntimeTopologyContract(permutedContract)).toBe(
      serializeRuntimeTopologyContract(canonicalContract),
    );
    expect(digestRuntimeTopologyContract(permutedContract)).toBe(digestRuntimeTopologyContract(canonicalContract));
    expect(permutedContract.runtimes).not.toContainEqual(
      expect.objectContaining({ enabledOptions: expect.anything() }),
    );
    expect(permutedContract.runtimes[0].boundaryRequirements.map(({ port }) => port.id)).toEqual([
      'opensumi.port.first',
      'opensumi.port.second',
    ]);
  });

  it('keeps the complete feature inventory in the digest but ignores constructor identity', () => {
    expect.hasAssertions();
    const first = createGoldenPlans('first');
    const second = createGoldenPlans('second');
    const firstDigest = digestRuntimeTopologyContract(compileRuntimeTopologyContract(first.profile, first.plans));
    const secondDigest = digestRuntimeTopologyContract(compileRuntimeTopologyContract(second.profile, second.plans));

    const core = defineFeature({ id: 'opensumi.core', runtimes: ['browser', 'node'] });
    const localFeature = defineFeature({ id: 'opensumi.local-extra', runtimes: ['browser'] });
    const driftedProfile = defineProductProfile({ id: 'opensumi.default', features: [core, localFeature] });
    const driftedBrowser = compileRuntimePlan(
      driftedProfile,
      [
        defineFeatureFacet({ feature: core, runtime: 'browser', module: 'Core', scope: 'window' }),
        defineFeatureFacet({ feature: localFeature, runtime: 'browser', module: 'Extra', scope: 'window' }),
      ],
      { runtime: 'browser' },
    );
    const driftedNode = compileRuntimePlan(
      driftedProfile,
      [defineFeatureFacet({ feature: core, runtime: 'node', module: 'Core', scope: 'application' })],
      { runtime: 'node' },
    );
    const driftedDigest = digestRuntimeTopologyContract(
      compileRuntimeTopologyContract(driftedProfile, [
        toRuntimePlanContract(driftedBrowser),
        toRuntimePlanContract(driftedNode),
      ]),
    );

    expect(secondDigest).toBe(firstDigest);
    expect(driftedDigest).not.toBe(firstDigest);
    expect(driftedDigest).toMatch(/^v1:sha256:[a-f0-9]{64}$/);
  });

  it('rejects unknown keys, unsupported versions, non-canonical order, and duplicate ports', () => {
    expect.hasAssertions();
    const { profile, plans } = createGoldenPlans();
    const contract = compileRuntimeTopologyContract(profile, plans);

    expectContractError(
      () => assertRuntimeTopologyContract({ ...contract, futureField: true }),
      'UNKNOWN_KEY',
      '$.futureField',
    );
    expectContractError(
      () => assertRuntimeTopologyContract({ ...contract, version: 2 }),
      'UNSUPPORTED_VERSION',
      '$.version',
    );
    expectContractError(
      () => assertRuntimeTopologyContract({ ...contract, runtimes: [...contract.runtimes].reverse() }),
      'NON_CANONICAL_ORDER',
      '$.runtimes[1]',
    );
    expect(isRuntimeTopologyContract({ ...contract, kind: 'opensumi.other' })).toBe(false);

    const browserPlan = plans.find((plan) => plan.runtime === 'browser')!;
    const duplicatedConsumer: RuntimePlanContract = {
      ...browserPlan,
      entries: browserPlan.entries.map((entry) => ({
        ...entry,
        consumes: [...entry.consumes, ...entry.consumes],
      })),
    };
    expectContractError(
      () =>
        compileRuntimeTopologyContract(profile, [duplicatedConsumer, plans.find((plan) => plan.runtime === 'node')!]),
      'DUPLICATE_PORT',
      '$runtimePlans[0].entries[0].consumes[1]',
    );
  });

  it('enforces byte and array-count limits before accepting wire data', () => {
    expect.hasAssertions();
    const { profile, plans } = createGoldenPlans();
    const contract = compileRuntimeTopologyContract(profile, plans);

    expectContractError(
      () => parseRuntimeTopologyContract(' '.repeat(RUNTIME_TOPOLOGY_CONTRACT_LIMITS.maxBytes + 1)),
      'LIMIT_EXCEEDED',
      '$',
    );
    expectContractError(() => parseRuntimeTopologyContract('{'), 'INVALID_JSON', '$');
    expectContractError(
      () =>
        assertRuntimeTopologyContract({
          ...contract,
          runtimes: Array.from({ length: RUNTIME_TOPOLOGY_CONTRACT_LIMITS.maxRuntimes + 1 }, () => ({})),
        }),
      'LIMIT_EXCEEDED',
      '$.runtimes',
    );
    expectContractError(
      () =>
        assertRuntimeTopologyContract({
          ...contract,
          runtimes: [
            {
              ...contract.runtimes[0],
              entries: Array.from(
                { length: RUNTIME_TOPOLOGY_CONTRACT_LIMITS.maxEntriesPerRuntime + 1 },
                (_, index) => ({ featureId: `opensumi.feature.${index}`, provides: [], consumes: [] }),
              ),
            },
          ],
        }),
      'LIMIT_EXCEEDED',
      '$.runtimes[0].entries',
    );
  });

  it('runs whole-topology validation before projecting or inspecting extra contract keys', () => {
    expect.hasAssertions();
    const { profile, plans } = createPermutationPlans({});
    const browserPlan = plans.find((plan) => plan.runtime === 'browser')!;
    const reorderedAndExtended = {
      ...browserPlan,
      entries: [...browserPlan.entries].reverse(),
      futureField: true,
    } as RuntimePlanContract;

    expect(() =>
      compileRuntimeTopologyContract(profile, [reorderedAndExtended, plans.find((plan) => plan.runtime === 'node')!]),
    ).toThrow(expect.objectContaining({ code: 'RUNTIME_PLAN_ENTRY_ORDER_MISMATCH' }));
  });

  it('canonicalizes object key insertion order when parsing and serializing', () => {
    expect.hasAssertions();
    const { profile, plans } = createGoldenPlans();
    const contract = compileRuntimeTopologyContract(profile, plans);
    const reorderedKeys = {
      runtimes: contract.runtimes,
      enabledOptions: contract.enabledOptions,
      profileId: contract.profileId,
      version: contract.version,
      kind: contract.kind,
    } as RuntimeTopologyContractV1;

    expect(serializeRuntimeTopologyContract(reorderedKeys)).toBe(serializeRuntimeTopologyContract(contract));
    expect(parseRuntimeTopologyContract(JSON.stringify(reorderedKeys))).toEqual(contract);
  });
});
