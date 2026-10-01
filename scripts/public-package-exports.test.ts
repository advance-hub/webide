import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { rspack } from '@rspack/core';
import ts from 'typescript-api';

import { packageSourceExports } from './fn/package-source-exports';

import type { Configuration, Stats } from '@rspack/core';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const fixture = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'opensumi-public-consumer-')));
const packageDirectories = [
  'utils',
  'core-common',
  'components',
  'connection',
  'core-browser',
  'monaco',
  'editor',
  'file-service',
  'theme',
  'core-node',
  'main-layout',
  'workspace',
  'output',
  'preferences',
  'overlay',
  'file-search',
  'outline',
  'workspace-edit',
  'logs-core',
  'extension-storage',
  'search',
  'file-scheme',
  'decoration',
  'storage',
  'keymaps',
  'process',
  'explorer',
  'remote-opener',
  'toolbar',
  'status-bar',
  'menu-bar',
  'variable',
  'markdown',
  'markers',
  'monaco-enhance',
  'addons',
  'express-file-server',
  'i18n',
  'design',
  'opened-editor',
  'extension',
  'debug',
  'terminal-next',
  'testing',
  'ai-native',
  'quick-open',
  'task',
  'webview',
  'file-tree-next',
  'comments',
  'scm',
  'extension-manager',
  'electron-basic',
  'core-electron-main',
  'collaboration',
  'notebook',
  'startup',
].map((directory) => path.join('packages', directory));
packageDirectories.push('tools/dev-tool');
const installedPackages = new Map<string, string>();

// Copy the published files into an independent consumer. Link only declared
// dependencies so resolution cannot accidentally rely on the repository root.
for (const directory of packageDirectories) {
  const original = path.join(repoRoot, directory);
  const manifest = JSON.parse(fs.readFileSync(path.join(original, 'package.json'), 'utf8'));
  const installed = path.join(fixture, 'node_modules', manifest.name);
  fs.mkdirSync(installed, { recursive: true });
  fs.copyFileSync(path.join(original, 'package.json'), path.join(installed, 'package.json'));
  for (const files of manifest.files) {
    fs.cpSync(path.join(original, files), path.join(installed, files), { recursive: true });
  }
  installedPackages.set(manifest.name, installed);
}
for (const directory of packageDirectories) {
  const original = path.join(repoRoot, directory);
  const manifest = JSON.parse(fs.readFileSync(path.join(original, 'package.json'), 'utf8'));
  const requireFromPackage = createRequire(path.join(original, 'package.json'));
  const installed = installedPackages.get(manifest.name)!;
  const dependencies = new Set([
    ...Object.keys(manifest.dependencies || {}),
    ...Object.keys(manifest.peerDependencies || {}).filter(
      (dependency) => !manifest.peerDependenciesMeta?.[dependency]?.optional,
    ),
  ]);
  for (const dependency of dependencies) {
    if (installedPackages.has(dependency)) {
      continue;
    }
    let entry: string;
    try {
      entry = requireFromPackage.resolve(`${dependency}/package.json`);
    } catch {
      entry = requireFromPackage.resolve(dependency);
    }
    let dependencyDirectory = path.dirname(entry);
    while (!fs.existsSync(path.join(dependencyDirectory, 'package.json'))) {
      const parent = path.dirname(dependencyDirectory);
      assert.notEqual(parent, dependencyDirectory, `Cannot locate ${dependency}`);
      dependencyDirectory = parent;
    }
    const target = path.join(installed, 'node_modules', dependency);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.symlinkSync(dependencyDirectory, target, 'dir');
  }
}
after(() => fs.rmSync(fixture, { recursive: true, force: true }));

test('source tooling uses the same explicit entrypoints as package consumers', () => {
  const config = JSON.parse(fs.readFileSync(path.join(repoRoot, 'configs/ts/tsconfig.resolve.json'), 'utf8'));
  for (const directory of packageDirectories) {
    const packageDirectory = path.join(repoRoot, directory);
    const manifest = JSON.parse(fs.readFileSync(path.join(packageDirectory, 'package.json'), 'utf8'));
    const sourcePaths = packageSourceExports(packageDirectory, manifest)!;
    const configured = Object.fromEntries(
      Object.entries(config.compilerOptions.paths as Record<string, string[]>).filter(
        ([specifier]) => specifier === manifest.name || specifier.startsWith(`${manifest.name}/`),
      ),
    );
    assert.deepEqual(Object.keys(configured).sort(), Object.keys(sourcePaths).sort());
    for (const [specifier, source] of Object.entries(sourcePaths)) {
      assert.equal(fs.existsSync(source), true, specifier);
      assert.deepEqual(configured[specifier], [path.relative(path.join(repoRoot, 'configs/ts'), source)]);
    }
  }
  assert.throws(
    () =>
      packageSourceExports(fixture, { name: '@fixture/pkg', exports: { './*': { 'opensumi-source': './src/*.ts' } } }),
    /explicit package-local files/,
  );
});

