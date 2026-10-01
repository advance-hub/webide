'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');
const themeRequire = createRequire(path.resolve(__dirname, '../packages/theme/lib/index.js'));
const { parse } = themeRequire('jsonc-parser');

function expectedExtensions() {
  const { extensions } = require('../configs/vscode-extensions.json');
  return Object.entries(extensions).flatMap(([publisher, items]) => items.map((item) => ({ publisher, ...item })));
}

function receiptPath(directory) {
  return `${directory}.opensumi-install.json`;
}

function verifyExtension(directory, expected, targetPlatform, downloadedReceipt) {
  const manifestPath = path.join(directory, 'package.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const id = `${expected.publisher}.${expected.name}`;
  assert.equal(manifest.publisher.toLowerCase(), expected.publisher.toLowerCase(), `${id}: publisher`);
  assert.equal(manifest.name, expected.name, `${id}: name`);
  assert.equal(manifest.version, expected.version, `${id}: version`);
  const receipt = downloadedReceipt || JSON.parse(fs.readFileSync(receiptPath(directory), 'utf8'));
  assert.match(receipt.sha256, /^[a-f0-9]{64}$/i, `${id}: checksum receipt`);
  assert.ok(receipt.platform === 'universal' || receipt.platform === targetPlatform, `${id}: wrong platform`);
  const extensionRequire = createRequire(manifestPath);
  // Match the hybrid host's selection. Some legacy Node VSIXs declare a web
  // entry that is only included in their web distribution.
  const preferredKind = Array.isArray(manifest.extensionKind) ? manifest.extensionKind[0] : manifest.extensionKind;
  const entry = manifest.browser && (!manifest.main || preferredKind === 'ui') ? manifest.browser : manifest.main;
  if (typeof entry === 'string') {
    extensionRequire.resolve('./' + entry.replace(/^\.\//, ''));
  }
  const resource = (relative, base = directory) => {
    if (!relative || /^https?:/.test(relative)) return undefined;
    const resolved = path.resolve(base, relative);
    assert.ok(resolved.startsWith(path.resolve(directory) + path.sep), `${id}: resource outside extension`);
    assert.ok(fs.statSync(resolved).isFile(), `${id}: missing resource ${relative}`);
    return resolved;
  };
  const contributions = manifest.contributes || {};
  for (const item of [...(contributions.grammars || []), ...(contributions.snippets || [])]) resource(item.path);
  for (const item of contributions.languages || []) resource(item.configuration);
  for (const item of [
    ...(contributions.themes || []),
    ...(contributions.iconThemes || []),
    ...(contributions.productIconThemes || []),
  ]) {
    const filename = resource(item.path);
    const theme = parse(fs.readFileSync(filename, 'utf8'));
    for (const definition of Object.values(theme.iconDefinitions || {}))
      resource(definition.iconPath, path.dirname(filename));
    for (const font of theme.fonts || []) {
      for (const source of font.src || []) resource(source.path, path.dirname(filename));
    }
  }
  return manifest;
}

function verifyExtensions(directory, platform = `${process.platform}-${process.arch}`) {
  const manifests = expectedExtensions().map((extension) =>
    verifyExtension(
      path.join(directory, `${extension.publisher}.${extension.name}-${extension.version}`),
      extension,
      platform,
    ),
  );
  const installed = new Set(manifests.map((manifest) => `${manifest.publisher}.${manifest.name}`.toLowerCase()));
  for (const manifest of manifests) {
    for (const dependency of manifest.extensionDependencies || []) {
      assert.ok(
        installed.has(dependency.toLowerCase()),
        `${manifest.name}: missing extension dependency ${dependency}`,
      );
    }
  }
  assert.ok(
    manifests.some((manifest) => manifest.contributes?.iconThemes?.length),
    'Missing file icon themes',
  );
  console.log(`Verified ${manifests.length} builtin extensions, entrypoints, themes, fonts and grammars (${platform})`);
}

module.exports = { expectedExtensions, receiptPath, verifyExtension, verifyExtensions };
if (require.main === module) {
  verifyExtensions(
    path.resolve(process.argv[2] || process.env.OPENSUMI_EXTENSION_DIR || path.join(__dirname, '../tools/extensions')),
    process.env.OPENSUMI_EXTENSION_PLATFORM || `${process.platform}-${process.arch}`,
  );
}
