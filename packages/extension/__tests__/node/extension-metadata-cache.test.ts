import os from 'os';
import path from 'path';

import * as fs from 'fs-extra';

import { ExtensionScanner } from '../../src/node/extension.scanner';

describe('extension metadata reuse', () => {
  let root: string;
  const extra = { languageBundle: './package.nls.json' };
  const fixture = async (directory: string, version = '1.0.0') => {
    const target = path.join(directory, `test.example-${version}`);
    await fs.outputJSON(path.join(target, 'package.json'), {
      name: 'example',
      publisher: 'test',
      version,
      engines: { vscode: '*' },
      displayName: 'Example',
    });
    await fs.outputJSON(path.join(target, 'package.nls.json'), { title: 'Default' });
    await fs.outputJSON(path.join(target, 'package.nls.zh-CN.json'), { title: '中文' });
    return target;
  };

  beforeEach(async () => {
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'extension-cache-')));
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    await fs.remove(root);
  });

  it('loads relocated builtin metadata without scanning and isolates consumer mutations', async () => {
    expect.hasAssertions();
    const source = path.join(root, 'build');
    await fixture(source);
    const original = await new ExtensionScanner([source], 'zh-CN', [], extra).run();
    const filename = path.join(root, 'manifest.json');
    await fs.writeJSON(path.join(root, 'zh-CN.json'), {
      version: 1,
      extraMetaData: extra,
      runtimeEntries: [],
      localizations: {
        'zh-CN': original.map((entry) => ({
          ...entry,
          path: path.relative(source, entry.path),
          realPath: path.relative(source, entry.realPath),
        })),
      },
    });
    await fs.writeJSON(filename, {
      version: 1,
      extraMetaData: extra,
      runtimeEntries: [],
      localizations: {},
      localeFiles: { 'zh-CN': 'zh-CN.json' },
    });
    const runtime = path.join(root, 'runtime');
    await fs.copy(source, runtime);
    const expected = await new ExtensionScanner([runtime], 'zh-CN', [], extra).run();
    const options = { builtinDirectory: runtime, manifestPath: filename };
    const readDir = jest.spyOn(jest.requireActual('fs-extra'), 'readdir');
    const readJSON = jest.spyOn(jest.requireActual('fs-extra'), 'readJSON');
    const first = await new ExtensionScanner([runtime], 'zh-CN', [], extra, options).run();
    expect(first).toEqual(expected);
    first[0].packageJSON.displayName = 'Mutated';
    const second = await new ExtensionScanner([runtime], 'zh-CN', [], extra, options).run();
    expect(second).toEqual(expected);
    expect(readDir).not.toHaveBeenCalled();
    expect(readJSON).toHaveBeenCalledTimes(2);
    const marketplace = path.join(root, 'marketplace');
    await fixture(marketplace, '2.0.0');
    expect(
      (await new ExtensionScanner([runtime, marketplace], 'zh-CN', [], extra, options).run())[0].packageJSON.version,
    ).toBe('2.0.0');
  });

  it('invalidates mutable metadata on edits, locale changes, installation and removal', async () => {
    expect.hasAssertions();
    const target = await fixture(root);
    const scan = () => new ExtensionScanner([root], 'zh-CN', [], extra, { cacheMutable: true }).run();
    const original = await scan();
    const read = jest.spyOn(jest.requireActual('fs-extra'), 'readJSON');
    const cached = await scan();
    expect(cached).toEqual(original);
    expect(read).not.toHaveBeenCalled();
    const manifest = path.join(target, 'package.json');
    await fs.writeJSON(manifest, { ...(await fs.readJSON(manifest)), displayName: 'Changed manifest' });
    expect((await scan())[0].packageJSON.displayName).toBe('Changed manifest');
    await fs.writeJSON(path.join(target, 'package.nls.zh-CN.json'), { title: '新翻译' });
    expect((await scan())[0].packageNlsJSON).toEqual({ title: '新翻译' });
    const upgraded = await fixture(root, '2.0.0');
    expect((await scan())[0].packageJSON.version).toBe('2.0.0');
    await fs.remove(upgraded);
    expect((await scan())[0].packageJSON.version).toBe('1.0.0');
    await fs.remove(target);
    expect(await scan()).toEqual([]);
  });

  it('falls back when the manifest is corrupt, missing a locale, or extra fields differ', async () => {
    expect.hasAssertions();
    await fixture(root);
    const expected = await new ExtensionScanner([root], 'zh-CN', [], extra).run();
    const filename = path.join(root, 'manifest.json');
    await fs.writeFile(filename, '{broken');
    const options = { builtinDirectory: root, manifestPath: filename };
    expect(await new ExtensionScanner([root], 'zh-CN', [], extra, options).run()).toEqual(expected);
    await fs.writeJSON(filename, { version: 1, extraMetaData: extra, runtimeEntries: [], localizations: { en: [] } });
    expect(await new ExtensionScanner([root], 'zh-CN', [], extra, options).run()).toEqual(expected);
    expect(await new ExtensionScanner([root], 'en', [], {}, options).run()).toHaveLength(1);
  });

  it('keeps executable configuration on the live scanner path', async () => {
    expect.hasAssertions();
    const target = await fixture(root);
    await fs.writeFile(path.join(target, 'kaitian.js'), 'module.exports = { value: () => 42 };');
    const scan = () => new ExtensionScanner([root], 'zh-CN', [], extra, { cacheMutable: true }).run();
    const first = await scan();
    const read = jest.spyOn(jest.requireActual('fs-extra'), 'readJSON');
    const second = await scan();
    expect(first[0].extendConfig.value()).toBe(42);
    expect(second[0].extendConfig.value()).toBe(42);
    expect(read).toHaveBeenCalled();
  });
});
