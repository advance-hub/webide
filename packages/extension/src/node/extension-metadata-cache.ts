import path from 'path';

import * as fs from 'fs-extra';

import { Uri } from '@opensumi/ide-core-node';

import { IExtensionMetaData, IExtraMetaData } from '../common';

export interface BuiltinExtensionManifest {
  version: 1;
  extraMetaData: IExtraMetaData;
  localizations: Record<string, IExtensionMetaData[]>;
  runtimeEntries: string[];
  localeFiles?: Record<string, string>;
}

export const metadataKey = (extra: IExtraMetaData) =>
  JSON.stringify(
    Object.keys(extra)
      .sort()
      .map((key) => [key, extra[key]]),
  );

export function cloneExtensionMetadata(value: IExtensionMetaData): IExtensionMetaData {
  const copy = structuredClone(value) as IExtensionMetaData;
  copy.uri = Uri.file(copy.path);
  return copy;
}

const manifests = new Map<string, Promise<BuiltinExtensionManifest>>();

async function loadManifest(filename: string): Promise<BuiltinExtensionManifest> {
  let pending = manifests.get(filename);
  if (!pending) {
    pending = fs.readJSON(filename).then((value: BuiltinExtensionManifest) => {
      const safePath = (relative: string) =>
        typeof relative === 'string' &&
        relative.length > 0 &&
        !path.isAbsolute(relative) &&
        !relative.split(/[\\/]/).includes('..');
      if (
        value.version !== 1 ||
        !value.extraMetaData ||
        !value.localizations ||
        !Array.isArray(value.runtimeEntries) ||
        !value.runtimeEntries.every(safePath) ||
        (value.localeFiles && !Object.values(value.localeFiles).every(safePath)) ||
        !Object.values(value.localizations).every(
          (entries) =>
            Array.isArray(entries) &&
            entries.every(
              (entry) =>
                safePath(entry.path) &&
                safePath(entry.realPath) &&
                typeof entry.id === 'string' &&
                typeof entry.packageJSON?.version === 'string',
            ),
        )
      ) {
        throw new Error('Invalid builtin extension manifest');
      }
      return value;
    });
    if (manifests.size >= 4) {
      manifests.delete(manifests.keys().next().value!);
    }
    manifests.set(filename, pending);
    void pending.catch(() => manifests.delete(filename));
  }
  return pending;
}

export async function readBuiltinManifest(filename: string, locale: string): Promise<BuiltinExtensionManifest> {
  const index = await loadManifest(filename);
  const shard = index.localeFiles?.[locale];
  return shard ? loadManifest(path.join(path.dirname(filename), shard)) : index;
}

// Mutable extensions are checked on every scan. Only parsed metadata is cached;
// installation, deletion, localization edits and same-version replacements remain visible.
const mutableMetadata = new Map<string, { signature: string; metadata: IExtensionMetaData }>();

export async function readMutableExtension(
  directory: string,
  localization: string,
  extra: IExtraMetaData,
  read: () => Promise<IExtensionMetaData | undefined>,
): Promise<IExtensionMetaData | undefined> {
  const key = JSON.stringify([directory, localization, metadataKey(extra)]);
  try {
    const entries = await fs.readdir(directory);
    // Executable configuration and arbitrary extra paths must retain their original semantics.
    if (entries.includes('kaitian.js') || Object.values(extra).some((file) => path.dirname(file) !== '.')) {
      return read();
    }
    const extraNames = new Set(Object.values(extra).map((file) => path.basename(file).split('.')[0]));
    const files = entries
      .filter(
        (file) => file === 'package.json' || file.startsWith('package.nls.') || extraNames.has(file.split('.')[0]),
      )
      .sort();
    const signature = JSON.stringify([
      await fs.realpath(directory),
      await Promise.all(
        files.map(async (file) => {
          const stat = await fs.stat(path.join(directory, file));
          return [file, stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino];
        }),
      ),
    ]);
    const cached = mutableMetadata.get(key);
    if (cached?.signature === signature) {
      mutableMetadata.delete(key);
      mutableMetadata.set(key, cached);
      return cloneExtensionMetadata(cached.metadata);
    }
    const metadata = await read();
    mutableMetadata.delete(key);
    if (metadata) {
      if (mutableMetadata.size >= 256) {
        mutableMetadata.delete(mutableMetadata.keys().next().value!);
      }
      mutableMetadata.set(key, { signature, metadata: cloneExtensionMetadata(metadata) });
    }
    return metadata;
  } catch {
    mutableMetadata.delete(key);
    return read();
  }
}
