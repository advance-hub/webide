import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  ARCHITECTURE_BASELINE_PATH,
  CountBaseline,
  analyzeArchitecture,
  createWorkspaceDependencyGraph,
  discoverWorkspacePackages,
  evaluateArchitecture,
  evaluateBaselineHistory,
  evaluatePackageImports,
  extractModuleSpecifiers,
  findDependencyCycles,
  isDirectCommonFacetImport,
  isRuntimeFacetSpecifier,
  parsePnpmWorkspacePatterns,
  readBaselineFromGit,
  runCli,
  snapshotBaseline,
} from './check-architecture';

const emptyBaseline: CountBaseline = {
  commonFacetImports: {},
  commonRuntimeRootImports: {},
  deepImportsByPackage: {},
  runtimeImportsFromDevDependencies: {},
  undeclaredWorkspaceDependencies: {},
};

function writeFile(root: string, relativePath: string, content: string): void {
  const file = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function createFixture(t: { after(callback: () => void): void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opensumi-architecture-'));
  t.after(() => fs.rmSync(root, { force: true, recursive: true }));
  writeFile(root, 'package.json', JSON.stringify({ name: 'fixture', private: true, workspaces: ['packages/*'] }));
  writeFile(root, 'pnpm-workspace.yaml', 'packages:\n  - packages/*\n');
  writeFile(
    root,
    'packages/a/package.json',
    JSON.stringify({ name: '@fixture/a', version: '1.0.0', dependencies: {} }),
  );
  writeFile(
    root,
    'packages/b/package.json',
    JSON.stringify({ name: '@fixture/b', version: '1.0.0', dependencies: { '@fixture/a': 'workspace:*' } }),
  );
  writeFile(root, 'packages/b/src/common/value.ts', 'export interface B { value: string }\n');
  return root;
}

function writeCurrentBaseline(root: string): CountBaseline {
  const baseline = snapshotBaseline(analyzeArchitecture(root));
  writeFile(root, ARCHITECTURE_BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  return baseline;
}

function withMutedConsole<T>(callback: () => T): T {
  const log = console.log;
  const error = console.error;
  console.log = () => undefined;
  console.error = () => undefined;
  try {
    return callback();
  } finally {
    console.log = log;
    console.error = error;
  }
}

test('extractModuleSpecifiers handles module forms and preserves type-only imports', () => {
  const imports = extractModuleSpecifiers(`
    import value from '@opensumi/a';
    import type { Type } from '@opensumi/type-a';
    import { type OtherType } from '@opensumi/type-b';
    export type { Exported } from '@opensumi/type-c';
    export { other } from '@opensumi/b/lib/common';
    const lazy = import('@opensumi/c/lib/browser/lazy');
    const legacy = require('@opensumi/d');
    const resolved = require.resolve('@opensumi/e/node/worker');
    type LazyType = import('@opensumi/type-deep').Api;
    // import ignored from '@opensumi/comment';
  `);
  assert.deepEqual(
    imports.map(({ specifier, typeOnly }) => [specifier, typeOnly]),
    [
      ['@opensumi/a', false],
      ['@opensumi/type-a', true],
      ['@opensumi/type-b', true],
      ['@opensumi/type-c', true],
      ['@opensumi/b/lib/common', false],
      ['@opensumi/c/lib/browser/lazy', false],
      ['@opensumi/d', false],
      ['@opensumi/e/node/worker', false],
      ['@opensumi/type-deep', true],
    ],
  );
});

test('an explicit package export allowlist rejects private paths even without a lib segment', (t) => {
  const root = createFixture(t);
  writeFile(
    root,
    'packages/a/package.json',
    JSON.stringify({
      name: '@fixture/a',
      exports: {
        '.': { types: './lib/index.d.ts', default: './lib/index.js' },
        './api': { types: './lib/api.d.ts', default: './lib/api.js' },
        './disabled': null,
      },
    }),
  );
  writeFile(
    root,
    'packages/b/src/browser/consumer.ts',
    `import { Root } from '@fixture/a';
     import type { Api } from '@fixture/a/api';
     import { Private } from '@fixture/a/internal/implementation';
     const hidden = import('@fixture/a/disabled');
     const old = require.resolve('@fixture/a/lib/api');`,
  );
  const snapshot = analyzeArchitecture(root);
  const problems = evaluatePackageImports(snapshot);
  assert.equal(problems.length, 3);
  assert.ok(problems.every(({ kind }) => kind === 'private-package-import'));
  assert.ok(problems.some(({ message }) => message.includes('@fixture/a/internal/implementation')));
  // An exact debt baseline cannot authorize an import outside the package API.
  assert.deepEqual(evaluateArchitecture(snapshot, snapshotBaseline(snapshot)), []);
  assert.notEqual(
    withMutedConsole(() => {
      writeCurrentBaseline(root);
      return runCli(root, []);
    }),
    0,
  );
});

test('workspace graph includes declared runtime dependencies and excludes dev-only dependencies', () => {
  const graph = createWorkspaceDependencyGraph([
    {
      dependencies: new Set(['b', 'test-helper']),
      name: 'a',
      root: '/repo/a',
      runtimeDependencies: new Set(['b']),
    },
    {
      dependencies: new Set(['a']),
      name: 'b',
      root: '/repo/b',
      runtimeDependencies: new Set(['a', 'external-package']),
    },
    {
      dependencies: new Set(),
      name: 'test-helper',
      root: '/repo/test-helper',
      runtimeDependencies: new Set(),
    },
  ]);

  assert.deepEqual([...graph.get('a')!], ['b']);
  assert.deepEqual([...graph.get('b')!], ['a']);
  assert.deepEqual([...graph.get('test-helper')!], []);
  assert.deepEqual(findDependencyCycles(graph), [['a', 'b']]);
});

test('value imports require runtime dependencies while type-only imports may use devDependencies', (t) => {
  const root = createFixture(t);
  writeFile(
    root,
    'packages/b/package.json',
    JSON.stringify({
      name: '@fixture/b',
      version: '1.0.0',
      devDependencies: { '@fixture/a': 'workspace:*' },
    }),
  );
  writeFile(root, 'packages/b/src/index.ts', "import { runtimeValue } from '@fixture/a';\nvoid runtimeValue;\n");

  const valueSnapshot = analyzeArchitecture(root);
  assert.deepEqual([...valueSnapshot.undeclaredWorkspaceDependencies], []);
  assert.deepEqual([...valueSnapshot.runtimeImportsFromDevDependencies], [['@fixture/b -> @fixture/a', 1]]);

  writeFile(
    root,
    'packages/b/src/index.ts',
    "import type { RuntimeType } from '@fixture/a';\nexport type T = RuntimeType;\n",
  );
  const typeSnapshot = analyzeArchitecture(root);
  assert.deepEqual([...typeSnapshot.undeclaredWorkspaceDependencies], []);
  assert.deepEqual([...typeSnapshot.runtimeImportsFromDevDependencies], []);
});

test('cycle diagnostics report a strongly connected group without inventing a path', () => {
  const graph = new Map([
    ['a', new Set(['c'])],
    ['b', new Set(['a'])],
    ['c', new Set(['b'])],
  ]);
  assert.deepEqual(findDependencyCycles(graph), [['a', 'b', 'c']]);
  const snapshot = {
    commonFacetImports: new Map<string, number>(),
    commonRuntimeRootImports: new Map<string, number>(),
    cycles: findDependencyCycles(graph),
    deepImportsByPackage: new Map<string, number>(),
    runtimeImportsFromDevDependencies: new Map<string, number>(),
    undeclaredWorkspaceDependencies: new Map<string, number>(),
  };
  assert.equal(
    evaluateArchitecture(snapshot, emptyBaseline)[0].message,
    'Workspace dependency strongly connected group: a, b, c',
  );
});

test('common facet classifier uses the top-level source facet and covers every runtime facet', () => {
  const commonFile = path.join('/repo', 'packages', 'a', 'src', 'common', 'service.ts');
  assert.equal(isDirectCommonFacetImport(commonFile, '@opensumi/b/lib/browser/service', '@opensumi/b'), true);
  assert.equal(isDirectCommonFacetImport(commonFile, '@opensumi/b/src/node/service', '@opensumi/b'), true);
  assert.equal(isDirectCommonFacetImport(commonFile, '@opensumi/b/electron/service', '@opensumi/b'), true);
  assert.equal(isDirectCommonFacetImport(commonFile, '@opensumi/b/worker/service', '@opensumi/b'), true);
  assert.equal(isDirectCommonFacetImport(commonFile, '@opensumi/b/browser-worker/service', '@opensumi/b'), true);
  assert.equal(isDirectCommonFacetImport(commonFile, '@opensumi/b/extension-host/service', '@opensumi/b'), true);
  assert.equal(isDirectCommonFacetImport(commonFile, '@opensumi/b/hosted/service', '@opensumi/b'), true);
  assert.equal(isDirectCommonFacetImport(commonFile, '../node/service'), true);
  assert.equal(isDirectCommonFacetImport(commonFile, '@opensumi/ide-core-browser', '@opensumi/ide-core-browser'), true);
  assert.equal(isDirectCommonFacetImport(commonFile, '../common/value', '@opensumi/ide-core-browser'), false);
  assert.equal(
    isDirectCommonFacetImport(
      path.join('/repo', 'packages', 'a', 'src', 'browser', 'feature', 'common', 'view.ts'),
      '@opensumi/b/node/service',
      '@opensumi/b',
    ),
    false,
  );
});

test('branch snapshot must exactly match its baseline and history can only tighten', () => {
  const exactSnapshot = {
    commonFacetImports: new Map([['existing', 2]]),
    commonRuntimeRootImports: new Map([['existing-root', 1]]),
    cycles: [],
    deepImportsByPackage: new Map([['@opensumi/a', 4]]),
    runtimeImportsFromDevDependencies: new Map([['@opensumi/a -> @opensumi/b', 3]]),
    undeclaredWorkspaceDependencies: new Map([['@opensumi/a -> @opensumi/b', 2]]),
  };
  const baseline: CountBaseline = {
    commonFacetImports: { existing: 2 },
    commonRuntimeRootImports: { 'existing-root': 1 },
    deepImportsByPackage: { '@opensumi/a': 4 },
    runtimeImportsFromDevDependencies: { '@opensumi/a -> @opensumi/b': 3 },
    undeclaredWorkspaceDependencies: { '@opensumi/a -> @opensumi/b': 2 },
  };
  assert.deepEqual(evaluateArchitecture(exactSnapshot, baseline), []);

  const reduced = { ...exactSnapshot, commonFacetImports: new Map([['existing', 1]]) };
  assert.equal(evaluateArchitecture(reduced, baseline)[0].kind, 'common-facet-import');

  const rootImportGrowth = {
    ...exactSnapshot,
    commonRuntimeRootImports: new Map([
      ['existing-root', 1],
      ['new-root', 1],
    ]),
  };
  assert.equal(evaluateArchitecture(rootImportGrowth, baseline)[0].kind, 'common-runtime-root-import');

  const tightened: CountBaseline = { ...baseline, commonFacetImports: { existing: 1 } };
  assert.deepEqual(evaluateBaselineHistory(tightened, baseline), []);
  assert.deepEqual(
    evaluateBaselineHistory({ ...baseline, commonFacetImports: { existing: 3, new: 1 } }, baseline).map(
      ({ kind }) => kind,
    ),
    ['baseline-regression', 'baseline-regression'],
  );
  assert.equal(
    evaluateBaselineHistory(
      { ...baseline, commonRuntimeRootImports: { 'existing-root': 1, 'new-root': 1 } },
      baseline,
    )[0].kind,
    'baseline-regression',
  );
});

test('common imports cannot hide runtime facets behind workspace package roots', (t) => {
  const root = createFixture(t);
  writeFile(root, 'packages/a/src/common/service.ts', "export type { B } from '@fixture/b';\n");
  writeFile(root, 'packages/b/src/index.ts', "export type { B } from './common/value';\n");

  let snapshot = analyzeArchitecture(root);
  assert.deepEqual(snapshot.commonRuntimeRootImports, new Map());

  writeFile(root, 'packages/b/src/index.ts', "export { browserValue } from './browser';\n");
  writeFile(root, 'packages/b/src/browser/index.ts', "export { browserValue } from './value';\n");
  writeFile(root, 'packages/b/src/browser/value.ts', "export const browserValue = 'browser';\n");
  snapshot = analyzeArchitecture(root);
  assert.deepEqual(snapshot.commonRuntimeRootImports, new Map([['@fixture/a -> @fixture/b', 1]]));
  assert.equal(evaluateArchitecture(snapshot, emptyBaseline)[0].kind, 'common-runtime-root-import');

  writeFile(root, 'packages/a/src/common/second-service.ts', "export type { B } from '@fixture/b';\n");
  snapshot = analyzeArchitecture(root);
  assert.deepEqual(
    snapshot.commonRuntimeRootImports,
    new Map([['@fixture/a -> @fixture/b', 2]]),
    'the gate counts import sites per package edge so a second bypass cannot hide behind an existing edge',
  );
  assert.equal(
    evaluateArchitecture(snapshot, { ...emptyBaseline, commonRuntimeRootImports: { '@fixture/a -> @fixture/b': 1 } })[0]
      .kind,
    'common-runtime-root-import',
  );

  writeFile(
    root,
    'packages/b/package.json',
    JSON.stringify({ name: '@fixture/b', version: '1.0.0', dependencies: { '@fixture/c': 'workspace:*' } }),
  );
  writeFile(
    root,
    'packages/c/package.json',
    JSON.stringify({ name: '@fixture/c', version: '1.0.0', dependencies: {} }),
  );
  writeFile(root, 'packages/b/src/index.ts', "export * from '@fixture/c';\n");
  writeFile(root, 'packages/c/src/index.ts', "export * from '@fixture/b';\nexport * from './browser';\n");
  writeFile(root, 'packages/c/src/browser/index.ts', "export const nestedBrowserValue = 'browser';\n");
  writeFile(
    root,
    'packages/c/package.json',
    JSON.stringify({ name: '@fixture/c', version: '1.0.0', dependencies: { '@fixture/b': 'workspace:*' } }),
  );
  snapshot = analyzeArchitecture(root);
  assert.deepEqual(
    snapshot.commonRuntimeRootImports,
    new Map([['@fixture/a -> @fixture/b', 2]]),
    'runtime reachability must propagate through cyclic workspace root re-exports',
  );
});

test('pnpm workspace packages are authoritative and root workspaces must match', (t) => {
  assert.deepEqual(
    parsePnpmWorkspacePatterns("packages:\n  - 'client'\n  - packages/* # packages\nnodeLinker: hoisted\n"),
    ['client', 'packages/*'],
  );
  const root = createFixture(t);
  writeFile(root, 'package.json', JSON.stringify({ name: 'fixture', private: true, workspaces: ['packages/a'] }));
  assert.throws(() => discoverWorkspacePackages(root), /must match/);
});

test('relative cross-workspace imports are deep and undeclared while type-only edges do not create runtime cycles', (t) => {
  const root = createFixture(t);
  writeFile(
    root,
    'packages/a/src/common/service.ts',
    "import type { B } from '../../../b/src/common/value';\nexport type A = B;\n",
  );
  let snapshot = analyzeArchitecture(root);
  assert.deepEqual(snapshot.cycles, []);
  assert.deepEqual(snapshot.deepImportsByPackage, new Map([['@fixture/a', 1]]));
  assert.deepEqual(snapshot.undeclaredWorkspaceDependencies, new Map([['@fixture/a -> @fixture/b', 1]]));
  assert.equal(
    snapshot.imports.find(({ sourcePackage }) => sourcePackage === '@fixture/a')?.targetPackage,
    '@fixture/b',
  );
  assert.equal(snapshot.imports.find(({ sourcePackage }) => sourcePackage === '@fixture/a')?.typeOnly, true);

  writeFile(
    root,
    'packages/a/src/common/service.ts',
    "import { value } from '../../../b/src/common/value';\nexport const a = value;\n",
  );
  writeFile(root, 'packages/b/src/common/value.ts', "export const value = 'b';\n");
  snapshot = analyzeArchitecture(root);
  assert.deepEqual(snapshot.cycles, [['@fixture/a', '@fixture/b']]);
});

test('package src imports are deep while public roots and common subpaths are not', (t) => {
  const root = createFixture(t);
  writeFile(
    root,
    'packages/a/src/index.ts',
    [
      "import type { Source } from '@fixture/b/src/server';",
      "import type { CompiledRoot } from '@fixture/b/lib';",
      "import type { SourceRoot } from '@fixture/b/src';",
      "import type { Common } from '@fixture/b/common';",
      "import type { CommonValue } from '@fixture/b/common/value';",
      "import type { Root } from '@fixture/b';",
      'export type Combined = Source & Common & CommonValue & Root & CompiledRoot & SourceRoot;',
      '',
    ].join('\n'),
  );

  const snapshot = analyzeArchitecture(root);
  assert.deepEqual(snapshot.deepImportsByPackage, new Map([['@fixture/a', 3]]));
});

test('architecture CI covers workspace tools and compares new-branch pushes with HEAD^', () => {
  const ciPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.github/workflows/ci.yml');
  const ci = fs.readFileSync(ciPath, 'utf8');
  assert.doesNotMatch(ci, /^\s+paths(?:-ignore)?:/m, 'All workspace changes, including tools, trigger regression');
  assert.match(ci, /^\s+fetch-depth: 2$/m);
  assert.match(ci, /^\s+ARCHITECTURE_BASELINE_REF=HEAD\^$/m);
});

test('CLI requires exact baseline and print-baseline does not bypass the gate', (t) => {
  const root = createFixture(t);
  writeFile(root, 'packages/a/src/index.ts', 'export const a = 1;\n');
  writeCurrentBaseline(root);
  assert.equal(
    withMutedConsole(() => runCli(root, [])),
    0,
  );
  assert.throws(() => withMutedConsole(() => runCli(root, ['--baseline-ref'])), /requires a non-empty git ref/);

  writeFile(
    root,
    ARCHITECTURE_BASELINE_PATH,
    `${JSON.stringify({ ...emptyBaseline, deepImportsByPackage: { '@fixture/a': 1 } }, null, 2)}\n`,
  );
  assert.equal(
    withMutedConsole(() => runCli(root, ['--print-baseline'])),
    1,
  );
});

test('baseline ref rejects branch debt growth and permits first introduction', (t) => {
  const root = createFixture(t);
  execFileSync('git', ['init'], { cwd: root, stdio: 'ignore' });
  execFileSync('git', ['config', 'user.email', 'architecture@example.test'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'Architecture Test'], { cwd: root });
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-m', 'base without architecture baseline'], { cwd: root, stdio: 'ignore' });

  writeCurrentBaseline(root);
  assert.equal(
    withMutedConsole(() => runCli(root, ['--baseline-ref=HEAD'])),
    0,
  );

  const legacyBaseline = JSON.parse(
    fs.readFileSync(path.join(root, ARCHITECTURE_BASELINE_PATH), 'utf8'),
  ) as Partial<CountBaseline>;
  delete legacyBaseline.commonRuntimeRootImports;
  delete legacyBaseline.runtimeImportsFromDevDependencies;
  writeFile(root, ARCHITECTURE_BASELINE_PATH, `${JSON.stringify(legacyBaseline, null, 2)}\n`);
  execFileSync('git', ['add', ARCHITECTURE_BASELINE_PATH], { cwd: root });
  execFileSync('git', ['commit', '-m', 'introduce legacy baseline'], { cwd: root, stdio: 'ignore' });
  writeCurrentBaseline(root);
  assert.equal(
    withMutedConsole(() => runCli(root, ['--baseline-ref=HEAD'])),
    0,
    'newly introduced count fields adopt the branch baseline for their first historical comparison',
  );

  const invalidLegacyBaseline = {
    ...JSON.parse(fs.readFileSync(path.join(root, ARCHITECTURE_BASELINE_PATH), 'utf8')),
    commonRuntimeRootImports: null,
  };
  writeFile(root, ARCHITECTURE_BASELINE_PATH, `${JSON.stringify(invalidLegacyBaseline, null, 2)}\n`);
  execFileSync('git', ['add', ARCHITECTURE_BASELINE_PATH], { cwd: root });
  execFileSync('git', ['commit', '-m', 'invalid explicit architecture field'], { cwd: root, stdio: 'ignore' });
  const validFallbackBaseline = writeCurrentBaseline(root);
  assert.throws(
    () => readBaselineFromGit(root, 'HEAD', validFallbackBaseline),
    /must contain an object field named commonRuntimeRootImports/,
    'an explicit invalid value must not be treated like a field absent from the old schema',
  );
  execFileSync('git', ['add', ARCHITECTURE_BASELINE_PATH], { cwd: root });
  execFileSync('git', ['commit', '-m', 'restore valid architecture field'], { cwd: root, stdio: 'ignore' });

  writeFile(
    root,
    'packages/a/src/common/service.ts',
    "import type { B } from '../../../b/src/common/value';\nexport type A = B;\n",
  );
  writeCurrentBaseline(root);
  assert.equal(
    withMutedConsole(() => runCli(root, ['--baseline-ref=HEAD'])),
    1,
  );
});

test('new package root entrypoints expose only runtime-neutral contracts in source and runtime declarations', async () => {
  const entrypoints = [
    '../packages/electron-basic/src/index.ts',
    '../packages/remote-opener/src/index.ts',
    '../packages/startup/src/index.ts',
  ];
  for (const entrypoint of entrypoints) {
    const absolutePath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), entrypoint);
    const runtimeExports = extractModuleSpecifiers(fs.readFileSync(absolutePath, 'utf8'), absolutePath).filter(
      ({ specifier }) => isRuntimeFacetSpecifier(absolutePath, specifier),
    );
    assert.deepEqual(runtimeExports, [], `${entrypoint} must not export a runtime facet, including type-only exports`);
  }

  const [electronBasic, remoteOpener, startup] = await Promise.all([
    import('@opensumi/ide-electron-basic'),
    import('@opensumi/ide-remote-opener'),
    import('@opensumi/ide-startup'),
  ]);
  assert.deepEqual(Object.keys(electronBasic).sort(), ['IElectronHeaderService']);
  assert.deepEqual(Object.keys(remoteOpener).sort(), [
    'RemoteOpenerBrowserServiceToken',
    'RemoteOpenerClientToken',
    'RemoteOpenerConverterContribution',
    'RemoteOpenerServicePath',
    'RemoteOpenerServiceToken',
  ]);
  assert.deepEqual(Object.keys(startup).sort(), [
    'CollaborationFeature',
    'NotebookFeature',
    'OpenSumiDefaultProductProfile',
    'RUNTIME_TOPOLOGY_HANDSHAKE_CHANNEL_PATH',
    'RUNTIME_TOPOLOGY_HANDSHAKE_DEFAULT_TIMEOUT_MS',
    'RUNTIME_TOPOLOGY_HANDSHAKE_MAX_PAYLOAD_BYTES',
    'RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL',
    'RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL_VERSION',
    'RuntimeTopologyHandshakeError',
    'compileOpenSumiProductRuntimePlan',
    'composeLegacyEntrypointModules',
    'createRuntimeTopologyClientPreflight',
    'createRuntimeTopologyServerHandshake',
    'parseRuntimeTopologyHandshakePolicy',
  ]);
});
