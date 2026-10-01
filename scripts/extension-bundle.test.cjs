'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } = require('node:fs');
const { createServer } = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { selectPlatform, retireSupersededExtensions } = require('./download.js');
const { receiptPath, verifyExtension } = require('./verify-extensions.cjs');

test('download failure exits nonzero and preserves the existing extension', async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'opensumi-download-failure-'));
  const previous = path.join(directory, 'vscode.css-1.88.1');
  mkdirSync(previous);
  writeFileSync(path.join(previous, 'existing.txt'), 'keep this installation');
  const registry = createServer((_request, response) => response.writeHead(503).end());
  try {
    await new Promise((resolve) => registry.listen(0, '127.0.0.1', resolve));
    const child = spawn(process.execPath, [path.join(__dirname, 'download.js')], {
      env: {
        ...process.env,
        OPENSUMI_EXTENSION_DIR: directory,
        OPENVSX_REGISTRY: `http://127.0.0.1:${registry.address().port}`,
      },
      stdio: 'ignore',
      timeout: 15_000,
    });
    const code = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', resolve);
    });
    assert.equal(code, 1);
    assert.equal(readFileSync(path.join(previous, 'existing.txt'), 'utf8'), 'keep this installation');
  } finally {
    await new Promise((resolve) => registry.close(resolve));
    rmSync(directory, { recursive: true, force: true });
  }
});

test('platform-specific extensions never use an arbitrary registry default', () => {
  const metadata = { downloads: { 'alpine-arm64': 'wrong', 'linux-x64': 'correct' } };
  assert.equal(selectPlatform(metadata, 'linux-x64'), 'linux-x64');
  assert.throws(() => selectPlatform(metadata, 'darwin-arm64'), /No extension artifact/);
  assert.equal(selectPlatform({ downloads: { universal: 'portable' } }, 'linux-arm64'), 'universal');
});

test('pinned downgrades retire managed stale versions while retaining user extensions', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'opensumi-extension-retirement-'));
  const directory = path.join(root, 'extensions');
  mkdirSync(directory);
  const write = (name, version, managed = true) => {
    const folder = path.join(directory, `test.${name}-${version}`);
    mkdirSync(folder);
    writeFileSync(path.join(folder, 'package.json'), JSON.stringify({ publisher: 'test', name, version }));
    if (managed) writeFileSync(receiptPath(folder), '{}');
    return folder;
  };
  try {
    const old = write('history', '2.0.0');
    const pinned = write('history', '1.0.0');
    const removed = write('incompatible', '1.0.0');
    const user = write('custom', '1.0.0', false);
    await retireSupersededExtensions(directory, [{ publisher: 'test', name: 'history', version: '1.0.0' }]);
    assert.throws(() => readFileSync(path.join(old, 'package.json')), /ENOENT/);
    assert.throws(() => readFileSync(path.join(removed, 'package.json')), /ENOENT/);
    assert.ok(readFileSync(path.join(pinned, 'package.json')));
    assert.ok(readFileSync(path.join(user, 'package.json')));
    const { readdirSync } = require('node:fs');
    const backup = readdirSync(root).find((name) => name.startsWith('.opensumi-retired-'));
    assert.ok(readFileSync(path.join(root, backup, 'test.history-2.0.0', 'package.json')));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('bundle verification rejects missing browser code, theme fonts and wrong platforms', () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'opensumi-extension-check-'));
  const expected = { publisher: 'test', name: 'icons', version: '1.0.0' };
  const manifest = { ...expected, browser: './browser.js', contributes: { iconThemes: [{ path: './icons.json' }] } };
  const write = (file, value) => writeFileSync(path.join(directory, file), JSON.stringify(value));
  try {
    write('package.json', manifest);
    writeFileSync(receiptPath(directory), JSON.stringify({ platform: 'linux-x64', sha256: 'a'.repeat(64) }));
    assert.throws(() => verifyExtension(directory, expected, 'linux-x64'), /Cannot find module/);
    writeFileSync(path.join(directory, 'browser.js'), 'module.exports = {};');
    write('icons.json', { fonts: [{ src: [{ path: './fonts/icons.woff' }] }] });
    assert.throws(() => verifyExtension(directory, expected, 'linux-x64'), /ENOENT/);
    mkdirSync(path.join(directory, 'fonts'));
    writeFileSync(path.join(directory, 'fonts/icons.woff'), 'fixture-font');
    assert.equal(verifyExtension(directory, expected, 'linux-x64').name, 'icons');
    write('package.json', { ...manifest, main: './node.js', browser: './missing-web.js' });
    writeFileSync(path.join(directory, 'node.js'), 'module.exports = {};');
    assert.equal(verifyExtension(directory, expected, 'linux-x64').name, 'icons');
    write('package.json', { ...manifest, main: './node.js', browser: './missing-web.js', extensionKind: ['ui'] });
    assert.throws(() => verifyExtension(directory, expected, 'linux-x64'), /Cannot find module/);
    write('package.json', manifest);
    assert.throws(() => verifyExtension(directory, expected, 'linux-arm64'), /wrong platform/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    rmSync(receiptPath(directory), { force: true });
  }
});
