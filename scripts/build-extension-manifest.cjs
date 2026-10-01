'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { ExtensionScanner } = require('../packages/extension/lib/node/extension.scanner.js');

async function buildExtensionManifest(directory, output) {
  directory = await fs.realpath(directory);
  const entries = await fs.readdir(directory, { withFileTypes: true });
  const locales = new Set([
    'en',
    'en-US',
    'zh-CN',
    'zh-cn',
    'zh-TW',
    'zh-tw',
    'de',
    'es',
    'fr',
    'it',
    'ja',
    'ko',
    'pt-BR',
    'ru',
  ]);
  const staticEntries = [];
  const runtimeEntries = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink() && !entry.name.endsWith('.asar')) continue;
    const target = path.join(directory, entry.name);
    const realPath = await fs.realpath(target);
    const relative = path.relative(directory, realPath);
    const files = entry.name.endsWith('.asar') ? [] : await fs.readdir(target);
    if (!entry.name.endsWith('.asar') && !files.includes('package.json') && !files.includes('kaitian.js')) continue;
    if (
      files.includes('kaitian.js') ||
      entry.name.endsWith('.asar') ||
      relative.startsWith('..') ||
      path.isAbsolute(relative)
    ) {
      runtimeEntries.push(entry.name);
      continue;
    }
    for (const file of files) {
      const match = /^package\.nls\.(.+)\.json$/.exec(file);
      if (match) {
        locales.add(match[1]);
        const [language, region] = match[1].split('-');
        if (region) locales.add(`${language.toLowerCase()}-${region.toUpperCase()}`);
      }
    }
    staticEntries.push(entry.name);
  }
  const extraMetaData = { languageBundle: './package.nls.json' };
  const shardDirectory = `${output}.d`;
  await fs.mkdir(shardDirectory, { recursive: true });
  const localeFiles = {};
  for (const locale of [...locales].sort()) {
    const metadata = await Promise.all(
      staticEntries.map(async (entry) => {
        const metadata = await ExtensionScanner.getExtension(path.join(directory, entry), locale, extraMetaData);
        if (!metadata) throw new Error(`Cannot precompute builtin extension: ${entry}`);
        return {
          ...metadata,
          path: path.relative(directory, metadata.path),
          realPath: path.relative(directory, metadata.realPath),
          uri: undefined,
        };
      }),
    );
    const shard = path.join(shardDirectory, `${encodeURIComponent(locale)}.json`);
    await fs.writeFile(
      shard,
      JSON.stringify({ version: 1, extraMetaData, runtimeEntries, localizations: { [locale]: metadata } }),
    );
    localeFiles[locale] = path.relative(path.dirname(output), shard);
  }
  const manifest = { version: 1, extraMetaData, localizations: {}, runtimeEntries, localeFiles };
  const temporary = `${output}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(manifest));
  await fs.rename(temporary, output);
  console.log(
    `Precomputed ${staticEntries.length} builtin extensions in ${locales.size} locales; ${runtimeEntries.length} dynamic entries`,
  );
  return manifest;
}

module.exports = { buildExtensionManifest };
if (require.main === module) {
  const directory = path.resolve(process.argv[2] || 'tools/extensions');
  buildExtensionManifest(directory, path.resolve(process.argv[3] || `${directory}.manifest.json`)).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
