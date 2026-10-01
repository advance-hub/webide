import os from 'os';
import path from 'path';

import * as fs from 'fs-extra';
import semver from 'semver';

import { Uri, getDebugLogger } from '@opensumi/ide-core-node';

import { IExtensionMetaData, IExtraMetaData } from '../common';
import { getNodeRequire } from '../common/utils';

import {
  cloneExtensionMetadata,
  metadataKey,
  readBuiltinManifest,
  readMutableExtension,
} from './extension-metadata-cache';
import { mergeContributes } from './merge-contributes';

function resolvePath(path) {
  if (path[0] === '~') {
    return path.join(os.homedir(), path.slice(1));
  }
  return path;
}

export class ExtensionScanner {
  static async getExtension(
    extensionPath: string,
    localization: string,
    extraMetaData?: IExtraMetaData,
  ): Promise<IExtensionMetaData | undefined> {
    // Electron 中，extensionPath 可能为一个 `.asar` 结尾的路径，这种情况下，fs-extra的pathExists 会判断为不存在
    try {
      await fs.stat(extensionPath);
    } catch (e) {
      getDebugLogger().error(`extension path ${extensionPath} does not exist`);
      return;
    }

    const pkgPath = path.join(extensionPath, 'package.json');
    const defaultPkgNlsPath = path.join(extensionPath, 'package.nls.json');
    const pkgNlsPath = await ExtensionScanner.getLocalizedExtraMetadataPath(
      'package.nls',
      extensionPath,
      localization,
      '.json',
    );
    const extendPath = path.join(extensionPath, 'kaitian.js');
    const [pkgExist, defaultPkgNlsPathExist, extendExist] = await Promise.all([
      fs.pathExists(pkgPath),
      fs.pathExists(defaultPkgNlsPath),
      fs.pathExists(extendPath),
    ]);
    // Cache reads only within this scan; installed/development extensions may change between scans.
    const jsonReads = new Map<string, Promise<any>>();
    const readJSON = (filePath: string) => {
      if (!jsonReads.has(filePath)) {
        jsonReads.set(filePath, fs.readJSON(filePath));
      }
      return jsonReads.get(filePath)!;
    };

    let pkgCheckResult = pkgExist;
    const extendCheckResult = extendExist;

    if (pkgExist) {
      try {
        const packageJSON = await readJSON(pkgPath);
        if (!packageJSON.engines) {
          pkgCheckResult = false;
        } else if (!(packageJSON.engines.vscode || packageJSON.engines.kaitian)) {
          pkgCheckResult = false;
        }
      } catch (e) {
        getDebugLogger().error(e);
        pkgCheckResult = false;
      }
    }

    let pkgNlsJSON: { [key: string]: string } | undefined;
    if (pkgNlsPath) {
      pkgNlsJSON = await readJSON(pkgNlsPath);
    }

    let defaultPkgNlsJSON: { [key: string]: string } | undefined;
    if (defaultPkgNlsPathExist) {
      defaultPkgNlsJSON = await readJSON(defaultPkgNlsPath);
    }

    if (!(pkgCheckResult || extendCheckResult)) {
      return;
    }

    const extensionExtraMetaData = {};
    let packageJSON: any;
    try {
      packageJSON = await readJSON(pkgPath);
      if (extraMetaData) {
        for (const extraField of Object.keys(extraMetaData)) {
          try {
            const basename = path.basename(extraMetaData[extraField]);
            const suffix = path.extname(extraMetaData[extraField]);
            const prefix = basename.substr(0, basename.length - suffix.length);

            const extraFieldFilePath = await ExtensionScanner.getLocalizedExtraMetadataPath(
              prefix,
              extensionPath,
              localization,
              suffix,
            );

            extensionExtraMetaData[extraField] = await fs.readFile(
              extraFieldFilePath || path.join(extensionPath, extraMetaData[extraField]),
              'utf-8',
            );
          } catch (e) {
            extensionExtraMetaData[extraField] = null;
          }
        }
      }
    } catch (e) {
      getDebugLogger().error(e);
      return;
    }

    let extendConfig = {};
    if (extendExist) {
      try {
        // 这里必须clear cache, 不然每次都一样
        delete getNodeRequire().cache[extendPath];
        extendConfig = getNodeRequire()(extendPath);
      } catch (e) {
        getDebugLogger().error(e);
      }
    }

    // compatible with `kaitianContributes` declare
    if (!packageJSON.sumiContributes && packageJSON.kaitianContributes) {
      packageJSON.sumiContributes = packageJSON.kaitianContributes;
    }

    packageJSON.contributes = packageJSON.contributes || {};

    // merge for `sumiContributes` and `contributes`
    // `sumiContributesOverride` is used for override the `contributes`
    if (packageJSON.sumiContributesOverride) {
      packageJSON.contributes = Object.assign(packageJSON.contributes, packageJSON.sumiContributesOverride);
    }
    // `sumiContributes` is used for merge the `contributes`
    packageJSON.contributes = mergeContributes(packageJSON.sumiContributes, packageJSON.contributes);

    const extension = {
      // vscode 规范
      id: `${packageJSON.publisher}.${packageJSON.name}`,
      // 使用插件市场的 id
      // 从插件市场下载的插件命名规范为 ${publisher}.${name}-${version}
      extensionId: this.getExtensionIdByExtensionPath(extensionPath, packageJSON.version),
      extendConfig,
      path: extensionPath,
      packageJSON,
      defaultPkgNlsJSON,
      packageNlsJSON: pkgNlsJSON,
      extraMetadata: extensionExtraMetaData,
      realPath: await fs.realpath(extensionPath),
      uri: Uri.file(extensionPath),
    };
    return extension as IExtensionMetaData;
  }

