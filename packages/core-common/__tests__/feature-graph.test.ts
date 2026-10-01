import {
  FeatureDefinition,
  FeatureGraphError,
  RuntimePlanContract,
  compileRuntimePlan,
  compileRuntimeTopology,
  defineFeature,
  defineFeatureFacet,
  defineProductProfile,
  defineRuntimePort,
  explainRuntimePlan,
  explainRuntimeTopology,
  fromLegacyModule,
  toRuntimePlanContract,
} from '../src/feature';

describe('FeatureGraph', () => {
  const core = defineFeature({
    id: 'opensumi.core',
    runtimes: ['browser', 'node'],
  });
  const files = defineFeature({
    id: 'opensumi.files',
    runtimes: ['browser', 'node'],
    requires: [core],
  });
  const search = defineFeature({
    id: 'opensumi.search',
    runtimes: ['browser', 'node'],
    requires: [files],
    critical: false,
  });

  it('compiles a deterministic runtime plan in dependency order', () => {
    expect.hasAssertions();
    const profile = defineProductProfile({
      id: 'opensumi.web',
      features: [search],
    });
    const plan = compileRuntimePlan(
      profile,
      [
        fromLegacyModule(search, 'browser', 'SearchModule', { scope: 'window' }),
        fromLegacyModule(core, 'browser', 'CoreModule', { scope: 'window' }),
        fromLegacyModule(files, 'browser', 'FilesModule', { scope: 'window' }),
      ],
      { runtime: 'browser' },
    );

    expect(plan.entries.map((entry) => entry.featureId)).toEqual([
      'opensumi.core',
      'opensumi.files',
      'opensumi.search',
    ]);
    expect(plan.entries[2]).toMatchObject({
      critical: false,
      dependencies: ['opensumi.files'],
      migrationState: 'legacy',
      legacy: true,
      module: 'SearchModule',
    });
  });

  it('adds enabled optional features in profile declaration order', () => {
    expect.hasAssertions();
    const ai = defineFeature({ id: 'opensumi.ai', runtimes: ['browser'] });
    const notebook = defineFeature({ id: 'opensumi.notebook', runtimes: ['browser'] });
    const profile = defineProductProfile({
      id: 'opensumi.full',
      features: [core],
      optionalFeatures: {
        ai: [ai],
        notebook: [notebook],
      },
    });
    const plan = compileRuntimePlan(
      profile,
      [
        fromLegacyModule(core, 'browser', 'CoreModule', { scope: 'window' }),
        fromLegacyModule(ai, 'browser', 'AIModule', { scope: 'window' }),
        fromLegacyModule(notebook, 'browser', 'NotebookModule', { scope: 'window' }),
      ],
      { runtime: 'browser', enabledOptions: ['notebook', 'ai'] },
    );

    expect(plan.enabledOptions).toEqual(['ai', 'notebook']);
    expect(plan.entries.map((entry) => entry.featureId)).toEqual(['opensumi.core', 'opensumi.ai', 'opensumi.notebook']);
  });

  it('rejects unknown profile options', () => {
    expect.hasAssertions();
    const profile = defineProductProfile({ id: 'opensumi.web', features: [core] });

    expect(() => compileRuntimePlan(profile, [], { runtime: 'browser', enabledOptions: ['missing'] })).toThrow(
      expect.objectContaining<Partial<FeatureGraphError>>({ code: 'UNKNOWN_OPTION' }),
    );
  });

  it('rejects misspelled runtime, scope, and migration-state values at runtime', () => {
    expect.hasAssertions();

    expect(() =>
      defineFeature({
        id: 'opensumi.invalid-runtime',
        runtimes: ['browesr' as 'browser'],
      }),
    ).toThrow(expect.objectContaining<Partial<FeatureGraphError>>({ code: 'INVALID_FEATURE_RUNTIME' }));
    expect(() =>
      defineRuntimePort({
        id: 'opensumi.invalid-scope',
        version: 1,
        scope: 'connnection' as 'connection',
      }),
    ).toThrow(expect.objectContaining<Partial<FeatureGraphError>>({ code: 'INVALID_RUNTIME_SCOPE' }));
    expect(() =>
      defineFeatureFacet({
        feature: core,
        runtime: 'browser',
        module: 'CoreModule',
        scope: 'window',
        migrationState: 'shdaow' as 'shadow',
      }),
    ).toThrow(expect.objectContaining<Partial<FeatureGraphError>>({ code: 'INVALID_MIGRATION_STATE' }));
  });

  it('reports the complete dependency cycle', () => {
    expect.hasAssertions();
    const a = { id: 'opensumi.a', runtimes: ['browser'] } as FeatureDefinition;
    const b = { id: 'opensumi.b', runtimes: ['browser'], requires: [a] } as FeatureDefinition;
    (a as { requires?: readonly FeatureDefinition[] }).requires = [b];
    const profile = defineProductProfile({ id: 'opensumi.cycle', features: [a] });

    expect(() => compileRuntimePlan(profile, [], { runtime: 'browser' })).toThrow(
      expect.objectContaining<Partial<FeatureGraphError>>({
        code: 'FEATURE_CYCLE',
        message: 'Feature dependency cycle: opensumi.a -> opensumi.b -> opensumi.a',
      }),
    );
  });

  it('requires a declared runtime facet', () => {
    expect.hasAssertions();
    const profile = defineProductProfile({ id: 'opensumi.web', features: [core] });

    expect(() => compileRuntimePlan(profile, [], { runtime: 'browser' })).toThrow(
      expect.objectContaining<Partial<FeatureGraphError>>({ code: 'MISSING_FACET' }),
    );
  });

  it('rejects runtime facets that are not selected by the product profile', () => {
    expect.hasAssertions();
    const detached = defineFeature({ id: 'opensumi.detached', runtimes: ['browser'] });
    const profile = defineProductProfile({ id: 'opensumi.web', features: [core] });

    expect(() =>
      compileRuntimePlan(
        profile,
        [
          fromLegacyModule(core, 'browser', 'CoreModule', { scope: 'window' }),
          fromLegacyModule(detached, 'browser', 'DetachedModule', { scope: 'window' }),
        ],
        { runtime: 'browser' },
      ),
    ).toThrow(expect.objectContaining<Partial<FeatureGraphError>>({ code: 'UNSELECTED_FACET' }));
  });

  it('rejects duplicate port providers in one runtime plan', () => {
    expect.hasAssertions();
    const searchPort = defineRuntimePort({
      id: 'opensumi.search.content',
      version: 1,
      scope: 'connection',
    });
    const searchMirror = defineFeature({ id: 'opensumi.search-mirror', runtimes: ['node'] });
    const profile = defineProductProfile({ id: 'opensumi.server', features: [search, searchMirror] });

    expect(() =>
      compileRuntimePlan(
        profile,
        [
          defineFeatureFacet({
            feature: core,
            runtime: 'node',
            module: 'CoreModule',
            scope: 'application',
          }),
          defineFeatureFacet({
            feature: files,
            runtime: 'node',
            module: 'FilesModule',
            scope: 'workspace',
          }),
          defineFeatureFacet({
            feature: search,
            runtime: 'node',
            module: 'SearchModule',
            scope: 'connection',
            provides: [searchPort],
          }),
          defineFeatureFacet({
            feature: searchMirror,
            runtime: 'node',
            module: 'SearchMirrorModule',
            scope: 'connection',
            provides: [searchPort],
          }),
        ],
        { runtime: 'node' },
      ),
    ).toThrow(expect.objectContaining<Partial<FeatureGraphError>>({ code: 'DUPLICATE_PORT_PROVIDER' }));
  });

  it('rejects a consumed port with no runtime provider', () => {
    expect.hasAssertions();
    const searchPort = defineRuntimePort({
      id: 'opensumi.search.content',
      version: 1,
      scope: 'connection',
    });
    const profile = defineProductProfile({ id: 'opensumi.server', features: [core] });

    expect(() =>
      compileRuntimePlan(
        profile,
        [
          defineFeatureFacet({
            feature: core,
            runtime: 'node',
            module: 'CoreModule',
            scope: 'application',
            consumes: [searchPort],
          }),
        ],
        { runtime: 'node' },
      ),
    ).toThrow(expect.objectContaining<Partial<FeatureGraphError>>({ code: 'MISSING_PORT_PROVIDER' }));
  });

  it('accepts a matching boundary port and rejects a mismatched contract', () => {
    expect.hasAssertions();
    const consumedPort = defineRuntimePort({
      id: 'opensumi.workspace.fs',
      version: 2,
      scope: 'connection',
    });
    const profile = defineProductProfile({ id: 'opensumi.server', features: [core] });
    const facets = [
      defineFeatureFacet({
        feature: core,
        runtime: 'node',
        module: 'CoreModule',
        scope: 'application',
        consumes: [consumedPort],
      }),
    ];

    expect(
      compileRuntimePlan(profile, facets, {
        runtime: 'node',
        boundaryRequirements: [{ providerRuntime: 'workspace-agent', port: consumedPort }],
      }).entries,
    ).toHaveLength(1);
    expect(() =>
      compileRuntimePlan(profile, facets, {
        runtime: 'node',
        boundaryRequirements: [
          {
            providerRuntime: 'workspace-agent',
            port: defineRuntimePort({
              id: consumedPort.id,
              version: 1,
              scope: consumedPort.scope,
            }),
          },
        ],
      }),
    ).toThrow(expect.objectContaining<Partial<FeatureGraphError>>({ code: 'PORT_CONTRACT_MISMATCH' }));
  });

  it('tracks shadow migration without claiming the legacy adapter is removed', () => {
    expect.hasAssertions();
    const profile = defineProductProfile({ id: 'opensumi.web', features: [core] });
    const plan = compileRuntimePlan(
      profile,
      [
        defineFeatureFacet({
          feature: core,
          runtime: 'browser',
          module: 'CoreModule',
          scope: 'window',
          migrationState: 'shadow',
          legacy: true,
        }),
      ],
      { runtime: 'browser' },
    );

    expect(plan.entries[0]).toMatchObject({ migrationState: 'shadow', legacy: true });
    expect(() =>
      defineFeatureFacet({
        feature: core,
        runtime: 'browser',
        module: 'CoreModule',
        scope: 'window',
        migrationState: 'shadow',
        legacy: false,
      }),
    ).toThrow(expect.objectContaining<Partial<FeatureGraphError>>({ code: 'MIGRATION_STATE_MISMATCH' }));
  });

  it('compiles a constructor-free topology and allows browser-only product options', () => {
    expect.hasAssertions();
    class SecretBrowserModule {}
    class SecretNodeModule {}
    const notebook = defineFeature({ id: 'opensumi.notebook', runtimes: ['browser'] });
    const diskPort = defineRuntimePort({
      id: 'opensumi.files.disk',
      version: 1,
      scope: 'connection',
      type: (value: { readonly path: string }) => value,
    });
    const profile = defineProductProfile({
      id: 'opensumi.full',
      features: [core],
      optionalFeatures: { notebook: [notebook] },
    });
    const browserPlan = compileRuntimePlan(
      profile,
      [
        defineFeatureFacet({
          feature: core,
          runtime: 'browser',
          module: SecretBrowserModule,
          scope: 'window',
          consumes: [diskPort],
        }),
        defineFeatureFacet({
          feature: notebook,
          runtime: 'browser',
          module: 'NotebookModule',
          scope: 'window',
        }),
      ],
      {
        runtime: 'browser',
        enabledOptions: ['notebook'],
        boundaryRequirements: [{ providerRuntime: 'node', port: diskPort }],
      },
    );
    const nodePlan = compileRuntimePlan(
      profile,
      [
        defineFeatureFacet({
          feature: core,
          runtime: 'node',
          module: SecretNodeModule,
          scope: 'application',
          provides: [diskPort],
        }),
      ],
      { runtime: 'node' },
    );

    const browserContract = toRuntimePlanContract(browserPlan);
    const nodeContract = toRuntimePlanContract(nodePlan);
    const topology = compileRuntimeTopology(profile, [nodeContract, browserContract]);

    expect(browserContract.entries[0]).toEqual({
      featureId: 'opensumi.core',
      provides: [],
      consumes: [{ id: 'opensumi.files.disk', version: 1, scope: 'connection' }],
    });
    expect(JSON.stringify([browserContract, nodeContract])).not.toMatch(/SecretBrowserModule|SecretNodeModule|"type"/);
    expect(topology).toEqual({
      profileId: 'opensumi.full',
      enabledOptions: ['notebook'],
      runtimes: [
        { runtime: 'browser', enabledOptions: ['notebook'] },
        { runtime: 'node', enabledOptions: [] },
      ],
      links: [
        {
          port: { id: 'opensumi.files.disk', version: 1, scope: 'connection' },
          consumerRuntime: 'browser',
          consumerFeatureIds: ['opensumi.core'],
          providerRuntime: 'node',
          providerFeatureId: 'opensumi.core',
        },
      ],
    });
    expect(explainRuntimeTopology(topology)).toBe(
      'profile=opensumi.full runtimes=browser,node options=notebook\n' +
        'opensumi.files.disk@1 scope=connection node:opensumi.core -> browser:opensumi.core',
    );
  });

  it('validates every runtime plan against the globally enabled optional dependency closure', () => {
    expect.hasAssertions();
    const nodeDependency = defineFeature({
      id: 'opensumi.optional.node-dependency',
      runtimes: ['node'],
    });
    const browserOption = defineFeature({
      id: 'opensumi.optional.browser-root',
      runtimes: ['browser'],
      requires: [nodeDependency],
    });
    const profile = defineProductProfile({
      id: 'opensumi.cross-runtime-option',
      features: [core],
      optionalFeatures: { inspector: [browserOption] },
    });
    const browserContract = toRuntimePlanContract(
      compileRuntimePlan(
        profile,
        [
          fromLegacyModule(core, 'browser', 'CoreBrowserModule', { scope: 'window' }),
          fromLegacyModule(browserOption, 'browser', 'InspectorBrowserModule', { scope: 'window' }),
        ],
        { runtime: 'browser', enabledOptions: ['inspector'] },
      ),
    );
    const nodeBaseContract = toRuntimePlanContract(
      compileRuntimePlan(profile, [fromLegacyModule(core, 'node', 'CoreNodeModule', { scope: 'application' })], {
        runtime: 'node',
      }),
    );

    expect(() => compileRuntimeTopology(profile, [browserContract, nodeBaseContract])).toThrow(
      expect.objectContaining<Partial<FeatureGraphError>>({
        code: 'MISSING_RUNTIME_PLAN_ENTRY',
        message: expect.stringContaining(nodeDependency.id),
      }),
    );

    const topology = compileRuntimeTopology(profile, [
      browserContract,
      {
        ...nodeBaseContract,
        entries: [...nodeBaseContract.entries, { featureId: nodeDependency.id, provides: [], consumes: [] }],
      },
    ]);

    expect(topology.enabledOptions).toEqual(['inspector']);
    expect(topology.runtimes).toEqual([
      { runtime: 'browser', enabledOptions: ['inspector'] },
      { runtime: 'node', enabledOptions: [] },
    ]);
  });

  it('rejects incomplete or drifting cross-runtime boundary contracts', () => {
    expect.hasAssertions();
    const diskPort = defineRuntimePort({
      id: 'opensumi.files.disk',
      version: 1,
      scope: 'connection',
    });
    const profile = defineProductProfile({ id: 'opensumi.default', features: [core] });
    const browserContract = toRuntimePlanContract(
      compileRuntimePlan(
        profile,
        [
          defineFeatureFacet({
            feature: core,
            runtime: 'browser',
            module: 'BrowserModule',
            scope: 'window',
            consumes: [diskPort],
          }),
        ],
        {
          runtime: 'browser',
          boundaryRequirements: [{ providerRuntime: 'node', port: diskPort }],
        },
      ),
    );
    const nodeContract = toRuntimePlanContract(
      compileRuntimePlan(
        profile,
        [
          defineFeatureFacet({
            feature: core,
            runtime: 'node',
            module: 'NodeModule',
            scope: 'application',
            provides: [diskPort],
          }),
        ],
        { runtime: 'node' },
      ),
    );

    expect(() =>
      compileRuntimeTopology(profile, [
        browserContract,
        {
          ...nodeContract,
          entries: nodeContract.entries.map((entry) => ({ ...entry, provides: [] })),
        },
      ]),
    ).toThrow(expect.objectContaining<Partial<FeatureGraphError>>({ code: 'MISSING_BOUNDARY_PORT_PROVIDER' }));
    expect(() =>
      compileRuntimeTopology(profile, [
        browserContract,
        {
          ...nodeContract,
          entries: nodeContract.entries.map((entry) => ({
            ...entry,
            provides: entry.provides.map((port) => ({ ...port, version: 2 })),
          })),
        },
      ]),
    ).toThrow(expect.objectContaining<Partial<FeatureGraphError>>({ code: 'PORT_CONTRACT_MISMATCH' }));
    expect(() =>
      compileRuntimeTopology(profile, [
        {
          ...browserContract,
          entries: browserContract.entries.map((entry) => ({
            ...entry,
            consumes: entry.consumes.map((port) => ({ ...port, version: 2 })),
          })),
        },
        nodeContract,
      ]),
    ).toThrow(expect.objectContaining<Partial<FeatureGraphError>>({ code: 'PORT_CONTRACT_MISMATCH' }));
    expect(() =>
      compileRuntimeTopology(profile, [
        {
          ...browserContract,
          boundaryRequirements: browserContract.boundaryRequirements.map((requirement) => ({
            ...requirement,
            providerRuntime: 'workspace-agent' as const,
          })),
        },
        nodeContract,
      ]),
    ).toThrow(expect.objectContaining<Partial<FeatureGraphError>>({ code: 'MISSING_BOUNDARY_RUNTIME' }));
    expect(() =>
      compileRuntimeTopology(profile, [
        {
          ...browserContract,
          entries: browserContract.entries.map((entry) => ({ ...entry, consumes: [] })),
        },
        nodeContract,
      ]),
    ).toThrow(expect.objectContaining<Partial<FeatureGraphError>>({ code: 'UNUSED_BOUNDARY_PORT' }));
  });

  it('rejects cross-runtime selection drift for options with facets on both runtimes', () => {
    expect.hasAssertions();
    const ai = defineFeature({ id: 'opensumi.ai', runtimes: ['browser', 'node'] });
    const profile = defineProductProfile({
      id: 'opensumi.ai-product',
      features: [core],
      optionalFeatures: { ai: [ai] },
    });
    const browserContract = toRuntimePlanContract(
      compileRuntimePlan(
        profile,
        [
          fromLegacyModule(core, 'browser', 'CoreBrowserModule', { scope: 'window' }),
          fromLegacyModule(ai, 'browser', 'AIBrowserModule', { scope: 'window' }),
        ],
        { runtime: 'browser', enabledOptions: ['ai'] },
      ),
    );
    const nodeContract = toRuntimePlanContract(
      compileRuntimePlan(profile, [fromLegacyModule(core, 'node', 'CoreNodeModule', { scope: 'application' })], {
        runtime: 'node',
      }),
    );

    expect(() => compileRuntimeTopology(profile, [browserContract, nodeContract])).toThrow(
      expect.objectContaining<Partial<FeatureGraphError>>({ code: 'RUNTIME_PLAN_OPTIONS_MISMATCH' }),
    );
  });

  it('rejects a topology that omits a mandatory runtime plan', () => {
    expect.hasAssertions();
    const profile = defineProductProfile({ id: 'opensumi.shared-product', features: [core] });
    const browserContract = toRuntimePlanContract(
      compileRuntimePlan(profile, [fromLegacyModule(core, 'browser', 'CoreBrowserModule', { scope: 'window' })], {
        runtime: 'browser',
      }),
    );

    expect(() => compileRuntimeTopology(profile, [browserContract])).toThrow(
      expect.objectContaining<Partial<FeatureGraphError>>({
        code: 'MISSING_RUNTIME_PLAN',
        message: expect.stringContaining('node'),
      }),
    );
  });

  it('rejects a topology that omits a runtime selected by a shared optional feature', () => {
    expect.hasAssertions();
    const shell = defineFeature({ id: 'opensumi.shell', runtimes: ['browser'] });
    const ai = defineFeature({ id: 'opensumi.ai', runtimes: ['browser', 'node'] });
    const profile = defineProductProfile({
      id: 'opensumi.ai-product',
      features: [shell],
      optionalFeatures: { ai: [ai] },
    });
    const browserContract = toRuntimePlanContract(
      compileRuntimePlan(
        profile,
        [
          fromLegacyModule(shell, 'browser', 'ShellBrowserModule', { scope: 'window' }),
          fromLegacyModule(ai, 'browser', 'AIBrowserModule', { scope: 'window' }),
        ],
        { runtime: 'browser', enabledOptions: ['ai'] },
      ),
    );

    expect(() => compileRuntimeTopology(profile, [browserContract])).toThrow(
      expect.objectContaining<Partial<FeatureGraphError>>({
        code: 'MISSING_RUNTIME_PLAN',
        message: expect.stringContaining('node'),
      }),
    );
  });

  it('rejects an extra empty runtime plan when the selected profile has no features for it', () => {
    expect.hasAssertions();
    const shell = defineFeature({ id: 'opensumi.shell', runtimes: ['browser'] });
    const profile = defineProductProfile({ id: 'opensumi.browser-product', features: [shell] });
    const browserContract = toRuntimePlanContract(
      compileRuntimePlan(profile, [fromLegacyModule(shell, 'browser', 'ShellBrowserModule', { scope: 'window' })], {
        runtime: 'browser',
      }),
    );
    const emptyNodeContract: RuntimePlanContract = {
      profileId: profile.id,
      runtime: 'node',
      enabledOptions: [],
      boundaryRequirements: [],
      entries: [],
    };

    expect(() => compileRuntimeTopology(profile, [browserContract, emptyNodeContract])).toThrow(
      expect.objectContaining<Partial<FeatureGraphError>>({
        code: 'UNEXPECTED_RUNTIME_PLAN',
        message: expect.stringContaining('node'),
      }),
    );
  });

  it('rejects stale or forged feature ids in a runtime plan contract', () => {
    expect.hasAssertions();
    const profile = defineProductProfile({ id: 'opensumi.default', features: [core] });
    const browserContract = toRuntimePlanContract(
      compileRuntimePlan(profile, [fromLegacyModule(core, 'browser', 'CoreBrowserModule', { scope: 'window' })], {
        runtime: 'browser',
      }),
    );

    expect(() =>
      compileRuntimeTopology(profile, [
        {
          ...browserContract,
          entries: browserContract.entries.map((entry) => ({ ...entry, featureId: 'opensumi.stale-core' })),
        },
      ]),
    ).toThrow(expect.objectContaining<Partial<FeatureGraphError>>({ code: 'UNEXPECTED_RUNTIME_PLAN_ENTRY' }));
  });

  it('rejects a runtime plan contract that omits a mandatory feature', () => {
    expect.hasAssertions();
    const profile = defineProductProfile({ id: 'opensumi.default', features: [core] });
    const browserContract = toRuntimePlanContract(
      compileRuntimePlan(profile, [fromLegacyModule(core, 'browser', 'CoreBrowserModule', { scope: 'window' })], {
        runtime: 'browser',
      }),
    );

    expect(() => compileRuntimeTopology(profile, [{ ...browserContract, entries: [] }])).toThrow(
      expect.objectContaining<Partial<FeatureGraphError>>({ code: 'MISSING_RUNTIME_PLAN_ENTRY' }),
    );
  });

  it('rejects a runtime plan contract that claims an option but omits its feature entry', () => {
    expect.hasAssertions();
    const ai = defineFeature({ id: 'opensumi.ai', runtimes: ['browser'] });
    const profile = defineProductProfile({
      id: 'opensumi.ai-product',
      features: [core],
      optionalFeatures: { ai: [ai] },
    });
    const browserContract = toRuntimePlanContract(
      compileRuntimePlan(
        profile,
        [
          fromLegacyModule(core, 'browser', 'CoreBrowserModule', { scope: 'window' }),
          fromLegacyModule(ai, 'browser', 'AIBrowserModule', { scope: 'window' }),
        ],
        { runtime: 'browser', enabledOptions: ['ai'] },
      ),
    );

    expect(() =>
      compileRuntimeTopology(profile, [
        {
          ...browserContract,
          entries: browserContract.entries.filter((entry) => entry.featureId !== ai.id),
        },
      ]),
    ).toThrow(expect.objectContaining<Partial<FeatureGraphError>>({ code: 'MISSING_RUNTIME_PLAN_ENTRY' }));
  });

  it('rejects a runtime plan contract with an incomplete required-feature closure', () => {
    expect.hasAssertions();
    const profile = defineProductProfile({ id: 'opensumi.search-product', features: [search] });
    const browserContract = toRuntimePlanContract(
      compileRuntimePlan(
        profile,
        [
          fromLegacyModule(core, 'browser', 'CoreBrowserModule', { scope: 'window' }),
          fromLegacyModule(files, 'browser', 'FilesBrowserModule', { scope: 'window' }),
          fromLegacyModule(search, 'browser', 'SearchBrowserModule', { scope: 'window' }),
        ],
        { runtime: 'browser' },
      ),
    );

    expect(() =>
      compileRuntimeTopology(profile, [
        {
          ...browserContract,
          entries: browserContract.entries.filter((entry) => entry.featureId !== files.id),
        },
      ]),
    ).toThrow(
      expect.objectContaining<Partial<FeatureGraphError>>({
        code: 'MISSING_RUNTIME_PLAN_ENTRY',
        message: expect.stringContaining(files.id),
      }),
    );
  });

  it('requires runtime plan entries to preserve the canonical dependency order', () => {
    expect.hasAssertions();
    const browserCore = defineFeature({ id: 'opensumi.browser-core', runtimes: ['browser'] });
    const browserFiles = defineFeature({
      id: 'opensumi.browser-files',
      runtimes: ['browser'],
      requires: [browserCore],
    });
    const browserSearch = defineFeature({
      id: 'opensumi.browser-search',
      runtimes: ['browser'],
      requires: [browserFiles],
    });
    const profile = defineProductProfile({ id: 'opensumi.search-product', features: [browserSearch] });
    const browserContract = toRuntimePlanContract(
      compileRuntimePlan(
        profile,
        [
          fromLegacyModule(browserSearch, 'browser', 'SearchBrowserModule', { scope: 'window' }),
          fromLegacyModule(browserCore, 'browser', 'CoreBrowserModule', { scope: 'window' }),
          fromLegacyModule(browserFiles, 'browser', 'FilesBrowserModule', { scope: 'window' }),
        ],
        { runtime: 'browser' },
      ),
    );

    expect(() => compileRuntimeTopology(profile, [browserContract])).not.toThrow();
    expect(() =>
      compileRuntimeTopology(profile, [
        { ...browserContract, entries: [...browserContract.entries, browserContract.entries[0]] },
      ]),
    ).toThrow(expect.objectContaining<Partial<FeatureGraphError>>({ code: 'DUPLICATE_RUNTIME_PLAN_ENTRY' }));
    expect(() =>
      compileRuntimeTopology(profile, [{ ...browserContract, entries: [...browserContract.entries].reverse() }]),
    ).toThrow(
      expect.objectContaining<Partial<FeatureGraphError>>({
        code: 'RUNTIME_PLAN_ENTRY_ORDER_MISMATCH',
        message: expect.stringContaining('opensumi.browser-core, opensumi.browser-files, opensumi.browser-search'),
      }),
    );
  });

  it('rejects unselected optional and wrong-runtime feature entries', () => {
    expect.hasAssertions();
    const ai = defineFeature({ id: 'opensumi.ai', runtimes: ['browser'] });
    const nodeOnly = defineFeature({ id: 'opensumi.node-only', runtimes: ['node'] });
    const profile = defineProductProfile({
      id: 'opensumi.runtime-product',
      features: [core, nodeOnly],
      optionalFeatures: { ai: [ai] },
    });
    const browserContract = toRuntimePlanContract(
      compileRuntimePlan(profile, [fromLegacyModule(core, 'browser', 'CoreBrowserModule', { scope: 'window' })], {
        runtime: 'browser',
      }),
    );

    for (const unexpectedFeatureId of [ai.id, nodeOnly.id]) {
      expect(() =>
        compileRuntimeTopology(profile, [
          {
            ...browserContract,
            entries: [...browserContract.entries, { featureId: unexpectedFeatureId, provides: [], consumes: [] }],
          },
        ]),
      ).toThrow(expect.objectContaining<Partial<FeatureGraphError>>({ code: 'UNEXPECTED_RUNTIME_PLAN_ENTRY' }));
    }
  });

  it('explains the compiled plan without depending on module implementation details', () => {
    expect.hasAssertions();
    const profile = defineProductProfile({ id: 'opensumi.web', features: [core] });
    const plan = compileRuntimePlan(
      profile,
      [fromLegacyModule(core, 'browser', class CoreModule {}, { scope: 'window' })],
      { runtime: 'browser' },
    );

    expect(explainRuntimePlan(plan)).toBe(
      'profile=opensumi.web runtime=browser\n' +
        'opensumi.core scope=window critical=true migration=legacy legacy=true',
    );
  });
});
