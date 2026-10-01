import os from 'os';
import path from 'path';

import * as fs from 'fs-extra';

import { ExtensionScanner } from '../../src/node/extension.scanner';

describe('ExtensionScanner', () => {
  describe('filesystem scanning', () => {
    let directory: string;

    beforeEach(async () => {
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-scanner-'));
    });

    afterEach(async () => {
      jest.restoreAllMocks();
      await fs.remove(directory);
    });

    const writeExtension = async (root: string, version: string) => {
      const target = path.join(root, `test.example-${version}`);
      await fs.ensureDir(target);
      await fs.writeJSON(path.join(target, 'package.json'), {
        publisher: 'test',
        name: 'example',
        version,
        engines: { vscode: '*' },
        displayName: '%name%',
      });
      await fs.writeJSON(path.join(target, 'package.nls.json'), { name: 'Default' });
      await fs.writeJSON(path.join(target, 'package.nls.zh-cn.json'), { name: '中文' });
      return target;
    };

    it('preserves latest-version metadata and localization while ignoring sidecar files', async () => {
      expect.hasAssertions();
      await writeExtension(directory, '1.0.0');
      const latest = await writeExtension(directory, '2.0.0');
      await fs.writeJSON(path.join(directory, 'test.example.opensumi-install.json'), { installed: true });
      const read = jest.spyOn(jest.requireActual('fs-extra'), 'readJSON');
      const result = await new ExtensionScanner([directory, directory], 'zh-CN', [], {}).run();
      expect(result).toHaveLength(1);
      expect(result[0]).toMatchObject({
        id: 'test.example',
        path: latest,
        packageJSON: { version: '2.0.0' },
        defaultPkgNlsJSON: { name: 'Default' },
        packageNlsJSON: { name: '中文' },
      });
      expect(read.mock.calls.filter(([file]) => file === path.join(latest, 'package.json'))).toHaveLength(1);
    });

    it('reads changed manifests on a new scan and discovers symbolic links', async () => {
      expect.hasAssertions();
      const source = await fs.mkdtemp(path.join(os.tmpdir(), 'extension-source-'));
      try {
        const target = await writeExtension(source, '1.0.0');
        await fs.symlink(target, path.join(directory, 'linked-extension'), 'dir');
        const scan = () => new ExtensionScanner([directory], 'en', [], {}).run();
        expect((await scan())[0].packageJSON.displayName).toBe('%name%');
        const manifest = path.join(target, 'package.json');
        await fs.writeJSON(manifest, { ...(await fs.readJSON(manifest)), displayName: 'Updated' });
        expect((await scan())[0].packageJSON.displayName).toBe('Updated');
      } finally {
        await fs.remove(source);
      }
    });

    it('discovers builtin and newly installed user extensions', async () => {
      expect.hasAssertions();
      const builtin = path.join(directory, 'builtin');
      const user = path.join(directory, 'user');
      await fs.ensureDir(builtin);
      await fs.ensureDir(user);
      const original = await writeExtension(builtin, '1.0.0');
      const scan = () => new ExtensionScanner([builtin, user], 'en', [], {}, { builtinDirectory: builtin }).run();
      expect((await scan())[0]).toMatchObject({ id: 'test.example', path: original });
      const installed = await writeExtension(user, '2.0.0');
      expect((await scan())[0]).toMatchObject({ id: 'test.example', path: installed });
    });
  });

  describe('ExtensionScanner.getExtensionIdByExtensionPath', () => {
    it('can read publisher.name', () => {
      const extensionPath = '~/extensions/cloud-ide.debug-1.0.0';
      const extensionId = ExtensionScanner.getExtensionIdByExtensionPath(extensionPath);
      expect(extensionId).toEqual('cloud-ide.debug');
    });

    it('can read publisher.name and give version', () => {
      const extensionPath = '~/extensions/cloud-ide.debug-lite-1.0.0';
      const extensionId = ExtensionScanner.getExtensionIdByExtensionPath(extensionPath, '1.0.0');
      expect(extensionId).toEqual('cloud-ide.debug-lite');
    });

    it('can read extensionId', () => {
      const extensionPath = '~/extensions/5da45c36392bdd7063eb0e11-configuration-editing-1.0.0';
      const extensionId = ExtensionScanner.getExtensionIdByExtensionPath(extensionPath);
      expect(extensionId).toEqual('5da45c36392bdd7063eb0e11');
    });
  });
});