test('every public entry and style resolves to a published file while implementation paths stay private', () => {
  const resolutions: Record<string, string> = {};
  const privateSpecifiers: string[] = [];
  for (const [name, directory] of installedPackages) {
    const manifest = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    for (const [subpath, value] of Object.entries(manifest.exports)) {
      const specifier = name + subpath.slice(1);
      const conditions = typeof value === 'string' ? { default: value } : (value as Record<string, string>);
      resolutions[specifier] = path.resolve(directory, conditions.default);
      for (const target of Object.values(conditions)) {
        assert.ok(fs.statSync(path.join(directory, target)).isFile(), `${specifier}: ${target}`);
        assert.ok(
          target === './package.json' || manifest.files.includes(target.split('/')[1]),
          `${specifier} must be included in the published files`,
        );
      }
    }
    for (const privatePath of [
      'lib',
      'lib/index',
      'src',
      'src/index',
      'public/implementation',
      '__mocks__/storage',
      '__test__/common/ws-channel',
    ]) {
      privateSpecifiers.push(`${name}/${privatePath}`);
    }
  }
  // A plain Node process has no tsx hooks or repository source aliases.
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
      const assert = require('node:assert/strict');
      for (const [specifier, target] of Object.entries(${JSON.stringify(resolutions)})) {
        assert.equal(require.resolve(specifier), target);
      }
      for (const specifier of ${JSON.stringify(privateSpecifiers)}) {
        assert.throws(() => require.resolve(specifier), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
      }
    `,
    ],
    { cwd: fixture, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('Node consumers can use the public API and cannot load private implementation paths', () => {
  const script = `
    const assert = require('node:assert/strict');
    const common = require('@opensumi/ide-core-common');
    const utils = require('@opensumi/ide-utils');
    assert.equal(common.Emitter, utils.Emitter);
    assert.equal(require('@opensumi/ide-utils/strings').format('{0}', 'public'), 'public');
    assert.equal(require('@opensumi/ide-utils/path').join('a', 'b'), 'a/b');
    assert.equal(require('@opensumi/ide-utils/argv').parseArgv(['--mode', 'node']).mode, 'node');
    assert.equal(require('@opensumi/ide-utils/icon-labels').parseLabelWithIcons('$(check) Ready').text, ' Ready');
    const { SumiReadableStream } = require('@opensumi/ide-utils/stream');
    const stream = new SumiReadableStream();
    assert.equal(typeof stream.on, 'function');
    assert.equal(typeof require('@opensumi/ide-core-common/node/ipc').normalizedIpcHandlerPathAsync, 'function');
    assert.equal(typeof require('@opensumi/ide-core-common/node/ports').findFreePort, 'function');
    assert.equal(require('@opensumi/ide-connection/protocols').CommonServerProtocol.name, common.CommonServerPath);
    assert.equal(require('@opensumi/ide-core-browser/ai/commands').AI_PANEL_LAYOUT_CONTEXT, 'aiNative.panelLayout');
    const { RawContextKey } = require('@opensumi/ide-core-common/contextkeys');
    assert.equal(RawContextKey.and(new RawContextKey('enabled', true), 'ready'), 'enabled && ready');
    assert.equal(require('@opensumi/ide-core-common/workbench').DEBUG_CONTAINER_ID, 'debug');
    const theme = require('@opensumi/ide-theme');
    assert.equal(theme.Color, require('@opensumi/ide-theme/colors').Color);
    assert.equal(theme.CSSVarRegistry.instance().get('stacking-level-popover-component'), '999');
    assert.equal(theme.getColorRegistry(), require('@opensumi/ide-theme/color-registry').getColorRegistry());
    assert.ok(theme.getColorRegistry().getColors().length > 0);
    assert.equal(theme.Color.fromHex('#123456').toString(), '#123456');
    const files = require('@opensumi/ide-file-service');
    assert.equal(files.FileType, common.FileType);
    assert.equal(require('@opensumi/ide-file-service/protocols').DiskFileServiceProtocol.name, files.DiskFileServicePath);
    const { SlotLocation } = require('@opensumi/ide-core-common/workbench');
    const layout = require('@opensumi/ide-main-layout');
    assert.ok(layout.SUPPORT_ACCORDION_LOCATION.has(SlotLocation.view));
    assert.ok(new layout.TabBarRegistrationEvent({ tabBarId: 'test' }) instanceof common.BasicEvent);
    assert.equal(typeof require('@opensumi/ide-workspace').IWorkspaceService, 'symbol');
    assert.equal(require('@opensumi/ide-core-common/storage').StorageService, common.StorageService);
    const { WorkspaceData } = require('@opensumi/ide-workspace/data');
    const workspaceData = WorkspaceData.buildWorkspaceData(['file:///workspace/project'], { setting: true });
    assert.equal(WorkspaceData.is(workspaceData), true);
    assert.equal(WorkspaceData.is({ folders: [{}] }), false);
    assert.deepEqual(WorkspaceData.transformToRelative(workspaceData, { uri: 'file:///workspace/dev.sumi-workspace' }).folders, [{ path: 'project' }]);
    const output = require('@opensumi/ide-output');
    assert.ok(new output.ContentChangeEvent(new output.ContentChangeEventPayload('test', output.ContentChangeType.append, 'hello', [])) instanceof common.BasicEvent);
    const preferences = require('@opensumi/ide-preferences');
    assert.equal(preferences.toPreferenceReadableName('javascript.format.enable'), 'JavaScript > Format : Enable');
    assert.equal(preferences.getPreferenceItemLabel({ id: 'editor.fontSize' }), 'Editor > Font Size');
    assert.equal(typeof require('@opensumi/ide-core-common/preferences').IPreferenceSettingsService, 'symbol');
    const keybindings = require('@opensumi/ide-core-common/keybindings');
    assert.equal(keybindings.Keybinding.stringify({ command: 'save', keybinding: 'ctrl+s', priority: 1 }), '{"command":"save","keybinding":"ctrl+s"}');
    assert.equal(keybindings.Keybinding.is({ command: 'save', keybinding: 'ctrl+s' }), true);
    const matches = new keybindings.KeybindingsResultCollection.KeybindingsResult();
    matches.full.push({ command: 'save', keybinding: 'ctrl+s' });
    assert.equal(matches.filter(binding => binding.command === 'save').full.length, 1);
    assert.equal(typeof require('@opensumi/ide-keymaps').IKeymapService, 'symbol');
    assert.equal(typeof require('@opensumi/ide-file-search').IFileSearchService, 'symbol');
    assert.equal(typeof require('@opensumi/ide-outline').IOutlineDecorationService, 'symbol');
    assert.equal(typeof require('@opensumi/ide-workspace-edit/types').IWorkspaceFileService, 'symbol');
    assert.equal(typeof require('@opensumi/ide-logs').ILogServiceForClient, 'symbol');
    assert.equal(typeof require('@opensumi/ide-extension-storage').IExtensionStorageService, 'symbol');
    assert.equal(require('@opensumi/ide-file-scheme').ChangeType.ADDED, 1);
    assert.equal(typeof require('@opensumi/ide-decoration').IDecorationsService, 'function');
    assert.equal(require('@opensumi/ide-storage').IGlobalStorageServer, 'IGlobalStorageServer');
    assert.equal(typeof require('@opensumi/ide-process').IProcessFactory, 'symbol');
    const overlay = require('@opensumi/ide-overlay');
    assert.equal(overlay.IOpenDialogOptions.is({ canSelectFiles: true }), true);
    assert.equal(overlay.ISaveDialogOptions.is({ canSelectFiles: true }), false);
    const search = require('@opensumi/ide-search');
    assert.equal(typeof search.IContentSearchServer, 'symbol');
    assert.equal(search.getRoot(['file:///workspace'], 'file:///workspace/file.ts'), 'file:///workspace');
    assert.ok(!Object.keys(require.cache).some(file => /ide-core-browser[/\\\\](?:lib|src)[/\\\\](?:index\\.js|services[/\\\\])/.test(file)));
    assert.throws(() => require('@opensumi/ide-core-common/electron').throwNonElectronError('example'), /example/);
    for (const specifier of ['@opensumi/ide-utils/lib/stream', '@opensumi/ide-utils/src/stream.ts',
      '@opensumi/ide-core-common/lib/utils/ipc', '@opensumi/ide-core-common/src/utils/ipc',
      '@opensumi/ide-core-common/hash-calculate/mutex']) {
      assert.throws(() => require.resolve(specifier), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    }
    (async () => {
      const { Emitter } = await import('@opensumi/ide-utils');
      assert.equal(Emitter, utils.Emitter);
      const { HashCalculateServiceImpl } = require('@opensumi/ide-core-common/hash');
      const hash = new HashCalculateServiceImpl();
      await hash.initialize();
      assert.equal(hash.calculate('OpenSumi'), require('node:crypto').createHash('md5').update('OpenSumi').digest('hex'));
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: fixture, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('RPC contracts and file watcher identities load without transport implementations', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const assert = require('node:assert/strict');
      const contracts = require('@opensumi/ide-connection/rpc-contracts');
      const files = require('@opensumi/ide-file-service');
      assert.ok(files.WatcherServiceProxy instanceof contracts.ProxyIdentifier);
      assert.equal(files.WatcherServiceProxy.serviceId, 'WatcherHostServiceImpl');
      const connectionRoot = require('node:path').dirname(require.resolve('@opensumi/ide-connection/package.json'));
      const loaded = Object.keys(require.cache).filter(file => file.startsWith(connectionRoot + '/'));
      assert.deepEqual(loaded.map(file => file.slice(connectionRoot.length)).sort(), [
        '/lib/common/connection/drivers/base.js', '/lib/common/rpc-contracts.js',
      ]);
      const root = require('@opensumi/ide-connection');
      for (const name of ['ProxyIdentifier', 'IRPCProtocol', 'BaseConnection', 'RPCProtocolEnv',
        'createMainContextProxyIdentifier', 'createExtHostContextProxyIdentifier']) {
        assert.equal(root[name], contracts[name], name);
      }
      const first = contracts.createMainContextProxyIdentifier('main');
      const second = root.createExtHostContextProxyIdentifier('extension');
      const third = contracts.ProxyIdentifier.for('third');
      assert.equal(second.countId, first.countId + 1);
      assert.equal(third.countId, second.countId + 1);
      assert.equal(contracts.ProxyIdentifier.count, third.countId);
      assert.deepEqual([contracts.RPCProtocolEnv.MAIN, contracts.RPCProtocolEnv.EXT], [0, 1]);`,
    ],
    { cwd: fixture, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('shared context events and menu nodes load without a browser runtime', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const assert = require('node:assert/strict');
      const { IContextKeyService, ContextKeyChangeEvent, RawContextKey } = require('@opensumi/ide-core-common/contextkeys');
      assert.equal(typeof IContextKeyService, 'symbol');
      const changed = new Set(['enabled']);
      const event = new ContextKeyChangeEvent({ affectsSome: keys => [...changed].some(key => keys.has(key)) });
      assert.equal(event.payload.affectsSome(new Set(['enabled'])), true);
      assert.equal(event.payload.affectsSome(new Set(['visible'])), false);
      assert.equal(RawContextKey.and(new RawContextKey('enabled', true), 'visible'), 'enabled && visible');
      const { MenuNode } = require('@opensumi/ide-core-common/menus');
      const status = require('@opensumi/ide-core-common/status-bar');
      assert.equal(status.IStatusBarService, require('@opensumi/ide-status-bar').IStatusBarService);
      assert.deepEqual([status.StatusBarAlignment.LEFT, status.StatusBarAlignment.RIGHT], [0, 1]);
      const node = new MenuNode({ id: 'save', label: 'Save', checked: true, type: 'checkbox', execute: args => args.join(':') });
      assert.equal(node.execute('a', 'b'), 'a:b');
      assert.equal(node.checked, true);
      assert.equal(node.disabled, false);
      node.updateLabel('Save All'); assert.equal(node.label, 'Save All');
      assert.equal(require('@opensumi/ide-core-common').MenuNode, MenuNode);
      assert.deepEqual(Object.keys(require.cache).filter(file => /ide-core-browser|ide-components|node_modules[/\\\\]react[/\\\\]/.test(file)), []);`,
    ],
    { cwd: fixture, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('published service contracts and language bundles load without browser implementations', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
      const assert = require('node:assert/strict');
      const common = require('@opensumi/ide-core-common');
      const status = require('@opensumi/ide-status-bar');
      assert.equal(status.IStatusBarService, require('@opensumi/ide-core-browser/status-bar').IStatusBarService);
      assert.equal(require('@opensumi/ide-toolbar/types').ToolBarPosition.CENTER, 2);
      assert.equal(typeof require('@opensumi/ide-variable').IVariableResolverService, 'symbol');
      assert.equal(typeof require('@opensumi/ide-markdown/types').IMarkdownService, 'symbol');
      assert.equal(require('@opensumi/ide-design').DESIGN_MENUBAR_CONTAINER_VIEW_ID, 'design_menubar');
      assert.equal(require('@opensumi/ide-opened-editor').ExplorerOpenedEditorViewId, 'file-opened-editor');
      const markers = require('@opensumi/ide-markers');
      const model = markers.MarkerModelBuilder.buildModel('file:///workspace/test.ts', '', 'test.ts', 'test.ts', []);
      assert.equal(model.size(), 0);
      const matcher = new markers.ResourceGlobMatcher({ '**/*.ts': true }, []);
      assert.equal(matcher.matches(common.URI.parse('file:///workspace/test.ts')), true);
      assert.equal(matcher.matches(common.URI.parse('file:///workspace/test.txt')), false);
      require('@opensumi/ide-i18n');
      for (const language of ['en-US', 'zh-CN']) {
        const bundle = require('@opensumi/ide-i18n/languages/' + language).localizationBundle;
        assert.equal(bundle.languageId, language);
        assert.equal(common.localize('ButtonCancel', undefined, 'host', language), bundle.contents.ButtonCancel);
      }
      for (const [name, moduleName] of [['remote-opener', 'OpenerModule'], ['addons', 'AddonsModule'], ['express-file-server', 'ExpressFileServerModule']]) {
        const Module = require('@opensumi/ide-' + name + '/node')[moduleName];
        assert.ok(new Module().providers.length > 0, name);
      }
      assert.equal(require('@opensumi/ide-remote-opener').RemoteOpenerServicePath, 'RemoteOpenerService');
      assert.equal(require('@opensumi/ide-express-file-server').ALLOW_MIME.svg, 'image/svg+xml');
      assert.equal(typeof window, 'undefined');
      assert.ok(!Object.keys(require.cache).some(file => /ide-core-browser[/\\\\](?:lib|src)[/\\\\](?:index\\.js|services[/\\\\]label-service\\.js)/.test(file)));
    `,
    ],
    { cwd: fixture, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('a published development injector works without TypeScript loaders or Jest globals', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
      const assert = require('node:assert/strict');
      const { MockInjector } = require('@opensumi/ide-dev-tool/injector');
      class Example { read() { return 'original'; } }
      const injector = new MockInjector();
      injector.addProviders({ token: Example, useValue: new Example() });
      injector.mock(Example, 'read', () => 'mocked');
      assert.equal(injector.get(Example).read(), 'mocked');
      injector.mock(Example, 'read', () => 'updated');
      assert.equal(injector.get(Example).read(), 'updated');
      assert.equal(typeof require('@opensumi/ide-dev-tool/assertions').expectThrowsAsync, 'function');
      assert.equal(typeof require('@opensumi/ide-dev-tool/server').startServer, 'function');
      assert.equal(typeof require('@opensumi/ide-dev-tool/asset-manifest').AssetManifestPlugin, 'function');
      assert.ok(require.resolve('@opensumi/ide-dev-tool/host/logger').endsWith('/lib/mock-log-service.js'));
      assert.ok(require.resolve('@opensumi/ide-file-service/node/watcher-process').endsWith('/lib/node/hosted/watcher.process.js'));
      assert.throws(() => require('@opensumi/ide-dev-tool/src/mock-injector'), { code: 'ERR_PACKAGE_PATH_NOT_EXPORTED' });
    `,
    ],
    { cwd: fixture, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('published debug, terminal and testing APIs retain their runtime values and Node registrations', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const assert = require('node:assert/strict');
       const { MemoryRangeType, DEBUG_CONTAINER_ID } = require('@opensumi/ide-debug');
       assert.equal(MemoryRangeType.Unreadable, 1);
       assert.equal(DEBUG_CONTAINER_ID, 'debug');
       const terminal = require('@opensumi/ide-terminal-next');
       const { TerminalNodePtyModule } = require('@opensumi/ide-terminal-next/node');
       const { PtyServiceManager, PtyServiceManagerToken } = require('@opensumi/ide-terminal-next/node/pty-manager');
       const module = new TerminalNodePtyModule();
       assert.ok(module.providers.some(provider => provider.token === PtyServiceManagerToken && provider.useClass === PtyServiceManager));
       assert.ok(module.backServices.some(service => service.servicePath === terminal.ITerminalProcessPath));
       const { TestId, TestPosition } = require('@opensumi/ide-testing');
       const parent = new TestId(['controller']);
       const child = TestId.join(parent, 'case');
       assert.equal(TestId.compare(parent.toString(), child.toString()), TestPosition.IsChild);
       assert.equal(TestId.fromString(child.toString()).localId, 'case');
       const { ObservableValue } = require('@opensumi/ide-testing/observable');
       const value = new ObservableValue(0);
       const observed = [];
       value.onDidChange(event => observed.push(event));
       value.value = 1; value.value = 1; value.value = 2; value.dispose();
       assert.deepEqual(observed, [1, 2]);
       assert.deepEqual(Object.keys(require.cache).filter(file =>
         /core-browser\\/lib\\/(?:index.js|services\\/)/.test(file) ||
         /monaco-editor-core[^\\n]*\\/vs\\/base\\/browser\\//.test(file)), []);`,
    ],
    { cwd: fixture, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('published build factories use the consuming project and invalidate cached feature flags', async () => {
  const app = path.join(fixture, 'dev-tool-app');
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'dev-tool-consumer', private: true }));
  fs.writeFileSync(
    path.join(app, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { module: 'commonjs', target: 'ES2018', esModuleInterop: true } }),
  );
  const entry = path.join(app, 'entry.ts');
  fs.writeFileSync(
    entry,
    "import { format } from '@opensumi/ide-utils/strings'; import styles from './entry.module.less'; globalThis.devToolBuild = format('ai={0}', process.env.ENABLE_AI); globalThis.devToolStyle = styles.label;",
  );
  fs.writeFileSync(path.join(app, 'entry.module.less'), '.label { color: #123456; }');
  const consumerRequire = createRequire(path.join(fixture, 'consumer.cjs'));
  const factories = consumerRequire('@opensumi/ide-dev-tool/rspack');
  const { AssetManifestPlugin } = consumerRequire('@opensumi/ide-dev-tool/asset-manifest');
  const previous = { NODE_ENV: process.env.NODE_ENV, CI: process.env.CI, ENABLE_AI: process.env.ENABLE_AI };
  async function compile(config: Configuration) {
    const compiler = rspack(config)!;
    try {
      return await new Promise<Stats>((resolve, reject) => {
        compiler.run((error, stats) => {
          if (error || stats?.hasErrors() || !stats) {
            reject(error || new Error(stats?.toString({ all: false, errors: true })));
          } else {
            resolve(stats);
          }
        });
      });
    } finally {
      await new Promise<void>((resolve, reject) => compiler.close((error) => (error ? reject(error) : resolve())));
    }
  }
  function checkOutput(file: string, property: string, value: unknown) {
    const result = spawnSync(
      process.execPath,
      [
        '-e',
        `require(${JSON.stringify(file)}); require('node:assert/strict').deepEqual(globalThis[${JSON.stringify(property)}], ${JSON.stringify(value)});`,
      ],
      { cwd: app, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
  }
  try {
    process.env.NODE_ENV = 'production';
    process.env.CI = '1';
    for (const [index, flag] of ['0', '1', '1'].entries()) {
      process.env.ENABLE_AI = flag;
      const config = factories.createRspackConfig(app, entry);
      config.plugins.push(new AssetManifestPlugin());
      assert.equal(config.context, app);
      assert.equal(config.resolve.tsConfig.configFile, path.join(app, 'tsconfig.json'));
      const stats = await compile(config);
      checkOutput(path.join(app, 'dist/bundle.js'), 'devToolBuild', `ai=${flag}`);
      const manifest = JSON.parse(fs.readFileSync(path.join(app, 'dist/manifest.json'), 'utf8'));
      const css = fs.readFileSync(path.join(app, 'dist', manifest['main.css']), 'utf8');
      const className = css.match(/\.(label___[\w-]+)/)?.[1];
      assert.ok(className, css);
      checkOutput(path.join(app, 'dist/bundle.js'), 'devToolStyle', className);
      if (index === 2) {
        const modules = stats.toJson({ all: false, modules: true, cachedModules: true }).modules || [];
        const entryModule = modules.find((module) => module.nameForCondition === entry);
        assert.ok(entryModule, JSON.stringify(modules));
        assert.equal(entryModule.built, false, 'The unchanged entry should be restored from the persistent cache');
      }
    }
    const nodeEntry = path.join(app, 'node.ts');
    fs.writeFileSync(nodeEntry, 'globalThis.devToolNode = 7;');
    await compile(factories.createNodeRspackConfig(nodeEntry, path.join(app, 'node-dist')));
    checkOutput(path.join(app, 'node-dist/server.js'), 'devToolNode', 7);
    const webviewEntry = path.join(app, 'webview.ts');
    fs.writeFileSync(webviewEntry, 'globalThis.devToolWebview = 9;');
    fs.writeFileSync(path.join(app, 'webview.html'), '<!doctype html><html><body></body></html>');
    await compile(factories.createWebviewRspackConfig(webviewEntry, app, '/webview-dist'));
    checkOutput(path.join(app, 'webview-dist/webview.js'), 'devToolWebview', 9);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('published feature APIs preserve action state, shared events and backend module registrations', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const assert = require('node:assert/strict');
       const { BasicEvent, AIBackSerivcePath } = require('@opensumi/ide-core-common');
       const { QuickOpenBaseAction } = require('@opensumi/ide-quick-open');
       class Action extends QuickOpenBaseAction { async run() {} }
       const action = new Action({ id: 'disabled', enabled: false });
       assert.equal(action.enabled, false);
       action.enabled = true; assert.equal(action.enabled, true);
       action.enabled = false; assert.equal(action.enabled, false);
       assert.equal(new Action({ id: 'default' }).enabled, true);
       const { TaskExecuteKind, TerminateResponseCode } = require('@opensumi/ide-task');
       assert.equal(TaskExecuteKind.Started, 1); assert.equal(TerminateResponseCode.Success, 0);
       const { CommentPanelCollapse } = require('@opensumi/ide-comments');
       assert.ok(new CommentPanelCollapse() instanceof BasicEvent);
       const { FileTreeExpandedStatusUpdateEvent } = require('@opensumi/ide-file-tree-next/types');
       assert.ok(new FileTreeExpandedStatusUpdateEvent({ expanded: true }) instanceof BasicEvent);
       assert.equal(require('@opensumi/ide-scm').InputValidationType.Error, 0);
       assert.equal(require('@opensumi/ide-webview/common').WebviewScheme, 'kaitian-webview');
       const { AINativeModule } = require('@opensumi/ide-ai-native/node');
       assert.ok(new AINativeModule().backServices.some(service => service.servicePath === AIBackSerivcePath));
       const { OpenVsxExtensionManagerModule } = require('@opensumi/ide-extension-manager/node');
       const { IOpenvsxMarketplaceService } = require('@opensumi/ide-extension-manager');
       assert.ok(new OpenVsxExtensionManagerModule().providers.some(provider => provider.token === IOpenvsxMarketplaceService));
       assert.deepEqual(Object.keys(require.cache).filter(file =>
         /core-browser\\/lib\\/(?:index.js|services\\/)/.test(file) ||
         /monaco-editor-core[^\\n]*\\/vs\\/base\\/browser\\//.test(file)), []);`,
    ],
    { cwd: fixture, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('quick input and recent file services run independently of browser packages', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const assert = require('node:assert/strict');
       const common = require('@opensumi/ide-core-common');
       const quick = require('@opensumi/ide-core-common/quick-open');
       const history = require('@opensumi/ide-core-common/recent-files');
       const { FilesChangeEvent } = require('@opensumi/ide-core-common/file-events');
       const { VALIDATE_TYPE } = require('@opensumi/ide-core-common/validation');
       const publicQuick = require('@opensumi/ide-quick-open');
       const { autorun, transaction } = require('@opensumi/ide-monaco/observable');
       const requireCommon = require('node:module').createRequire(require.resolve('@opensumi/ide-core-common/package.json'));
       const { Injector } = requireCommon('@opensumi/di');
       assert.deepEqual(Object.keys(require.cache).filter(file => /ide-core-browser/.test(file)), []);
       const legacyQuick = require('@opensumi/ide-core-browser/quick-open');
       for (const name of ['QuickOpenItem', 'QuickOpenService', 'QuickPickService', 'IQuickInputService', 'RecentFilesManager', 'Mode']) {
         assert.equal(publicQuick[name], quick[name], name);
         assert.equal(legacyQuick[name], quick[name], name);
       }
       assert.equal(quick.RecentFilesManager, history.RecentFilesManager);
       assert.deepEqual([VALIDATE_TYPE.INFO, VALIDATE_TYPE.ERROR, VALIDATE_TYPE.WARNING, VALIDATE_TYPE.IGNORE], [1, 2, 3, 4]);
       const runs = [];
       const item = new quick.QuickOpenItem({ label: 'Save', checked: true, run(mode) { runs.push(mode); return mode === quick.Mode.OPEN; } });
       const checked = [];
       const listener = autorun(reader => checked.push(item.checked.read(reader)));
       transaction(tx => item.checked.set(false, tx));
       listener.dispose();
       assert.deepEqual(checked, [true, false]);
       assert.equal(item.run(quick.Mode.PREVIEW), false);
       assert.equal(item.run(quick.Mode.OPEN), true);
       assert.deepEqual(runs, [0, 1]);
       (async () => {
         const storages = new Map();
         const bus = new common.EventBusImpl();
         const injector = new Injector([
           { token: common.IEventBus, useValue: bus },
           { token: common.StorageProvider, useValue: async uri => {
             const id = uri.toString();
             if (!storages.has(id)) {
               const values = new Map();
               storages.set(id, { get: key => values.get(key), async set(key, value) { values.set(key, value); } });
             }
             return storages.get(id);
           } },
         ]);
         const recent = injector.get(history.RecentFilesManager);
         for (let i = 0; i < 52; i++) await recent.setMostRecentlyOpenedFile('file:///' + i);
         let files = await recent.getMostRecentlyOpenedFiles();
         assert.equal(files.length, 50);
         assert.equal(files[0], 'file:///51');
         assert.equal(files.at(-1), 'file:///2');
         await recent.setMostRecentlyOpenedFile('file:///25');
         await recent.updateMostRecentlyOpenedFile('file:///25', { lineNumber: 7, column: 3 });
         assert.equal((await recent.getMostRecentlyOpenedFiles(true))[0], 'file:///25#7,3');
         bus.fire(new FilesChangeEvent([{ type: common.FileChangeType.DELETED, uri: 'file:///25' }]));
         await new Promise(setImmediate);
         assert.equal((await recent.getMostRecentlyOpenedFiles()).includes('file:///25'), false);
         recent.dispose();
         bus.fire(new FilesChangeEvent([{ type: common.FileChangeType.DELETED, uri: 'file:///51' }]));
         await new Promise(setImmediate);
         assert.equal((await recent.getMostRecentlyOpenedFiles()).includes('file:///51'), true);
         assert.equal(storages.size, 1);
       })().catch(error => { console.error(error); process.exitCode = 1; });`,
    ],
    { cwd: fixture, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('testing command icons preserve custom mappings without loading UI components', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const assert = require('node:assert/strict');
       const { getIcon, updateIconMap, ROTATE_TYPE, ANIM_TYPE } = require('@opensumi/ide-components/icon-utils');
       const { getExternalIcon, getOctIcon, asClassNameArrayWrapper } = require('@opensumi/ide-core-common/icon-names');
       assert.equal(getExternalIcon('sync'), 'codicon codicon-sync');
       assert.equal(getExternalIcon('unknown-public-icon'), 'octicon octicon-unknown-public-icon');
       assert.equal(getExternalIcon('unknown-public-icon', 'codicon', false), 'codicon codicon-unknown-public-icon');
       assert.equal(getExternalIcon('magic-wand', 'kticon'), 'kaitian-icon kticon-magic-wand');
       assert.equal(getOctIcon('sync'), 'octicon octicon-sync');
       assert.deepEqual(asClassNameArrayWrapper({ id: 'magic-wand' }), ['kaitian-icon', 'kticon-magic-wand']);
       assert.deepEqual(asClassNameArrayWrapper({ id: 'sync~spin' }), ['codicon', 'codicon-sync', 'codicon-modifier-spin']);
       assert.equal(getIcon('refresh'), 'kaitian-icon kticon-refresh');
       updateIconMap('public-icon ', { refresh: 'refresh-custom' });
       assert.equal(getIcon('refresh', { rotate: ROTATE_TYPE.rotate_90, anim: ANIM_TYPE.spin, fill: true }),
         'public-icon refresh-custom iconfont-rotate-90 iconfont-anim-spin toggled');
       const commands = require('@opensumi/ide-testing/commands');
       assert.equal(commands.RefreshTestsCommand.iconClass, 'public-icon refresh-custom');
       assert.equal(commands.GoToPreviousMessage.iconClass, 'kaitian-icon kticon-arrowup');
       assert.equal(commands.ClearTestResults.iconClass, 'codicon codicon-clear-all');
       assert.deepEqual(Object.keys(require.cache).filter(file =>
         /ide-core-browser|ide-components[/\\\\](?:src|lib)[/\\\\]index|node_modules[/\\\\]react[/\\\\]/.test(file)), []);`,
    ],
    { cwd: fixture, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  const file = path.join(fixture, 'icon-command-consumer.ts');
  fs.writeFileSync(
    file,
    `import { getIcon, ROTATE_TYPE, IIconShapeOptions } from '@opensumi/ide-components/icon-utils';
     import { getExternalIcon } from '@opensumi/ide-core-common/icon-names';
     import { RefreshTestsCommand } from '@opensumi/ide-testing/commands';
     const shape: IIconShapeOptions = { rotate: ROTATE_TYPE.rotate_90 };
     const icon: string = getIcon('refresh', shape);
     const external: string = getExternalIcon('refresh');
     const command: string = RefreshTestsCommand.id;
     // @ts-expect-error rotation remains a numeric enum
     const invalid: IIconShapeOptions = { rotate: '90deg' };`,
  );
  for (const [module, moduleResolution] of [
    [ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext],
    [ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler],
  ] as const) {
    const program = ts.createProgram([file], {
      module,
      moduleResolution,
      target: ts.ScriptTarget.ES2022,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    });
    assert.deepEqual(
      ts.getPreEmitDiagnostics(program).map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')),
      [],
    );
    assert.deepEqual(
      program
        .getSourceFiles()
        .filter((source) =>
          /ide-core-browser\/|ide-components\/lib\/(?:index|icon\/index)\.d\.ts|monaco-editor-core[^\n]*\/vs\/base\/browser\//.test(
            source.fileName,
          ),
        )
        .map((source) => source.fileName),
      [],
    );
  }
});

test('published host contracts retain service identity and resolve preload dependencies', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const assert = require('node:assert/strict');
       const { createRequire } = require('node:module');
       const { BasicModule } = require('@opensumi/ide-core-common');
       const { IElectronHeaderService } = require('@opensumi/ide-electron-basic');
       const { ElectronMainModule } = require('@opensumi/ide-core-electron-main/module');
       const { ElectronAppConfig, ElectronMainContribution } = require('@opensumi/ide-core-electron-main/types');
       assert.equal(typeof IElectronHeaderService, 'symbol');
       assert.equal(typeof ElectronAppConfig, 'symbol');
       assert.equal(typeof ElectronMainContribution, 'symbol');
       assert.ok(new ElectronMainModule() instanceof BasicModule);
       const { CollaborationModule } = require('@opensumi/ide-collaboration/node');
       const { CollaborationServiceForClientPath, ICollaborationServiceForClient, UNDO } = require('@opensumi/ide-collaboration');
       const module = new CollaborationModule();
       assert.ok(module.backServices.some(service => service.servicePath === CollaborationServiceForClientPath && service.token === ICollaborationServiceForClient));
       assert.ok(module.providers.some(provider => provider.token === ICollaborationServiceForClient));
       assert.equal(UNDO.id, 'collaboration.undo');
       const preload = require.resolve('@opensumi/ide-core-electron-main/browser-preload.js');
       const preloadRequire = createRequire(preload);
       assert.ok(require('node:fs').statSync(preloadRequire.resolve('vscode-oniguruma/release/onig.wasm')).size > 0);
       assert.deepEqual(Object.keys(require.cache).filter(file =>
         /core-browser\\/lib\\/(?:index.js|services\\/)/.test(file) ||
         /monaco-editor-core[^\\n]*\\/vs\\/base\\/browser\\//.test(file)), []);`,
    ],
    { cwd: fixture, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('the published runtime policy works before package compilation or dependency installation', () => {
  const app = path.join(fixture, 'bootstrap-only');
  const original = installedPackages.get('@opensumi/ide-startup')!;
  const installed = path.join(app, 'node_modules/@opensumi/ide-startup');
  fs.mkdirSync(installed, { recursive: true });
  fs.copyFileSync(path.join(original, 'package.json'), path.join(installed, 'package.json'));
  fs.cpSync(path.join(original, 'bootstrap'), path.join(installed, 'bootstrap'), { recursive: true });
  const result = spawnSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';
       import { createRequire } from 'node:module';
       import { resolveProductRuntimeMode } from '@opensumi/ide-startup/runtime-mode';
       assert.equal(resolveProductRuntimeMode({}), 'node');
       assert.equal(resolveProductRuntimeMode({ OPENSUMI_RUNTIME_MODE: ' NODE ' }), 'node');
       assert.throws(() => resolveProductRuntimeMode({ OPENSUMI_RUNTIME_MODE: 'auto' }), /must be node/);
       const require = createRequire(process.cwd() + '/consumer.cjs');
       assert.equal(require('@opensumi/ide-startup/runtime-mode').resolveProductRuntimeMode, resolveProductRuntimeMode);
       assert.equal(Object.keys(require.cache).length, 1);`,
    ],
    { cwd: app, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.existsSync(path.join(installed, 'lib')), false);
});

test('published Startup catalogs preserve product and Node module bindings', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const assert = require('node:assert/strict');
       const { compileOpenSumiProductRuntimePlan } = require('@opensumi/ide-startup');
       assert.deepEqual(Object.keys(require.cache).filter(file => /ide-core-(browser|node)/.test(file)), []);
       const { CommonNodeBindings, CommonNodeModules, CommonNodeRuntimePlan } = require('@opensumi/ide-startup/node/modules');
       const { AINodeBindings } = require('@opensumi/ide-startup/node/ai');
       const { CollaborationNodeBindings } = require('@opensumi/ide-startup/node/collaboration');
       assert.deepEqual(CommonNodeRuntimePlan.entries.map(entry => entry.module), CommonNodeModules);
       const plan = compileOpenSumiProductRuntimePlan({ runtime: 'node', commonBindings: [...CommonNodeBindings].reverse(), options: [
         { id: 'collaboration', bindings: CollaborationNodeBindings }, { id: 'ai', bindings: AINodeBindings }
       ] });
       assert.deepEqual(plan.entries.map(entry => entry.module), [...CommonNodeBindings, ...AINodeBindings, ...CollaborationNodeBindings].map(binding => binding.module));
       assert.ok(plan.entries.every(entry => typeof entry.module === 'function'));
       assert.deepEqual(Object.keys(require.cache).filter(file => /ide-core-browser\\/lib\\/(index.js|services\\/)/.test(file)), []);`,
    ],
    { cwd: fixture, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('published diagnostic tools parse and summarize process samples outside the repository', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const assert = require('node:assert/strict');
       const { parsePosixProcessList, redactCommandLine } = require('@opensumi/ide-dev-tool/diagnostics/process-tree');
       const { percentile, summarizeRuntimeProfile } = require('@opensumi/ide-dev-tool/diagnostics/runtime-profile-metrics');
       const processes = parsePosixProcessList('10 1 2048 00:01 node server --token=fixture-secret');
       assert.equal(processes[0].rssBytes, 2097152);
       assert.ok(!processes[0].commandLine.includes('fixture-secret'));
       assert.ok(!redactCommandLine('node --password=test-secret').includes('test-secret'));
       assert.equal(percentile([1, 9, 3], 0.5), 3);
       const samples = [2, 4].map(totalRssBytes => ({ timestamp: 'test', rootPid: 10, processCount: 1, totalRssBytes, byRole: { server: { count: 1, rssBytes: totalRssBytes } }, processes: [] }));
       const metrics = summarizeRuntimeProfile(samples);
       assert.equal(metrics.p95TreeRssBytes, 4);
       assert.equal(metrics.p95RoleRssBytes.server, 4);`,
    ],
    { cwd: fixture, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('published Webview preload and HTML build together in source and compiled modes', async () => {
  const app = path.join(fixture, 'webview-app');
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'webview-consumer', private: true }));
  fs.writeFileSync(path.join(app, 'consumer.ts'), 'export {};');
  fs.writeFileSync(
    path.join(app, 'tsconfig.json'),
    JSON.stringify({ compilerOptions: { module: 'commonjs', target: 'ES2022', esModuleInterop: true } }),
  );
  const consumerRequire = createRequire(path.join(app, 'consumer.cjs'));
  const manifestPath = consumerRequire.resolve('@opensumi/ide-webview/package.json');
  const manifest = consumerRequire(manifestPath);
  const { createWebviewRspackConfig } = consumerRequire('@opensumi/ide-dev-tool/rspack');
  const sourceEntry = path.resolve(path.dirname(manifestPath), manifest.exports['./host/preload']['opensumi-source']);
  const startupConfig = path.join(app, 'startup-config.cjs');
  fs.copyFileSync(path.join(repoRoot, 'packages/startup/rspack.webview.js'), startupConfig);
  assert.equal(consumerRequire(startupConfig).entry, sourceEntry);
  const hiddenSource = sourceEntry + '.consumer-backup';
  fs.renameSync(sourceEntry, hiddenSource);
  try {
    delete consumerRequire.cache[startupConfig];
    assert.equal(consumerRequire(startupConfig).entry, consumerRequire.resolve('@opensumi/ide-webview/host/preload'));
  } finally {
    fs.renameSync(hiddenSource, sourceEntry);
    delete consumerRequire.cache[startupConfig];
  }
  assert.match(
    fs.readFileSync(consumerRequire.resolve('@opensumi/ide-webview/host/template.html'), 'utf8'),
    /Webview Panel Container/,
  );
  for (const source of [false, true]) {
    const entry = source ? sourceEntry : consumerRequire.resolve('@opensumi/ide-webview/host/preload');
    const config: Configuration = createWebviewRspackConfig(entry, app, source ? '/source' : '/compiled');
    config.mode = 'development';
    config.devtool = false;
    config.cache = false;
    config.resolve!.conditionNames = [...(source ? ['opensumi-source'] : []), 'browser', 'import', 'default'];
    const compiler = rspack(config)!;
    try {
      const stats = await new Promise<Stats>((resolve, reject) =>
        compiler.run((error, stats) => {
          if (error || !stats || stats.hasErrors()) {
            reject(error || new Error(stats?.toString({ all: false, errors: true })));
          } else {
            resolve(stats);
          }
        }),
      );
      assert.ok(
        stats.toJson({ all: false, modules: true }).modules?.some((module) => module.nameForCondition === entry),
      );
      const output = config.output!.path!;
      assert.match(fs.readFileSync(path.join(output, 'index.html'), 'utf8'), /webview\.js/);
      assert.ok(fs.statSync(path.join(output, 'webview.js')).size > 0);
    } finally {
      await new Promise<void>((resolve, reject) => compiler.close((error) => (error ? reject(error) : resolve())));
    }
  }
});

test('published Node modules resolve their protocols and register services without repository paths', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const assert = require('node:assert/strict');
       const { createRequire } = require('node:module');
       assert.throws(() => require('@opensumi/ide-file-service/node/workspace-agent'));
       assert.equal(typeof require('@opensumi/ide-file-service/node/disk-provider').DiskFileSystemProvider, 'function');
       assert.equal(typeof require('@opensumi/ide-file-service/node/watchers').WatcherProcessManagerToken, 'symbol');
       const nodeRuntime = require('@opensumi/ide-core-node');
       assert.equal(nodeRuntime.NodeModule, require('@opensumi/ide-core-node/types').NodeModule);
       class ProductModule extends nodeRuntime.NodeModule {}
       assert.ok(new ProductModule() instanceof require('@opensumi/ide-core-common').BasicModule);
       assert.equal(typeof require('@opensumi/ide-core-node/logger').INodeLogger, 'symbol');
       for (const [name, exportName, servicePath] of [
         ['file-search', 'FileSearchModule', 'FileSearchServicePath'],
         ['search', 'SearchModule', 'ContentSearchServerPath'],
         ['file-scheme', 'FileSchemeNodeModule', 'FileSchemeDocNodeService'],
         ['process', 'ProcessModule', 'ProcessManageService'],
         ['logs', 'LogServiceModule', require('@opensumi/ide-logs').LogServiceForClientPath],
       ]) {
         const Module = require('@opensumi/ide-' + name + '/node')[exportName];
         const instance = new Module();
         assert.ok(instance instanceof nodeRuntime.NodeModule, name);
         assert.ok(instance.backServices.some(service => service.servicePath === servicePath), name);
         assert.ok(instance.providers.length > 0, name);
       }`,
    ],
    { cwd: fixture, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('TypeScript NodeNext and Bundler consumers resolve declarations without source aliases', () => {
  const file = path.join(fixture, 'consumer.ts');
  fs.writeFileSync(
    file,
    `import { Emitter } from '@opensumi/ide-core-common';
     import { IContextKeyService as BrowserContextService } from '@opensumi/ide-core-browser';
     import { IContextKeyService as SharedContextService } from '@opensumi/ide-core-common/contextkeys';
     declare const browserContext: BrowserContextService;
     const sharedContext: SharedContextService = browserContext;
     const sharedContextToken: typeof SharedContextService = BrowserContextService;
     type ExistingMonacoScope = Exclude<NonNullable<Parameters<BrowserContextService['createScoped']>[0]>, { parentElement: unknown }>;
     declare const existingMonacoScope: ExistingMonacoScope;
     existingMonacoScope.createKey('legacy.editor', true);
     browserContext.createScoped(existingMonacoScope);
     import { IReadableStream, SumiReadableStream } from '@opensumi/ide-utils/stream';
     import { IHashCalculateService } from '@opensumi/ide-core-common/hash';
     import { ButtonProps } from '@opensumi/ide-components/button';
     import { TSumiProtocol } from '@opensumi/ide-connection/rpc';
     import { CommonServerProtocol } from '@opensumi/ide-connection/protocols';
     import useThrottleFn from '@opensumi/ide-core-browser/hooks/throttle';
     import { AI_PANEL_LAYOUT_CONTEXT } from '@opensumi/ide-core-browser/ai/commands';
     import { Position, ITextModel } from '@opensumi/ide-monaco/types';
     import { IObservable } from '@opensumi/ide-monaco/observable';
     import { IEditorDocumentModelService } from '@opensumi/ide-editor/document-types';
     import { EditorGroup } from '@opensumi/ide-editor/workbench';
     import { IFileServiceClient } from '@opensumi/ide-file-service';
     import { Color } from '@opensumi/ide-theme/colors';
     import { IThemeService } from '@opensumi/ide-theme/types';
     import { IMainLayoutService, LayoutStateKeyOptions } from '@opensumi/ide-main-layout';
     import { IWorkspaceStorageService, IWorkspaceService } from '@opensumi/ide-workspace';
     import { IServerRuntimeApp } from '@opensumi/ide-core-node/types';
     import { SlotLocation } from '@opensumi/ide-core-common/workbench';
     import { IPreferenceViewDesc, ISettingSection } from '@opensumi/ide-core-common/preferences';
     import { Keybinding } from '@opensumi/ide-core-common/keybindings';
     import { IKeymapService } from '@opensumi/ide-keymaps';
     import { OutputChannel } from '@opensumi/ide-output/channel';
     import { IWorkspaceFileService } from '@opensumi/ide-workspace-edit/types';
     import { ContentSearchOptions, IContentSearchServer } from '@opensumi/ide-search';
     import { OpenMessageOptions } from '@opensumi/ide-overlay';
     import { IExtensionStorageService } from '@opensumi/ide-extension-storage';
     import { IProcessFactory } from '@opensumi/ide-process';
     import { IExternalUrlArgs } from '@opensumi/ide-remote-opener';
     import { IStatusBarService } from '@opensumi/ide-status-bar';
     import { IToolBarAction, ToolBarPosition } from '@opensumi/ide-toolbar/types';
     import { IVariableResolverService } from '@opensumi/ide-variable';
     import { MarkdownOptions } from '@opensumi/ide-markdown/types';
     import { IMarkerService, IRenderableMarkerModel } from '@opensumi/ide-markers/types';
     import { ViewBadge } from '@opensumi/ide-core-common/workbench';
     import { extProcessInit } from '@opensumi/ide-extension/host/initialize';
     import { ExtHostDocumentData } from '@opensumi/ide-extension/language/adapters';
     import { MemoryRange, MemoryRangeType } from '@opensumi/ide-debug';
     import { ILinkHoverTargetOptions } from '@opensumi/ide-terminal-next/hover';
     import { ObservableValue } from '@opensumi/ide-testing/observable';
     import { IChatMessageStructure } from '@opensumi/ide-ai-native';
     import { ChatInputRender } from '@opensumi/ide-ai-native/types';
     import { AcpChatMentionInput } from '@opensumi/ide-ai-native/acp/mention-input';
     const registeredInput: ChatInputRender = AcpChatMentionInput;
     import { ITaskExecuteResult, TaskExecuteKind, ITaskExecutor, IProblemCollector } from '@opensumi/ide-task';
     declare const taskExecutor: ITaskExecutor;
     const taskCollector: IProblemCollector = {
       problemMatchers: [], processLine: () => [], isTaskActiveOnStart: () => false,
       matchBeginMatcher: () => false, matchEndMatcher: () => false,
     };
     taskExecutor.updateProblemCollector(taskCollector);
     import { IComment } from '@opensumi/ide-comments';
     import { IVSXExtensionBackService } from '@opensumi/ide-extension-manager';
     import { IFileTreeAPI } from '@opensumi/ide-file-tree-next/types';
     import { IWebviewContentOptions } from '@opensumi/ide-webview/types';
     import { IElectronHeaderService } from '@opensumi/ide-electron-basic';
     import { ElectronAppConfig } from '@opensumi/ide-core-electron-main/types';
     import { UserInfo, ICollaborationServiceForClient } from '@opensumi/ide-collaboration';
     import { NotebookModule } from '@opensumi/ide-notebook/browser';
     import { ProductRuntimeMode, resolveProductRuntimeMode } from '@opensumi/ide-startup/runtime-mode';
     import { CommonNodeBindings } from '@opensumi/ide-startup/node/modules';
     import { ProcessTreeMemorySnapshot } from '@opensumi/ide-dev-tool/diagnostics/process-tree';
     import { summarizeRuntimeProfile } from '@opensumi/ide-dev-tool/diagnostics/runtime-profile-metrics';
     const productMode: ProductRuntimeMode = resolveProductRuntimeMode({});
     // @ts-expect-error the product policy has no automatic mode
     const invalidMode: ProductRuntimeMode = 'auto';
     // @ts-expect-error the catalog exposes readonly bindings
     CommonNodeBindings.push(CommonNodeBindings[0]);
     declare const memorySample: ProcessTreeMemorySnapshot;
     const profile = summarizeRuntimeProfile([memorySample]);
     // @ts-expect-error process metrics retain numeric memory units
     const invalidMemory: string = profile.p95TreeRssBytes;
     declare const header: IElectronHeaderService;
     header.onTitleChanged(title => title.toUpperCase());
     // @ts-expect-error header formatting returns text
     const invalidTitle: number = header.formatAppTitle();
     declare const electronConfig: ElectronAppConfig;
     // @ts-expect-error Electron preload paths remain strings
     electronConfig.browserPreload = false;
     const collaborator: UserInfo = { id: 'peer', nickname: 'Review' };
     declare const collaboration: ICollaborationServiceForClient;
     const initialized: Promise<void> = collaboration.requestInitContent('file:///public.ts');
     const notebook = new NotebookModule();
     // @ts-expect-error the published Notebook module retains its provider array
     notebook.providers = 'invalid';
     const chat: IChatMessageStructure = { message: 'hello', immediate: false };
     // @ts-expect-error AI message content remains text
     chat.message = 1;
     const comment: IComment = { body: 'comment', author: { name: 'reviewer' } };
     const webviewOptions: IWebviewContentOptions = { allowScripts: false };
     declare const taskResult: ITaskExecuteResult;
     const executeKind: TaskExecuteKind = taskResult.kind;
     declare const marketplace: IVSXExtensionBackService; marketplace.getOpenVSXRegistry();
     declare const tree: IFileTreeAPI; tree.onDidResolveChildren(value => value.toUpperCase());
     const range: MemoryRange = { type: MemoryRangeType.Unreadable, offset: 0, length: 1 };
     const testValue = new ObservableValue(1);
     // @ts-expect-error an observable retains its value type
     testValue.value = '1';
     declare const hoverTarget: ILinkHoverTargetOptions;
     // @ts-expect-error hover geometry keeps its numeric dimensions
     hoverTarget.cellDimensions.width = '1';
     // @ts-expect-error the viewport range is readonly
     hoverTarget.viewportRange = { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } };
     const hostOptions: NonNullable<Parameters<typeof extProcessInit>[0]> = { rpcMessageTimeout: 1000 };
     // @ts-expect-error the public bootstrap must preserve its numeric timeout contract
     hostOptions.rpcMessageTimeout = '1000';
     declare const extensionDocument: ExtHostDocumentData;
     const documentText: string = extensionDocument.getText();
     // @ts-expect-error published document data must not lose its text return type
     const invalidText: number = extensionDocument.getText();
     // @ts-expect-error document comparisons accept text lines
     extensionDocument.equalLines([1]);
     const external: IExternalUrlArgs = { type: 'url', clientId: 'test', url: 'https://example.com' };
     declare const statusBar: IStatusBarService; statusBar.setColor('red');
     const action: IToolBarAction = { type: 'action', position: ToolBarPosition.LEFT, title: 'Open', iconClass: 'open', click: event => event.preventDefault() };
     declare const variables: IVariableResolverService; variables.resolveArray(['value']);
     const markdown: MarkdownOptions = { gfm: true, breaks: true };
     declare const markerModel: IRenderableMarkerModel; markerModel.size();
     declare const markerService: IMarkerService;
     const markerBadge = markerService.getBadge();
     if (markerBadge && typeof markerBadge !== 'string') {
       const badge: ViewBadge = markerBadge;
       const value: number = badge.value;
       const tooltip: string = badge.tooltip;
       // @ts-expect-error published marker badges retain readonly fields
       markerBadge.value = 1;
       // @ts-expect-error the value must not become any through missing ambient declarations
       const invalid: string = markerBadge.value;
     }
     import { MockInjector } from '@opensumi/ide-dev-tool/injector';
     import { createNodeRspackConfig } from '@opensumi/ide-dev-tool/rspack';
     class Example { read(): string { return 'value'; } }
     const injector = new MockInjector();
     injector.mock(Example, 'read', () => 'mocked');
     // @ts-expect-error the mocked method must retain its return type
     injector.mock(Example, 'read', () => 123);
     const nodeConfig = createNodeRspackConfig('/app/server.ts', '/app/dist');
     nodeConfig.output?.filename;
     const preference: IPreferenceViewDesc = { id: 'editor.fontSize' };
     const section: ISettingSection = { preferences: [preference] };
     const binding: Keybinding = { command: 'save', keybinding: 'ctrl+s' };
     declare const keymaps: IKeymapService; keymaps.resetKeybinding(binding);
     declare const output: OutputChannel; output.appendLine('typed');
     declare const workspaceFiles: IWorkspaceFileService; workspaceFiles.onDidRunWorkspaceFileOperation(event => event.operation);
     declare const search: IContentSearchServer;
     declare const searchOptions: ContentSearchOptions;
     declare const message: OpenMessageOptions;
     declare const extensionStorage: IExtensionStorageService;
     declare const processFactory: IProcessFactory;
     declare const layout: IMainLayoutService;
     declare const workspace: IWorkspaceService;
     declare const storage: IWorkspaceStorageService;
     declare const server: IServerRuntimeApp;
     layout.toggleSlot(SlotLocation.view, true); workspace.tryGetRoots();
     storage.setData('layout', {}); server.drain();
     const stateOptions: LayoutStateKeyOptions = { saveCurrent: true };
     declare const files: IFileServiceClient;
     declare const theme: IThemeService;
     files.getFileStat('file:///workspace'); theme.getColor('editor.foreground');
     const color: Color = Color.fromHex('#123456');
     declare const model: ITextModel;
     declare const observed: IObservable<number>;
     declare const documents: IEditorDocumentModelService;
     declare const group: EditorGroup;
     const position = new Position(1, 1);
     model.getOffsetAt(position); observed.get(); documents.getAllModels(); group.currentResource?.uri.toString();
     const emitter = new Emitter<string>();
     const button: ButtonProps<string> = { type: 'primary', disabled: false };
     const protocol: TSumiProtocol = CommonServerProtocol;
     const key: string = AI_PANEL_LAYOUT_CONTEXT;
     const throttle: typeof useThrottleFn = useThrottleFn;
     const stream: IReadableStream<string> = new SumiReadableStream<string>();
     declare const hash: IHashCalculateService;
     emitter.fire(hash.calculate('typed')); stream.on('data', value => value.toUpperCase());`,
  );
  for (const [module, moduleResolution] of [
    [ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext],
    [ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler],
  ] as const) {
    const program = ts.createProgram([file], {
      module,
      moduleResolution,
      target: ts.ScriptTarget.ES2022,
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      types: [],
    });
    assert.deepEqual(
      ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
      [],
    );
  }
});

test('native menu declarations can be consumed without Electron declarations', () => {
  const file = path.join(fixture, 'menu-consumer.ts');
  fs.writeFileSync(
    file,
    `import type { IElectronMainMenuService } from '@opensumi/ide-core-common/menus';
     declare const menus: IElectronMainMenuService;
     const subscription: { dispose(): void } = menus.on('menuClick', (targetId, menuId) => {
       targetId.toUpperCase(); menuId.toUpperCase();
     });
     menus.showContextMenu({ label: 'File', submenu: [{ id: 'save', label: 'Save' }] }, 1);
     // @ts-expect-error unsupported menu event
     menus.on('windowClosed', () => {});
     subscription.dispose();`,
  );
  for (const [module, moduleResolution] of [
    [ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext],
    [ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler],
  ] as const) {
    const program = ts.createProgram([file], {
      module,
      moduleResolution,
      target: ts.ScriptTarget.ES2022,
      noEmit: true,
      strict: true,
      skipLibCheck: true,
      types: [],
    });
    assert.deepEqual(
      ts
        .getPreEmitDiagnostics(program)
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')),
      [],
    );
    assert.deepEqual(
      program
        .getSourceFiles()
        .filter((source) => /(?:ide-core-common\/lib\/electron|node_modules\/electron\/)/.test(source.fileName)),
      [],
      'The menu contract must not expose Electron through its declaration dependency graph',
    );
  }
});

test('RPC declarations expose typed ports without transport or browser implementations', () => {
  const file = path.join(fixture, 'rpc-contract-consumer.ts');
  fs.writeFileSync(
    file,
    `import { BaseConnection, IRPCProtocol, ProxyIdentifier, createMainContextProxyIdentifier } from '@opensumi/ide-connection/rpc-contracts';
    import type { IConnectionShape, IRuntimeSocketConnection } from '@opensumi/ide-connection/rpc-contracts';
    type Service = { read(path: string): Promise<string> };
    const id: ProxyIdentifier<Service> = createMainContextProxyIdentifier<Service>('files');
    declare const rpc: IRPCProtocol;
    const proxy: Service = rpc.getProxy<Service>(id);
    const content: Promise<string> = proxy.read('file:///readme');
    // @ts-expect-error service calls retain their argument types
    proxy.read(42);
    // @ts-expect-error identifiers remain readonly
    id.serviceId = 'changed';
    declare const connection: BaseConnection<Uint8Array>;
    const shape: IConnectionShape<Uint8Array> = connection;
    shape.send(new Uint8Array([1]));
    // @ts-expect-error the byte transport cannot accept text
    shape.send('bytes');
    const subscription = connection.onMessage(bytes => { const length: number = bytes.byteLength; });
    subscription.dispose();
    declare const socket: IRuntimeSocketConnection;
    const open: boolean = socket.isOpen();
    socket.onClose((code, reason) => { const status: number | undefined = code; });`,
  );
  for (const [module, moduleResolution] of [
    [ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext],
    [ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler],
  ] as const) {
    const program = ts.createProgram([file], {
      module,
      moduleResolution,
      target: ts.ScriptTarget.ES2022,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    });
    assert.deepEqual(
      ts.getPreEmitDiagnostics(program).map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')),
      [],
    );
    const connectionSources = program.getSourceFiles().filter((source) => source.fileName.includes('/ide-connection/'));
    assert.deepEqual(
      connectionSources.map((source) => source.fileName.split('/ide-connection/')[1]).sort(),
      ['lib/common/connection/drivers/base.d.ts', 'lib/common/connection/types.d.ts', 'lib/common/rpc-contracts.d.ts'],
      'The RPC port must not expose the multiplexer, transport drivers or browser channel handler',
    );
  }
});

test('context scopes and context menus expose declarations without browser implementations', () => {
  const file = path.join(fixture, 'context-menu-consumer.ts');
  fs.writeFileSync(
    file,
    `import { IContextKeyService, IScopedContextKeyService, RawContextKey } from '@opensumi/ide-core-common/contextkeys';
    import { IContextMenu, IMenu, MenuNode, TupleMenuNodeResult } from '@opensumi/ide-core-common/menus';
    import { IStatusBarService, StatusBarAlignment } from '@opensumi/ide-core-common/status-bar';
    import type { ButtonType } from '@opensumi/ide-core-common/actions';
    declare const context: IContextKeyService;
    const key = context.createKey<boolean>('enabled', false);
    key.set(true);
    // @ts-expect-error the typed context key rejects a text value
    key.set('yes');
    const scoped: IScopedContextKeyService = context.createScoped(document.createElement('div'));
    scoped.attachToDomNode(document.createElement('div'));
    new RawContextKey('ready', true).bind(scoped);
    context.onDidChangeContext(event => event.payload.affectsSome(new Set(['enabled'])));
    declare const menu: IContextMenu;
    const groups: TupleMenuNodeResult = menu.getGroupedMenuNodes();
    const nodes: MenuNode[] = menu.getMergedMenuNodes();
    nodes[0]?.execute('save');
    const style: ButtonType = 'ghost';
    // @ts-expect-error action styles retain the supported string union
    const invalidStyle: ButtonType = 'custom';
    // @ts-expect-error menu nodes retain a readonly identifier
    nodes[0].id = 'other';
    declare const status: IStatusBarService;
    const statusMenu: IMenu = status.contextMenu;
    statusMenu.getMenuNodes()[0]?.[1][0]?.execute();
    status.addElement('encoding', { text: 'UTF-8', alignment: StatusBarAlignment.LEFT });
    const text = status.leftEntries.get()[0].text;
    // @ts-expect-error status entries retain numeric alignment values
    status.addElement('invalid', { alignment: 'left' });`,
  );
  for (const [module, moduleResolution] of [
    [ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext],
    [ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler],
  ] as const) {
    const program = ts.createProgram([file], {
      module,
      moduleResolution,
      target: ts.ScriptTarget.ES2022,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    });
    assert.deepEqual(
      ts.getPreEmitDiagnostics(program).map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')),
      [],
    );
    assert.deepEqual(
      program
        .getSourceFiles()
        .filter((source) =>
          /ide-core-browser\/|ide-components\/|monaco-editor-core[^\n]*\/vs\/[^\n]*\/browser\//.test(source.fileName),
        )
        .map((source) => source.fileName),
      [],
      'Shared contracts must not depend on Monaco browser scopes, menu services or button components',
    );
  }
});

test('terminal hover geometry does not import browser implementation declarations', () => {
  const file = path.join(fixture, 'terminal-hover-consumer.ts');
  fs.writeFileSync(
    file,
    `import type { ILinkHoverTargetOptions } from '@opensumi/ide-terminal-next/hover';
     declare const target: ILinkHoverTargetOptions;
     const width: number = target.cellDimensions.width;
     const row: number = target.viewportRange.start.y;
     target.modifierDownCallback?.();
     // @ts-expect-error the cell width must remain numeric
     const badWidth: string = target.cellDimensions.width;
     // @ts-expect-error the viewport range remains readonly
     target.viewportRange = { start: { x: 1, y: 1 }, end: { x: 1, y: 1 } };`,
  );
  for (const [module, moduleResolution] of [
    [ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext],
    [ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler],
  ] as const) {
    const program = ts.createProgram([file], {
      module,
      moduleResolution,
      target: ts.ScriptTarget.ES2022,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    });
    assert.deepEqual(
      ts.getPreEmitDiagnostics(program).map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')),
      [],
    );
    assert.deepEqual(
      program
        .getSourceFiles()
        .filter((source) => /(?:ide-terminal-next\/lib\/browser\/|ide-core-browser\/)/.test(source.fileName)),
      [],
      'Hover geometry must not load the link manager or other browser implementations',
    );
  }
});

test('quick input and task collector declarations do not depend on browser implementations', () => {
  const file = path.join(fixture, 'shared-input-consumer.ts');
  fs.writeFileSync(
    file,
    `import { QuickOpenItem, QuickOpenMode, QuickOpenBaseAction, QuickInputOptions } from '@opensumi/ide-quick-open';
     import { VALIDATE_TYPE } from '@opensumi/ide-core-common/validation';
     import type { IProblemCollector } from '@opensumi/ide-task/problem-collector';
     const item = new QuickOpenItem({ label: 'Build', run: mode => mode === QuickOpenMode.OPEN });
     const options: QuickInputOptions = { validateInput: () => ({ message: 'Required', type: VALIDATE_TYPE.ERROR }) };
     class Action extends QuickOpenBaseAction { async run(item?: QuickOpenItem) { item?.run(QuickOpenMode.OPEN); } }
     const action = new Action({ id: 'build', enabled: false });
     // @ts-expect-error quick input validation levels are numeric enum values
     const badOptions: QuickInputOptions = { validationType: 'error' };
     const collector: IProblemCollector = {
       problemMatchers: [], processLine: () => [], isTaskActiveOnStart: () => false,
       matchBeginMatcher: () => false, matchEndMatcher: () => false,
     };
     // @ts-expect-error a problem collector must return matches rather than arbitrary messages
     const invalidCollector: IProblemCollector = { ...collector, processLine: () => ['error'] };
     collector.processLine(item.getLabel() ?? '');`,
  );
  for (const [module, moduleResolution] of [
    [ts.ModuleKind.NodeNext, ts.ModuleResolutionKind.NodeNext],
    [ts.ModuleKind.ESNext, ts.ModuleResolutionKind.Bundler],
  ] as const) {
    const program = ts.createProgram([file], {
      module,
      moduleResolution,
      target: ts.ScriptTarget.ES2022,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
    });
    assert.deepEqual(
      ts.getPreEmitDiagnostics(program).map((item) => ts.flattenDiagnosticMessageText(item.messageText, '\n')),
      [],
    );
    assert.deepEqual(
      program
        .getSourceFiles()
        .filter((source) =>
          /(?:ide-core-browser\/|ide-components\/|ide-task\/lib\/browser\/|monaco-editor-core[^\n]*\/vs\/base\/browser\/)/.test(
            source.fileName,
          ),
        )
        .map((source) => source.fileName),
      [],
      'Shared provider contracts must not expose widgets, React components or task executor implementations',
    );
  }
});

test('shared extension API entries stay loadable in a host without a browser runtime', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `
      const assert = require('node:assert/strict');
      assert.equal(typeof window, 'undefined');
        const extensionRequire = require('node:module').createRequire(require('node:path').resolve('packages/extension/package.json'));
        const debug = extensionRequire('@opensumi/ide-debug');
        extensionRequire('@opensumi/ide-task');
        extensionRequire('@opensumi/ide-scm');
        const { NotebookCellsChangeType, CellKind } = extensionRequire('@opensumi/ide-editor/notebook');
        assert.equal(CellKind.Code, 2);
        assert.equal(typeof NotebookCellsChangeType.ModelChange, 'number');
        const actualHost = extensionRequire('@opensumi/ide-extension/host/node');
        assert.equal(typeof actualHost.default, 'function');
        const editorContract = extensionRequire('@opensumi/ide-core-browser/editor');
        assert.equal(typeof editorContract.MonacoService, 'function');
        assert.equal(editorContract.createLayoutEventType('shared'), 'layoutInlineWidget-shared');
        require('./packages/markers');
      assert.equal(debug.CONTEXT_DEBUG_TYPE.raw, 'debugType');
      assert.equal(debug.DEBUG_CONTAINER_ID, 'debug');
        assert.deepEqual(Object.keys(require.cache).filter(file =>
          file.endsWith('/core-browser/lib/index.js') || file.includes('/core-browser/lib/services/') ||
          file.includes('/monaco-editor-core/esm/vs/base/browser/') ||
          file.endsWith('/monaco/lib/index.js')), []);
        const { RawContextKey } = extensionRequire('@opensumi/ide-core-common/contextkeys');
      assert.equal(require('./packages/core-browser/lib/raw-context-key.js').RawContextKey, RawContextKey);
        const stacking = extensionRequire('@opensumi/ide-core-common/workbench');
        const oldStacking = require('./packages/core-browser/lib/design/rule.js');
        assert.equal(oldStacking.StackingLevel, stacking.StackingLevel);
        assert.equal(oldStacking.StackingLevelStr, stacking.StackingLevelStr);
        assert.equal(require('./packages/core-browser/lib/preferences/settings.js').IPreferenceSettingsService,
          extensionRequire('@opensumi/ide-core-common/preferences').IPreferenceSettingsService);
    `,
    ],
    { cwd: repoRoot, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('a published extension host exposes its bootstrap, services and RPC helpers without repository paths', () => {
  const result = spawnSync(
    process.execPath,
    [
      '-e',
      `const assert = require('node:assert/strict');
       const path = require('node:path');
       const extension = require('@opensumi/ide-extension');
       assert.equal(extension.ExtensionContributePoint.Terminal, 'terminal');
       const { ExtensionModule } = require('@opensumi/ide-extension/node');
       const { ExtensionNodeServiceImpl } = require('@opensumi/ide-extension/node/service');
       const { extProcessInit } = require('@opensumi/ide-extension/host/initialize');
       assert.equal(typeof extProcessInit, 'function');
       assert.equal(typeof require('@opensumi/ide-extension/host/node').default, 'function');
       assert.ok(new ExtensionModule().providers.some(provider =>
         provider.token === extension.IExtensionNodeService && provider.useClass === ExtensionNodeServiceImpl));
       const { createMockPairRPCProtocol } = require('@opensumi/ide-dev-tool/mocks/extension-rpc');
       const pair = createMockPairRPCProtocol();
       pair.rpcProtocolExt.dispose(); pair.rpcProtocolMain.dispose();
       const manifest = require('@opensumi/ide-extension/package.json');
       assert.equal(manifest.exports['./host/process']['opensumi-source'], undefined);
       assert.equal(path.extname(require.resolve('@opensumi/ide-extension/host/process')), '.js');
       assert.equal(path.extname(require.resolve('@opensumi/ide-extension/worker-host.js')), '.js');
       assert.deepEqual(Object.keys(require.cache).filter(file =>
         /core-browser\\/lib\\/(?:index.js|services\\/)/.test(file) ||
         /monaco-editor-core[^\\n]*\\/vs\\/base\\/browser\\//.test(file)), []);`,
    ],
    { cwd: fixture, encoding: 'utf8' },
  );
  assert.equal(result.status, 0, result.stderr);
});

test('a standalone browser consumer renders a component and bundles its public styles in both modes', async () => {
  const requireFromRepo = createRequire(path.join(repoRoot, 'package.json'));
  const entry = path.join(fixture, 'ui.js');
  fs.writeFileSync(
    entry,
    `import React from 'react';
     import { renderToStaticMarkup } from 'react-dom/server.browser';
     import { Button } from '@opensumi/ide-components/button';
     import { AI_PANEL_LAYOUT_CONTEXT } from '@opensumi/ide-core-browser/ai/commands';
     import '@opensumi/ide-components/styles/base.less';
     import '@opensumi/ide-core-browser/styles/variable.less';
     import '@opensumi/ide-monaco/styles/merge-editor.module.less';
     import '@opensumi/ide-theme/styles/icon.less';
     globalThis.publicButtonMarkup = renderToStaticMarkup(React.createElement(Button, { type: 'primary' }, AI_PANEL_LAYOUT_CONTEXT));`,
  );
  // React is supplied by this consumer, as required by the component peer contract.
  for (const name of ['react', 'react-dom']) {
    const original = path.dirname(requireFromRepo.resolve(`${name}/package.json`));
    fs.symlinkSync(original, path.join(fixture, 'node_modules', name), 'dir');
  }
  for (const source of [false, true]) {
    const output = path.join(fixture, source ? 'ui-source' : 'ui-compiled');
    const compiler = rspack({
      mode: 'development',
      devtool: false,
      cache: false,
      context: fixture,
      entry,
      target: 'web',
      output: { path: output, filename: 'consumer.js', publicPath: '' },
      resolve: {
        extensions: ['.tsx', '.ts', '.js'],
        conditionNames: [...(source ? ['opensumi-source'] : []), 'browser', 'import', 'default'],
        fallback: {
          assert: requireFromRepo.resolve('assert/'),
          buffer: requireFromRepo.resolve('buffer/'),
          process: requireFromRepo.resolve('process/browser.js'),
          fs: false,
          path: false,
          os: false,
          crypto: false,
          child_process: false,
          stream: false,
          url: false,
        },
      },
      module: {
        rules: [
          {
            test: /\.tsx?$/,
            use: {
              loader: 'builtin:swc-loader',
              options: {
                collectTypeScriptInfo: { typeExports: true },
                jsc: { parser: { syntax: 'typescript', tsx: true } },
              },
            },
          },
          {
            test: /\.(css|less)$/,
            use: [
              rspack.CssExtractRspackPlugin.loader,
              requireFromRepo.resolve('css-loader'),
              { loader: requireFromRepo.resolve('less-loader'), options: { lessOptions: { javascriptEnabled: true } } },
            ],
          },
          { test: /\.(svg|png|woff2?|eot|ttf)$/, type: 'asset/resource' },
        ],
      },
      plugins: [new rspack.CssExtractRspackPlugin({ filename: 'consumer.css' })],
    });
    try {
      await new Promise<void>((resolve, reject) =>
        compiler.run((error, stats) => {
          if (error || stats?.hasErrors()) {
            reject(error || new Error(stats?.toString({ all: false, errors: true })));
          } else {
            resolve();
          }
        }),
      );
      const result = spawnSync(
        process.execPath,
        [
          '-e',
          `require(${JSON.stringify(path.join(output, 'consumer.js'))});
           require('node:assert/strict').match(globalThis.publicButtonMarkup, /<button /);
           require('node:assert/strict').match(globalThis.publicButtonMarkup, /aiNative.panelLayout/);`,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
      assert.match(fs.readFileSync(path.join(output, 'consumer.css'), 'utf8'), /\.kt-button/);
      assert.match(fs.readFileSync(path.join(output, 'consumer.css'), 'utf8'), /\.kaitian-icon/);
    } finally {
      await new Promise<void>((resolve, reject) => compiler.close((error) => (error ? reject(error) : resolve())));
    }
  }
});

async function compilePublicConsumer(config: Configuration): Promise<Stats> {
  const compiler = rspack(config)!;
  try {
    return await new Promise<Stats>((resolve, reject) =>
      compiler.run((error, stats) => {
        if (error || !stats || stats.hasErrors()) {
          reject(error || new Error(stats?.toString({ all: false, errors: true })));
        } else {
          resolve(stats);
        }
      }),
    );
  } finally {
    await new Promise<void>((resolve, reject) => compiler.close((error) => (error ? reject(error) : resolve())));
  }
}

test('published browser feature catalogs and Electron renderer modules bundle in both modes', async () => {
  const app = path.join(fixture, 'host-browser-app');
  fs.mkdirSync(app);
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'host-browser-consumer', private: true }));
  fs.writeFileSync(
    path.join(app, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'commonjs',
        target: 'ES2020',
        esModuleInterop: true,
        experimentalDecorators: true,
        emitDecoratorMetadata: true,
        jsx: 'react',
      },
    }),
  );
  const entry = path.join(app, 'entry.ts');
  fs.writeFileSync(
    entry,
    `import { NotebookModule } from '@opensumi/ide-notebook/browser';
     import { CollaborationModule } from '@opensumi/ide-collaboration/browser';
     import { ElectronBasicModule } from '@opensumi/ide-electron-basic/browser';
     import { compileOpenSumiProductRuntimePlan } from '@opensumi/ide-startup';
     import { CommonBrowserBindings } from '@opensumi/ide-startup/browser/modules';
     import { AIBrowserBindings } from '@opensumi/ide-startup/browser/ai';
     import { NotebookBrowserBindings } from '@opensumi/ide-startup/browser/notebook';
     import { CollaborationBrowserBindings } from '@opensumi/ide-startup/browser/collaboration';
     globalThis.hostBrowserModules = [NotebookModule, CollaborationModule, ElectronBasicModule];
     globalThis.publicBrowserPlan = compileOpenSumiProductRuntimePlan({ runtime: 'browser', commonBindings: CommonBrowserBindings, options: [
       { id: 'ai', bindings: AIBrowserBindings }, { id: 'notebook', bindings: NotebookBrowserBindings }, { id: 'collaboration', bindings: CollaborationBrowserBindings }
     ] });`,
  );
  const productEntry = path.join(app, 'product-client.tsx');
  fs.copyFileSync(path.join(repoRoot, 'client/src/main.tsx'), productEntry);
  const consumerRequire = createRequire(path.join(app, 'consumer.cjs'));
  const { createRspackConfig } = consumerRequire('@opensumi/ide-dev-tool/rspack');
  for (const source of [false, true]) {
    const output = path.join(app, source ? 'source' : 'compiled');
    const config: Configuration = createRspackConfig(app, entry, {
      mode: 'development',
      devtool: false,
      cache: false,
      entry: { consumer: entry, product: productEntry },
      output: { path: output, filename: '[name].js', publicPath: '' },
      resolve: {
        conditionNames: [...(source ? ['opensumi-source'] : []), 'browser', 'import', 'default'],
      },
    });
    const stats = await compilePublicConsumer(config);
    const modules = JSON.stringify(stats.toJson({ all: false, modules: true, nestedModules: true }));
    for (const name of ['notebook', 'collaboration', 'electron-basic']) {
      assert.ok(modules.includes(`ide-${name}/${source ? 'src' : 'lib'}/browser/index.`), name);
    }
    assert.ok(modules.includes(`ide-startup/${source ? 'src' : 'lib'}/browser/common-modules.`));
    assert.ok(modules.includes(`ide-startup/${source ? 'src' : 'lib'}/browser/renderer/index.`));
    assert.ok(modules.includes(`ide-startup/${source ? 'src' : 'lib'}/browser/examples/base.`));
    assert.ok(fs.statSync(path.join(output, 'consumer.js')).size > 0);
    assert.ok(fs.statSync(path.join(output, 'product.js')).size > 0);
  }
});

test('published Electron main and Webview modules bundle with the Electron runtime external', async () => {
  const entry = path.join(fixture, 'electron-main.js');
  fs.writeFileSync(
    entry,
    `import { ElectronMainApp } from '@opensumi/ide-core-electron-main';
     import { ProtocolElectronMainContribution } from '@opensumi/ide-core-electron-main/protocol';
     import { WebviewElectronMainModule } from '@opensumi/ide-webview/electron-main';
     globalThis.hostMainModules = [ElectronMainApp, ProtocolElectronMainContribution, WebviewElectronMainModule];`,
  );
  for (const source of [false, true]) {
    const output = path.join(fixture, source ? 'electron-source' : 'electron-compiled');
    const stats = await compilePublicConsumer({
      mode: 'development',
      devtool: false,
      cache: false,
      context: fixture,
      entry,
      target: 'electron-main',
      output: { path: output, filename: 'consumer.js' },
      resolve: {
        extensions: ['.tsx', '.ts', '.js'],
        conditionNames: [...(source ? ['opensumi-source'] : []), 'require', 'default'],
      },
      module: {
        rules: [
          {
            test: /\.tsx?$/,
            use: {
              loader: 'builtin:swc-loader',
              options: {
                collectTypeScriptInfo: { typeExports: true },
                jsc: {
                  parser: { syntax: 'typescript', tsx: true, decorators: true },
                  transform: { legacyDecorator: true, decoratorMetadata: true },
                },
              },
            },
          },
        ],
      },
      externals: { electron: 'commonjs electron' },
    });
    const modules = JSON.stringify(stats.toJson({ all: false, modules: true, nestedModules: true }));
    const directory = source ? 'src' : 'lib';
    assert.ok(modules.includes(`ide-core-electron-main/${directory}/bootstrap/services/protocol.`));
    assert.ok(modules.includes(`ide-webview/${directory}/electron-main/index.`));
    assert.match(fs.readFileSync(path.join(output, 'consumer.js'), 'utf8'), /require\("electron"\)/);
  }
});

test('shared product contracts execute in a worker without loading browser services', async () => {
  const entry = path.join(fixture, 'worker-contracts.js');
  fs.writeFileSync(
    entry,
    `import { Position } from '@opensumi/ide-monaco/types';
     import { autorun, observableValue, transaction } from '@opensumi/ide-monaco/observable';
     import { ITextmateTokenizer } from '@opensumi/ide-monaco/tokenizer';
     import { ICallHierarchyService } from '@opensumi/ide-monaco/hierarchy';
     import { CellKind, WorkbenchEditorService } from '@opensumi/ide-editor';
     import { FileType, WatcherServiceProxy } from '@opensumi/ide-file-service';
     import { ProxyIdentifier, IRPCProtocol } from '@opensumi/ide-connection/rpc-contracts';
     import { Color, CSSVarRegistry } from '@opensumi/ide-theme';
     import { TabBarRegistrationEvent, SUPPORT_ACCORDION_LOCATION } from '@opensumi/ide-main-layout';
     import { IWorkspaceService } from '@opensumi/ide-workspace';
     import { BasicEvent, Uri } from '@opensumi/ide-core-common';
     import { ContextKeyChangeEvent, IContextKeyService } from '@opensumi/ide-core-common/contextkeys';
     import { MenuNode } from '@opensumi/ide-core-common/menus';
     import { IStatusBarService, StatusBarAlignment } from '@opensumi/ide-core-common/status-bar';
     import { SlotLocation } from '@opensumi/ide-core-common/workbench';
     import { toPreferenceReadableName } from '@opensumi/ide-preferences';
     import { Keybinding } from '@opensumi/ide-core-common/keybindings';
     import { IKeymapService } from '@opensumi/ide-keymaps';
     import { IFileSearchService } from '@opensumi/ide-file-search';
     import { IWorkspaceFileService } from '@opensumi/ide-workspace-edit/types';
     import { IOpenDialogOptions } from '@opensumi/ide-overlay';
     import { ContentChangeEvent } from '@opensumi/ide-output';
     import { RemoteOpenerServicePath } from '@opensumi/ide-remote-opener';
     import { IVariableResolverService } from '@opensumi/ide-variable';
     import { IMarkdownService } from '@opensumi/ide-markdown/types';
     import { MarkerModelBuilder } from '@opensumi/ide-markers';
     import { DESIGN_MENU_BAR_LEFT } from '@opensumi/ide-design';
     import { ExplorerOpenedEditorViewId } from '@opensumi/ide-opened-editor';
     import { ExtHostDocumentData, DefinitionAdapter } from '@opensumi/ide-extension/language/adapters';
     import { MainThreadAPIIdentifier } from '@opensumi/ide-extension/vscode';
     import { TestMessage } from '@opensumi/ide-extension/vscode/converter';
     import { MemoryRangeType } from '@opensumi/ide-debug';
     import { TestId, TestPosition } from '@opensumi/ide-testing';
     import { mutatorTypeLabel, EnvironmentVariableMutatorType } from '@opensumi/ide-terminal-next/environment-variables';
     import { QuickOpenBaseAction, QuickOpenItem, QuickOpenMode } from '@opensumi/ide-quick-open';
     import { QuickOpenItem as CommonQuickOpenItem } from '@opensumi/ide-core-common/quick-open';
     import { VALIDATE_TYPE } from '@opensumi/ide-core-common/validation';
     import { AI_CHAT_VIEW_ID } from '@opensumi/ide-ai-native';
     import { RefreshTestsCommand, ClearTestResults } from '@opensumi/ide-testing/commands';
     import { getIcon, updateIconMap } from '@opensumi/ide-components/icon-utils';
     import { TaskExecuteKind } from '@opensumi/ide-task';
     import { CommentMode } from '@opensumi/ide-comments';
     import { FILE_EXPLORER_WELCOME_ID } from '@opensumi/ide-file-tree-next/types';
     import { SCMViewModelMode } from '@opensumi/ide-scm';
     import { EnableScope } from '@opensumi/ide-extension-manager';
     import { WebviewScheme } from '@opensumi/ide-webview/common';
     import { resolveProductRuntimeMode } from '@opensumi/ide-startup/runtime-mode';
     class Action extends QuickOpenBaseAction { async run() {} }
     const document = new ExtHostDocumentData({}, Uri.parse('file:///public.ts'), ['hello'], '\\n', 'typescript', 1, false);
     const values = [];
     const value = observableValue('public consumer', 1);
     const listener = autorun(reader => values.push(value.read(reader)));
     transaction(tx => { value.set(2, tx); value.set(3, tx); });
     listener.dispose();
     updateIconMap('worker-icon ', { 'public-test': 'custom-test' });
     globalThis.publicWorkerResult = {
       values, line: new Position(2, 3).lineNumber, code: CellKind.Code,
       watcherProxyIdentity: WatcherServiceProxy instanceof ProxyIdentifier, rpcToken: typeof IRPCProtocol,
       contextServiceToken: typeof IContextKeyService,
       statusServiceToken: typeof IStatusBarService, statusLeft: StatusBarAlignment.LEFT,
       contextEvent: new ContextKeyChangeEvent({ affectsSome: keys => keys.has('ready') }).payload.affectsSome(new Set(['ready'])),
       menuExecution: new MenuNode({ id: 'save', label: 'Save', execute: args => args.join(':') }).execute('a', 'b'),
       tokenizer: typeof ITextmateTokenizer, hierarchy: typeof ICallHierarchyService,
       workbench: typeof WorkbenchEditorService, window: typeof window,
       file: FileType.File, color: Color.fromHex('#123456').toString(),
       overlay: CSSVarRegistry.instance().get('stacking-level-overlay'),
       layoutEvent: new TabBarRegistrationEvent({ tabBarId: 'test' }) instanceof BasicEvent,
       viewSlot: SUPPORT_ACCORDION_LOCATION.has(SlotLocation.view), workspace: typeof IWorkspaceService,
       preference: toPreferenceReadableName('javascript.format.enable'),
       binding: Keybinding.is({ command: 'save', keybinding: 'ctrl+s' }), keymap: typeof IKeymapService,
       fileSearch: typeof IFileSearchService, workspaceFiles: typeof IWorkspaceFileService,
       openFiles: IOpenDialogOptions.is({ canSelectFiles: true }), output: typeof ContentChangeEvent,
       remoteOpener: RemoteOpenerServicePath, variables: typeof IVariableResolverService,
       markdown: typeof IMarkdownService, markers: MarkerModelBuilder.buildModel('file:///test', '', '', '', []).size(),
       designMenu: DESIGN_MENU_BAR_LEFT, openedEditors: ExplorerOpenedEditorViewId,
       documentText: document.document.getText(), documentCharacter: document.document.positionAt(3).character,
       definitionAdapter: typeof DefinitionAdapter, mainThreadOutput: MainThreadAPIIdentifier.MainThreadOutput.serviceId,
       testMessageType: TestMessage.from({ message: 'failed' }).type,
       unreadable: MemoryRangeType.Unreadable,
       childTest: TestId.compare('root', TestId.joinToString('root', 'case')) === TestPosition.IsChild,
       environmentReplace: mutatorTypeLabel(EnvironmentVariableMutatorType.Replace, 'public', 'TERM'),
       actionEnabled: new Action({ id: 'disabled', enabled: false }).enabled,
       quickItemIdentity: QuickOpenItem === CommonQuickOpenItem,
       quickItemChecked: new QuickOpenItem({ checked: true }).checked.get(),
       quickItemRun: new QuickOpenItem({ run: mode => mode === QuickOpenMode.OPEN }).run(QuickOpenMode.OPEN),
       validationError: VALIDATE_TYPE.ERROR,
       testingRefreshIcon: RefreshTestsCommand.iconClass, testingClearIcon: ClearTestResults.iconClass,
       customWorkerIcon: getIcon('public-test'),
       aiChat: AI_CHAT_VIEW_ID, taskStarted: TaskExecuteKind.Started, commentPreview: CommentMode.Preview,
       fileExplorer: FILE_EXPLORER_WELCOME_ID, scmList: SCMViewModelMode.List, extensionScope: EnableScope.GLOBAL,
       webviewScheme: WebviewScheme,
       defaultRuntime: resolveProductRuntimeMode({}),
     };`,
  );
  for (const source of [false, true]) {
    const output = path.join(fixture, source ? 'worker-source' : 'worker-compiled');
    const compiler = rspack({
      mode: 'development',
      devtool: false,
      cache: false,
      context: fixture,
      entry,
      target: 'webworker',
      output: { path: output, filename: 'consumer.js', publicPath: '' },
      resolve: {
        extensions: ['.tsx', '.ts', '.js'],
        conditionNames: [...(source ? ['opensumi-source'] : []), 'worker', 'import', 'default'],
      },
      module: {
        rules: [
          {
            test: /\.tsx?$/,
            use: {
              loader: 'builtin:swc-loader',
              options: {
                collectTypeScriptInfo: { typeExports: true },
                jsc: { parser: { syntax: 'typescript', tsx: true, decorators: true } },
              },
            },
          },
        ],
      },
    });
    try {
      const moduleGraph = await new Promise<string>((resolve, reject) =>
        compiler.run((error, stats) => {
          if (error || stats?.hasErrors()) {
            reject(error || new Error(stats?.toString({ all: false, errors: true })));
          } else {
            resolve(JSON.stringify(stats?.toJson({ all: false, modules: true, nestedModules: true })));
          }
        }),
      );
      assert.doesNotMatch(moduleGraph, /monaco-editor-core[^"\n]*\/vs\/base\/browser\//);
      assert.doesNotMatch(moduleGraph, /core-browser\/(?:lib|src)\/(?:index\.[jt]s|services\/)/);
      const result = spawnSync(
        process.execPath,
        [
          '-e',
          `globalThis.self = globalThis;
           require(${JSON.stringify(path.join(output, 'consumer.js'))});
           require('node:assert/strict').deepEqual(globalThis.publicWorkerResult, {
             values: [1, 3], line: 2, code: 2, tokenizer: 'symbol', hierarchy: 'symbol',
             watcherProxyIdentity: true, rpcToken: 'symbol',
             contextServiceToken: 'symbol', contextEvent: true, menuExecution: 'a:b',
             statusServiceToken: 'symbol', statusLeft: 0,
             workbench: 'function', window: 'undefined',
             file: 1, color: '#123456', overlay: '800',
             layoutEvent: true, viewSlot: true, workspace: 'symbol',
             preference: 'JavaScript > Format : Enable', binding: true, keymap: 'symbol',
             fileSearch: 'symbol', workspaceFiles: 'symbol', openFiles: true, output: 'function',
             remoteOpener: 'RemoteOpenerService', variables: 'symbol', markdown: 'symbol', markers: 0,
             designMenu: 'design_menu_bar_left', openedEditors: 'file-opened-editor',
             documentText: 'hello', documentCharacter: 3, definitionAdapter: 'function', mainThreadOutput: 'MainThreadOutput',
             testMessageType: 0,
             unreadable: 1, childTest: true, environmentReplace: 'TERM=public',
             actionEnabled: false, quickItemIdentity: true, quickItemChecked: true, quickItemRun: true, validationError: 2,
             testingRefreshIcon: 'kaitian-icon kticon-refresh', testingClearIcon: 'codicon codicon-clear-all',
             customWorkerIcon: 'worker-icon custom-test',
             aiChat: 'AI-Chat', taskStarted: 1, commentPreview: 1,
             fileExplorer: 'file-explorer', scmList: 'list', extensionScope: 'GLOBAL', webviewScheme: 'kaitian-webview',
             defaultRuntime: 'node',
           });`,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
    } finally {
      await new Promise<void>((resolve, reject) => compiler.close((error) => (error ? reject(error) : resolve())));
    }
  }
});

test('Rspack bundles public subpaths for both source and compiled package resolution', async () => {
  const entry = path.join(fixture, 'browser.js');
  fs.writeFileSync(
    entry,
    `import { format } from '@opensumi/ide-utils/strings';
     import { parseLabelWithIcons } from '@opensumi/ide-utils/icon-labels';
     globalThis.publicApiResult = format('{0}', parseLabelWithIcons('$(check) Ready').text);`,
  );
  for (const source of [false, true]) {
    const output = path.join(fixture, source ? 'source' : 'compiled');
    const compiler = rspack({
      mode: 'development',
      devtool: false,
      cache: false,
      context: fixture,
      entry,
      target: 'web',
      output: { path: output, filename: 'consumer.js' },
      resolve: {
        extensions: ['.ts', '.js'],
        conditionNames: [...(source ? ['opensumi-source'] : []), 'import', 'default'],
      },
      module: { rules: [{ test: /\.ts$/, use: 'builtin:swc-loader' }] },
    });
    try {
      await new Promise<void>((resolve, reject) =>
        compiler.run((error, stats) => {
          if (error || stats?.hasErrors()) {
            reject(error || new Error(stats?.toString({ all: false, errors: true })));
          } else {
            resolve();
          }
        }),
      );
      const result = spawnSync(
        process.execPath,
        [
          '-e',
          `require(${JSON.stringify(path.join(output, 'consumer.js'))}); require('node:assert/strict').equal(globalThis.publicApiResult, ' Ready');`,
        ],
        { encoding: 'utf8' },
      );
      assert.equal(result.status, 0, result.stderr);
    } finally {
      await new Promise<void>((resolve, reject) => compiler.close((error) => (error ? reject(error) : resolve())));
    }
  }
});