  /**
   * 通过文件夹名获取插件 id
   * 文件夹名目前有两种：
   *  1. ${publisher}.${name}-${version} (推荐)
   *  2. ${extensionId}-${name}-${version}
   *  以上两种
   * @param extensionPath
   * @param version 可能有用户使用非 semver 的规范，所以传进来
   */
  static getExtensionIdByExtensionPath(extensionPath: string, version?: string) {
    const regExp = version ? new RegExp(`^(.+?)\\.(.+?)-(${version})$`) : /^(.+?)\.(.+?)-(\d+\.\d+\.\d+)$/;
    const baseName = path.basename(extensionPath);
    const nameStr = baseName.endsWith('.asar') ? baseName.split('.asar').shift()! : baseName;
    const match = regExp.exec(nameStr);

    if (match == null) {
      // 按照第二种方式返回
      return nameStr.split('-')[0];
    }

    const [, publisher, name] = match;
    return `${publisher}.${name}`;
  }

  private results: Map<string, IExtensionMetaData> = new Map();

  private availableExtensions: Map<string, IExtensionMetaData> = new Map();

  constructor(
    private scan: string[],
    private localization: string,
    private extensionCandidate: string[],
    private extraMetaData: IExtraMetaData,
    private options: { builtinDirectory?: string; manifestPath?: string; cacheMutable?: boolean } = {},
  ) {}

