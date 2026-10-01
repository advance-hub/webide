import { FeatureGraphError, compileRuntimeTopology, toRuntimePlanContract } from '@opensumi/ide-core-common';
import { ExtensionHostControlRuntimePort } from '@opensumi/ide-extension';
import { DiskFileServiceRuntimePort } from '@opensumi/ide-file-service';
import { ProcessFactoryRuntimePort } from '@opensumi/ide-process';

import { compileLegacyRuntimePlan } from '../../src/legacy-runtime-plan';
import {
  CommonBrowserFeatures,
  CommonNodeFeatures,
  ExtensionFeature,
  OpenSumiDefaultProductProfile,
  OptionalBrowserFeatures,
  OptionalNodeFeatures,
  ProcessFeature,
} from '../../src/product-profile';
import { compileOpenSumiProductRuntimePlan } from '../../src/product-runtime-plan';
import { CommonBrowserFacetOptions, CommonNodeFacetOptions } from '../../src/runtime-facets';

describe('OpenSumiDefaultProductProfile', () => {
  it('keeps module identity bound to features even when catalogs are reordered', () => {
    expect.hasAssertions();
    const commonBindings = CommonNodeFeatures.map((feature) => ({ feature, module: { id: feature.id } }));
    const aiBindings = OptionalNodeFeatures.ai.map((feature) => ({ feature, module: { id: feature.id } }));
    const collaborationBindings = OptionalNodeFeatures.collaboration.map((feature) => ({
      feature,
      module: { id: feature.id },
    }));
    const plan = compileOpenSumiProductRuntimePlan({
      runtime: 'node',
      commonBindings: [...commonBindings].reverse(),
      options: [
        { id: 'collaboration', bindings: collaborationBindings },
        { id: 'ai', bindings: aiBindings },
      ],
    });
    expect(plan.entries.map((entry) => entry.module)).toEqual(
      [...commonBindings, ...aiBindings, ...collaborationBindings].map((binding) => binding.module),
    );
    expect(plan.entries.every((entry) => entry.module.id === entry.featureId)).toBe(true);
  });

  it('rejects missing, duplicate and foreign feature bindings before startup', () => {
    expect.hasAssertions();
    const commonBindings = CommonNodeFeatures.map((feature) => ({ feature, module: { id: feature.id } }));
    expect(() =>
      compileOpenSumiProductRuntimePlan({ runtime: 'node', commonBindings: commonBindings.slice(1) }),
    ).toThrow('Missing feature binding');
    expect(() =>
      compileOpenSumiProductRuntimePlan({ runtime: 'node', commonBindings: [...commonBindings, commonBindings[0]] }),
    ).toThrow('Invalid or duplicate feature binding');
    expect(() =>
      compileOpenSumiProductRuntimePlan({
        runtime: 'node',
        commonBindings,
        options: [
          { id: 'ai', bindings: [{ feature: OptionalNodeFeatures.collaboration[0], module: { id: 'wrong' } }] },
        ],
      }),
    ).toThrow('Invalid or duplicate feature binding');
  });

  it('declares the optional product surface in canonical order', () => {
    expect.hasAssertions();

    expect(Object.keys(OpenSumiDefaultProductProfile.optionalFeatures || {})).toEqual([
      'ai',
      'notebook',
      'collaboration',
    ]);
    expect(
      Object.fromEntries(
        Object.entries(OpenSumiDefaultProductProfile.optionalFeatures || {}).map(([option, features]) => [
          option,
          features.map((feature) => ({ id: feature.id, runtimes: feature.runtimes })),
        ]),
      ),
    ).toEqual({
      ai: [
        { id: 'opensumi.ai.design', runtimes: ['browser'] },
        { id: 'opensumi.ai.native', runtimes: ['browser', 'node'] },
      ],
      notebook: [{ id: 'opensumi.notebook', runtimes: ['browser'] }],
      collaboration: [{ id: 'opensumi.collaboration', runtimes: ['browser', 'node'] }],
    });
  });

  it.each([
    ['browser', CommonBrowserFeatures],
    ['node', CommonNodeFeatures],
  ] as const)('preserves the legacy %s feature sequence', (runtime, expectedFeatures) => {
    expect.hasAssertions();
    const runtimeFeatures = OpenSumiDefaultProductProfile.features.filter((feature) =>
      feature.runtimes.includes(runtime),
    );

    expect(runtimeFeatures).toEqual(expectedFeatures);
  });

  it('uses one definition object for every stable feature id', () => {
    expect.hasAssertions();
    const definitions = new Map<string, (typeof OpenSumiDefaultProductProfile.features)[number]>();
    const allFeatures = [
      ...OpenSumiDefaultProductProfile.features,
      ...Object.values(OpenSumiDefaultProductProfile.optionalFeatures || {}).flat(),
    ];

    for (const feature of allFeatures) {
      const existing = definitions.get(feature.id);
      expect(existing === undefined || existing === feature).toBe(true);
      definitions.set(feature.id, feature);
    }
  });

  it('declares capability dependencies without changing legacy order', () => {
    expect.hasAssertions();
    const features = new Map(OpenSumiDefaultProductProfile.features.map((feature) => [feature.id, feature]));

    expect(features.get('opensumi.files.search')?.requires?.map((feature) => feature.id)).toEqual([
      'opensumi.files.service',
      'opensumi.process',
    ]);
    expect(features.get('opensumi.search')?.requires?.map((feature) => feature.id)).toEqual([
      'opensumi.files.service',
      'opensumi.process',
    ]);
    expect(features.get('opensumi.extensions.marketplace')?.requires?.map((feature) => feature.id)).toEqual([
      'opensumi.extensions',
    ]);
    expect(features.get('opensumi.testing')?.requires?.map((feature) => feature.id)).toEqual(['opensumi.tasks']);
  });

  it('adapts legacy modules without changing their order', () => {
    expect.hasAssertions();
    const modules = CommonNodeFeatures.map((feature) => `${feature.id}.module`);
    const plan = compileLegacyRuntimePlan({
      profile: OpenSumiDefaultProductProfile,
      runtime: 'node',
      scope: 'application',
      features: CommonNodeFeatures,
      modules,
    });

    expect(plan.entries.map((entry) => entry.featureId)).toEqual(CommonNodeFeatures.map((feature) => feature.id));
    expect(plan.entries.map((entry) => entry.module)).toEqual(modules);
    expect(plan.entries.every((entry) => entry.legacy)).toBe(true);
  });

  it('migrates File Service to a versioned connection port on both runtime facets', () => {
    expect.hasAssertions();
    const browserPlan = compileOpenSumiProductRuntimePlan({
      runtime: 'browser',
      commonModules: CommonBrowserFeatures.map((feature) => `${feature.id}.browser-module`),
    });
    const nodePlan = compileOpenSumiProductRuntimePlan({
      runtime: 'node',
      commonModules: CommonNodeFeatures.map((feature) => `${feature.id}.node-module`),
    });
    const browserFileService = browserPlan.entries.find((entry) => entry.featureId === 'opensumi.files.service');
    const nodeFileService = nodePlan.entries.find((entry) => entry.featureId === 'opensumi.files.service');

    expect(DiskFileServiceRuntimePort).toEqual({
      id: 'opensumi.files.disk-service',
      version: 1,
      scope: 'connection',
    });
    expect(browserFileService).toMatchObject({
      scope: 'window',
      migrationState: 'declared',
      legacy: true,
      consumes: [DiskFileServiceRuntimePort],
      provides: [],
    });
    expect(nodeFileService).toMatchObject({
      scope: 'application',
      migrationState: 'declared',
      legacy: true,
      consumes: [],
      provides: [DiskFileServiceRuntimePort],
    });
    expect(
      compileRuntimeTopology(OpenSumiDefaultProductProfile, [
        toRuntimePlanContract(nodePlan),
        toRuntimePlanContract(browserPlan),
      ]).links.find(({ port }) => port.id === DiskFileServiceRuntimePort.id),
    ).toEqual({
      port: DiskFileServiceRuntimePort,
      consumerRuntime: 'browser',
      consumerFeatureIds: ['opensumi.files.service'],
      providerRuntime: 'node',
      providerFeatureId: 'opensumi.files.service',
    });
  });

  it('rejects the Browser File Service facet when its boundary requirement is absent', () => {
    expect.hasAssertions();

    expect(() =>
      compileLegacyRuntimePlan({
        profile: OpenSumiDefaultProductProfile,
        runtime: 'browser',
        scope: 'window',
        features: CommonBrowserFeatures,
        modules: CommonBrowserFeatures.map((feature) => `${feature.id}.module`),
        facetOptions: CommonBrowserFacetOptions,
      }),
    ).toThrow(
      'Feature opensumi.files.service consumes runtime port opensumi.files.disk-service, but browser has no provider',
    );
  });

  it('declares the application Process Factory provider and its Node consumers', () => {
    expect.hasAssertions();
    const nodePlan = compileOpenSumiProductRuntimePlan({
      runtime: 'node',
      commonModules: CommonNodeFeatures.map((feature) => `${feature.id}.node-module`),
    });
    const processEntry = nodePlan.entries.find((entry) => entry.featureId === ProcessFeature.id);
    const fileSearchEntry = nodePlan.entries.find((entry) => entry.featureId === 'opensumi.files.search');
    const searchEntry = nodePlan.entries.find((entry) => entry.featureId === 'opensumi.search');

    expect(ProcessFactoryRuntimePort).toEqual({
      id: 'opensumi.process.factory',
      version: 1,
      scope: 'application',
    });
    expect(processEntry).toMatchObject({
      scope: 'application',
      migrationState: 'declared',
      legacy: true,
      consumes: [],
      provides: [ProcessFactoryRuntimePort],
    });
    expect(fileSearchEntry).toMatchObject({
      dependencies: ['opensumi.files.service', 'opensumi.process'],
      migrationState: 'declared',
      legacy: true,
      consumes: [ProcessFactoryRuntimePort],
      provides: [],
    });
    expect(searchEntry).toMatchObject({
      dependencies: ['opensumi.files.service', 'opensumi.process'],
      migrationState: 'declared',
      legacy: true,
      consumes: [ProcessFactoryRuntimePort],
      provides: [],
    });
  });

  it('declares the session Extension Host Control boundary without replacing the legacy adapter', () => {
    expect.hasAssertions();
    const browserPlan = compileOpenSumiProductRuntimePlan({
      runtime: 'browser',
      commonModules: CommonBrowserFeatures.map((feature) => `${feature.id}.browser-module`),
    });
    const nodePlan = compileOpenSumiProductRuntimePlan({
      runtime: 'node',
      commonModules: CommonNodeFeatures.map((feature) => `${feature.id}.node-module`),
    });
    const browserExtension = browserPlan.entries.find((entry) => entry.featureId === ExtensionFeature.id);
    const nodeExtension = nodePlan.entries.find((entry) => entry.featureId === ExtensionFeature.id);

    expect(ExtensionHostControlRuntimePort).toEqual({
      id: 'opensumi.extensions.host-control',
      version: 1,
      scope: 'session',
    });
    expect(browserExtension).toMatchObject({
      scope: 'window',
      migrationState: 'declared',
      legacy: true,
      consumes: [ExtensionHostControlRuntimePort],
      provides: [],
    });
    expect(nodeExtension).toMatchObject({
      scope: 'application',
      migrationState: 'declared',
      legacy: true,
      consumes: [],
      provides: [ExtensionHostControlRuntimePort],
    });
    expect(
      compileRuntimeTopology(OpenSumiDefaultProductProfile, [
        toRuntimePlanContract(nodePlan),
        toRuntimePlanContract(browserPlan),
      ]).links.find(({ port }) => port.id === ExtensionHostControlRuntimePort.id),
    ).toEqual({
      port: ExtensionHostControlRuntimePort,
      consumerRuntime: 'browser',
      consumerFeatureIds: [ExtensionFeature.id],
      providerRuntime: 'node',
      providerFeatureId: ExtensionFeature.id,
    });
  });

  it('rejects Node Process Factory consumers when the provider declaration is absent', () => {
    expect.hasAssertions();

    expect(() =>
      compileLegacyRuntimePlan({
        profile: OpenSumiDefaultProductProfile,
        runtime: 'node',
        scope: 'application',
        features: CommonNodeFeatures,
        modules: CommonNodeFeatures.map((feature) => `${feature.id}.node-module`),
        facetOptions: {
          ...CommonNodeFacetOptions,
          [ProcessFeature.id]: {},
        },
      }),
    ).toThrow(expect.objectContaining<Partial<FeatureGraphError>>({ code: 'MISSING_PORT_PROVIDER' }));
  });

  it('rejects the product topology when the Node File Service provider is absent', () => {
    expect.hasAssertions();
    const browserPlan = compileOpenSumiProductRuntimePlan({
      runtime: 'browser',
      commonModules: CommonBrowserFeatures.map((feature) => `${feature.id}.browser-module`),
    });
    const nodePlanWithoutFileProvider = compileLegacyRuntimePlan({
      profile: OpenSumiDefaultProductProfile,
      runtime: 'node',
      scope: 'application',
      features: CommonNodeFeatures,
      modules: CommonNodeFeatures.map((feature) => `${feature.id}.node-module`),
    });

    expect(() =>
      compileRuntimeTopology(OpenSumiDefaultProductProfile, [
        toRuntimePlanContract(browserPlan),
        toRuntimePlanContract(nodePlanWithoutFileProvider),
      ]),
    ).toThrow(expect.objectContaining<Partial<FeatureGraphError>>({ code: 'MISSING_BOUNDARY_PORT_PROVIDER' }));
  });

  it.each([
    ['default', []],
    ['ai', ['ai']],
    ['notebook', ['notebook']],
    ['collaboration', ['collaboration']],
    ['full', ['ai', 'notebook', 'collaboration']],
  ] as const)('closes the %s Browser/Node product topology', (_name, options) => {
    expect.hasAssertions();
    const browserPlan = compileOpenSumiProductRuntimePlan({
      runtime: 'browser',
      commonModules: CommonBrowserFeatures.map((feature) => `${feature.id}.browser-module`),
      options: options
        .filter((option) => OptionalBrowserFeatures[option].length > 0)
        .map((option) => ({
          id: option,
          modules: OptionalBrowserFeatures[option].map((feature) => `${feature.id}.browser-module`),
        })),
    });
    const nodePlan = compileOpenSumiProductRuntimePlan({
      runtime: 'node',
      commonModules: CommonNodeFeatures.map((feature) => `${feature.id}.node-module`),
      options: options
        .filter((option) => OptionalNodeFeatures[option].length > 0)
        .map((option) => ({
          id: option,
          modules: OptionalNodeFeatures[option].map((feature) => `${feature.id}.node-module`),
        })),
    });

    const topology = compileRuntimeTopology(OpenSumiDefaultProductProfile, [
      toRuntimePlanContract(browserPlan),
      toRuntimePlanContract(nodePlan),
    ]);

    expect(topology.enabledOptions).toEqual(options);
    expect(topology.links.map((link) => link.port.id)).toEqual([
      DiskFileServiceRuntimePort.id,
      ExtensionHostControlRuntimePort.id,
    ]);
  });

  it('rejects facet metadata that is detached from the runtime catalog', () => {
    expect.hasAssertions();

    expect(() =>
      compileLegacyRuntimePlan({
        profile: OpenSumiDefaultProductProfile,
        runtime: 'node',
        scope: 'application',
        features: CommonNodeFeatures,
        modules: CommonNodeFeatures.map((feature) => `${feature.id}.module`),
        facetOptions: {
          ...CommonNodeFacetOptions,
          'opensumi.detached': {},
        },
      }),
    ).toThrow('Runtime facet options reference opensumi.detached, which is not in the node catalog');
  });

  it('rejects a drifting legacy feature/module catalog', () => {
    expect.hasAssertions();

    expect(() =>
      compileLegacyRuntimePlan({
        profile: OpenSumiDefaultProductProfile,
        runtime: 'node',
        scope: 'application',
        features: CommonNodeFeatures,
        modules: [],
      }),
    ).toThrow('Legacy node catalog has 11 features but 0 modules');
  });

  it('compiles optional browser features in profile order regardless of load completion order', () => {
    expect.hasAssertions();
    const commonModules = CommonBrowserFeatures.map((feature) => `${feature.id}.module`);
    const collaborationModules = ['collaboration.module'];
    const aiModules = ['design.module', 'ai-native.module'];
    const plan = compileOpenSumiProductRuntimePlan({
      runtime: 'browser',
      commonModules,
      options: [
        { id: 'collaboration', modules: collaborationModules },
        { id: 'ai', modules: aiModules },
      ],
    });

    expect(plan.enabledOptions).toEqual(['ai', 'collaboration']);
    expect(plan.frameworkEntryCount).toBe(CommonBrowserFeatures.length);
    expect(toRuntimePlanContract(plan)).not.toHaveProperty('frameworkEntryCount');
    expect(plan.entries.slice(commonModules.length).map((entry) => entry.featureId)).toEqual(
      [...OptionalBrowserFeatures.ai, ...OptionalBrowserFeatures.collaboration].map((feature) => feature.id),
    );
    expect(plan.entries.slice(commonModules.length).map((entry) => entry.module)).toEqual([
      ...aiModules,
      ...collaborationModules,
    ]);
    expect(plan.entries.slice(commonModules.length).every((entry) => entry.scope === 'window' && entry.legacy)).toBe(
      true,
    );
  });

  it('filters browser-only optional features from the Node runtime', () => {
    expect.hasAssertions();
    const commonModules = CommonNodeFeatures.map((feature) => `${feature.id}.module`);
    const plan = compileOpenSumiProductRuntimePlan({
      runtime: 'node',
      commonModules,
      options: [
        { id: 'ai', modules: ['ai-native.module'] },
        { id: 'notebook', modules: [] },
        { id: 'collaboration', modules: ['collaboration.module'] },
      ],
    });

    expect(plan.enabledOptions).toEqual(['ai', 'notebook', 'collaboration']);
    expect(plan.entries.slice(commonModules.length).map((entry) => entry.featureId)).toEqual(
      [...OptionalNodeFeatures.ai, ...OptionalNodeFeatures.collaboration].map((feature) => feature.id),
    );
    expect(plan.entries.slice(commonModules.length).map((entry) => entry.module)).toEqual([
      'ai-native.module',
      'collaboration.module',
    ]);
    expect(
      plan.entries.slice(commonModules.length).every((entry) => entry.scope === 'application' && entry.legacy),
    ).toBe(true);
  });

  it('rejects duplicate options and option catalogs that drift from their feature facets', () => {
    expect.hasAssertions();
    const commonModules = CommonBrowserFeatures.map((feature) => `${feature.id}.module`);

    expect(() =>
      compileOpenSumiProductRuntimePlan({
        runtime: 'browser',
        commonModules,
        options: [
          { id: 'notebook', modules: ['notebook.module'] },
          { id: 'notebook', modules: ['notebook.module'] },
        ],
      }),
    ).toThrow('browser runtime loads product option notebook more than once');
    expect(() =>
      compileOpenSumiProductRuntimePlan({
        runtime: 'browser',
        commonModules,
        options: [{ id: 'ai', modules: ['ai-native.module'] }],
      }),
    ).toThrow('browser option ai has 2 features but 1 modules');
    expect(() =>
      compileOpenSumiProductRuntimePlan({
        runtime: 'browser',
        commonModules,
        options: [{ id: 'telemetry' as 'ai', modules: [] }],
      }),
    ).toThrow('OpenSumi product profile has no option telemetry');
  });
});
