import { composeLegacyEntrypointModules } from '../../src/legacy-entrypoint-modules';
import {
  CommonBrowserFeatures,
  CommonNodeFeatures,
  OptionalBrowserFeatures,
  OptionalNodeFeatures,
} from '../../src/product-profile';
import { compileOpenSumiProductRuntimePlan } from '../../src/product-runtime-plan';

interface TestModule {
  readonly id: string;
}

const modulesFor = (ids: readonly string[]): TestModule[] => ids.map((id) => ({ id }));

function expectModuleIdentityOrder(actual: readonly TestModule[], expected: readonly TestModule[]): void {
  expect(actual).toHaveLength(expected.length);
  expected.forEach((module, index) => expect(actual[index]).toBe(module));
}

describe('legacy entrypoint ProductProfile composition', () => {
  it('preserves the standard Browser framework, integration, sample, AI and Notebook identities in legacy order', () => {
    expect.hasAssertions();
    const commonModules = modulesFor(CommonBrowserFeatures.map((feature) => feature.id));
    const aiModules = modulesFor(OptionalBrowserFeatures.ai.map((feature) => feature.id));
    const notebookModules = modulesFor(OptionalBrowserFeatures.notebook.map((feature) => feature.id));
    const express = { id: 'integration.express' };
    const remoteOpener = { id: 'integration.remote-opener' };
    const sample = { id: 'product.sample' };
    const runtimePlan = compileOpenSumiProductRuntimePlan({
      runtime: 'browser',
      commonModules,
      options: [
        { id: 'ai', modules: aiModules },
        { id: 'notebook', modules: notebookModules },
      ],
    });

    const modules = composeLegacyEntrypointModules({
      runtimePlan,
      frameworkModules: commonModules,
      beforeOptionalModules: [express, remoteOpener, sample],
    });

    expect(runtimePlan.enabledOptions).toEqual(['ai', 'notebook']);
    expectModuleIdentityOrder(modules, [
      ...commonModules,
      express,
      remoteOpener,
      sample,
      ...aiModules,
      ...notebookModules,
    ]);
  });

  it.each([
    ['core-only E2E', false],
    ['AI E2E', true],
  ] as const)('preserves the %s Browser entrypoint order', (_name, enableAI) => {
    expect.hasAssertions();
    const commonModules = modulesFor(CommonBrowserFeatures.map((feature) => feature.id));
    const aiModules = modulesFor(OptionalBrowserFeatures.ai.map((feature) => feature.id));
    const express = { id: 'integration.express' };
    const remoteOpener = { id: 'integration.remote-opener' };
    const sample = { id: 'product.sample' };
    const runtimePlan = compileOpenSumiProductRuntimePlan({
      runtime: 'browser',
      commonModules,
      options: enableAI ? [{ id: 'ai', modules: aiModules }] : [],
    });

    expectModuleIdentityOrder(
      composeLegacyEntrypointModules({
        runtimePlan,
        frameworkModules: commonModules,
        beforeOptionalModules: [express, remoteOpener, sample],
      }),
      [...commonModules, express, remoteOpener, sample, ...(enableAI ? aiModules : [])],
    );
    expect(runtimePlan.enabledOptions).toEqual(enableAI ? ['ai'] : []);
  });

  it.each([
    ['development', [{ id: 'integration.express' }, { id: 'integration.remote-opener' }]],
    ['production', [{ id: 'integration.express' }]],
  ] as const)('keeps the fixed AI Node option before %s infrastructure modules', (_name, infrastructureModules) => {
    expect.hasAssertions();
    const commonModules = modulesFor(CommonNodeFeatures.map((feature) => feature.id));
    const aiModules = modulesFor(OptionalNodeFeatures.ai.map((feature) => feature.id));
    const runtimePlan = compileOpenSumiProductRuntimePlan({
      runtime: 'node',
      commonModules,
      options: [{ id: 'ai', modules: aiModules }],
    });

    expectModuleIdentityOrder(
      composeLegacyEntrypointModules({
        runtimePlan,
        frameworkModules: commonModules,
        afterOptionalModules: infrastructureModules,
      }),
      [...commonModules, ...aiModules, ...infrastructureModules],
    );
    expect(runtimePlan.enabledOptions).toEqual(['ai']);
  });

  it('rejects a framework prefix longer than the compiled framework boundary', () => {
    expect.hasAssertions();
    const commonModules = modulesFor(CommonNodeFeatures.map((feature) => feature.id));
    const runtimePlan = compileOpenSumiProductRuntimePlan({
      runtime: 'node',
      commonModules,
    });

    expect(() =>
      composeLegacyEntrypointModules({
        runtimePlan,
        frameworkModules: [...commonModules, { id: 'unexpected.framework.module' }],
      }),
    ).toThrow(
      `framework module count ${commonModules.length + 1} does not match runtime plan framework entry count ${
        CommonNodeFeatures.length
      }`,
    );
  });

  it('rejects a framework prefix shorter than the compiled framework boundary', () => {
    expect.hasAssertions();
    const commonModules = modulesFor(CommonNodeFeatures.map((feature) => feature.id));
    const runtimePlan = compileOpenSumiProductRuntimePlan({
      runtime: 'node',
      commonModules,
    });

    expect(() =>
      composeLegacyEntrypointModules({
        runtimePlan,
        frameworkModules: commonModules.slice(0, -1),
      }),
    ).toThrow(
      `framework module count ${commonModules.length - 1} does not match runtime plan framework entry count ${
        CommonNodeFeatures.length
      }`,
    );
  });

  it('rejects a same-length framework prefix from a different runtime plan', () => {
    expect.hasAssertions();
    const commonModules = modulesFor(CommonBrowserFeatures.map((feature) => feature.id));
    const runtimePlan = compileOpenSumiProductRuntimePlan({
      runtime: 'browser',
      commonModules,
    });
    const driftedCommonModules = [...commonModules];
    driftedCommonModules[CommonBrowserFeatures.length - 1] = { id: 'drifted.framework.module' };

    expect(() =>
      composeLegacyEntrypointModules({
        runtimePlan,
        frameworkModules: driftedCommonModules,
      }),
    ).toThrow(
      `framework module at index ${CommonBrowserFeatures.length - 1} does not match runtime plan feature ${
        CommonBrowserFeatures[CommonBrowserFeatures.length - 1].id
      }`,
    );
  });
});