  public async run(): Promise<IExtensionMetaData[]> {
    const startedAt = Date.now();
    const scan = [...new Set(this.scan.map((dir) => resolvePath(dir)))];

    await Promise.all(
      scan
        .map((dir) => this.scanDir(dir))
        .concat(
          this.extensionCandidate.map(async (extension) => {
            await this.getExtension(extension, this.localization);
          }),
        ),
    );

    getDebugLogger().info(
      `[extension-perf] scan durationMs=${Date.now() - startedAt} count=${this.availableExtensions.size}`,
    );
    return Array.from(this.availableExtensions.values());
  }
  private async scanDir(dir: string): Promise<void> {
    if (
      this.options.manifestPath &&
      this.options.builtinDirectory &&
      path.resolve(dir) === path.resolve(this.options.builtinDirectory)
    ) {
      try {
        const manifest = await readBuiltinManifest(this.options.manifestPath, this.localization);
        const entries = manifest.localizations[this.localization];
        if (entries && metadataKey(manifest.extraMetaData) === metadataKey(this.extraMetaData)) {
          for (const entry of entries) {
            const metadata = cloneExtensionMetadata({
              ...entry,
              path: path.join(dir, entry.path),
              realPath: path.join(dir, entry.realPath),
            });
            this.addExtension(metadata);
          }
          await Promise.all(
            manifest.runtimeEntries.map((entry) => this.getExtension(path.join(dir, entry), this.localization)),
          );
          getDebugLogger().info(`[extension-perf] builtin-manifest count=${entries.length}`);
          return;
        }
      } catch (error) {
        getDebugLogger().warn('Builtin extension manifest unavailable; falling back to filesystem scan', error);
      }
    }
    getDebugLogger().info('scan directory: ', dir);
    try {
      const extensionDirArr = await fs.readdir(dir, { withFileTypes: true });
      await Promise.all(
        extensionDirArr
          .filter((entry) => entry.isDirectory() || entry.isSymbolicLink() || entry.name.endsWith('.asar'))
          .map((entry) => {
            const extensionPath = path.join(dir, entry.name);
            return this.getExtension(extensionPath, this.localization);
          }),
      );
    } catch (e) {
      getDebugLogger().error(e);
    }
  }

  static async getLocalizedExtraMetadataPath(
    prefix: string,
    extensionPath: string,
    localization: string,
    suffix: string,
  ): Promise<string | undefined> {
    const lowerCasePrefix = prefix.toLowerCase();
    const lowerCaseLocalization = localization.toLowerCase();
    const maybeExist = [
      `${prefix}.${localization}${suffix}`, // {prefix}.zh-CN{suffix}
      `${lowerCasePrefix}.${localization}${suffix}`,
      `${prefix}.${lowerCaseLocalization}${suffix}`, // {prefix}.zh-cn{suffix}
      `${lowerCasePrefix}.${lowerCaseLocalization}${suffix}`,
      `${prefix}.${localization.split('-')[0]}${suffix}`, // {prefix}.zh{suffix}
      `${lowerCasePrefix}.${localization.split('-')[0]}${suffix}`,
    ];

    for (const maybe of new Set(maybeExist)) {
      const filepath = path.join(extensionPath, maybe);
      if (await fs.pathExists(filepath)) {
        return filepath;
      }
    }
    return undefined;
  }

  private isLatestVersion(extension: IExtensionMetaData): boolean {
    if (this.availableExtensions.has(extension.id)) {
      const existedExtension = this.availableExtensions.get(extension.id)!;
      if (!existedExtension.packageJSON) {
        return true;
      }

      const existedPkgJson = existedExtension.packageJSON;
      const incomingPkgJson = extension.packageJSON;
      const compared = semver.compare(existedPkgJson.version, incomingPkgJson.version);

      if (compared === 0) {
        return false;
        // v1 greater
      } else if (compared === 1) {
        return false;
      } else {
        // v2 greater
        return true;
      }
    }

    return true;
  }

  public async getExtension(
    extensionPath: string,
    localization: string,
    extraMetaData?: IExtraMetaData,
  ): Promise<IExtensionMetaData | undefined> {
    if (this.results.has(extensionPath)) {
      return;
    }

    const extra = {
      ...this.extraMetaData,
      ...extraMetaData,
    };
    const read = () => ExtensionScanner.getExtension(extensionPath, localization, extra);
    const extension = this.options.cacheMutable
      ? await readMutableExtension(extensionPath, localization, extra, read)
      : await read();

    if (extension) {
      this.addExtension(extension);
      return extension;
    }
  }

  private addExtension(extension: IExtensionMetaData) {
    if (this.isLatestVersion(extension)) {
      this.availableExtensions.set(extension.id, extension);
    }
    this.results.set(extension.path, extension);
  }
}
