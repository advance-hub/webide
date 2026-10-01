'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { installedVersion } = require('./tool-versions.cjs');

test('installed JDK and Maven metadata is readable without launching either JVM', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clouddev-versions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.mkdirSync(path.join(root, 'lib'));
  for (const binary of ['java', 'mvn'])
    fs.writeFileSync(path.join(root, 'bin', binary), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'release'), 'JAVA_VERSION="21.0.12"\n');
  fs.writeFileSync(path.join(root, 'lib/maven-core-3.9.16.jar'), 'fixture');
  const env = { PATH: path.join(root, 'bin') };
  assert.equal(installedVersion('java', env), 'java version "21.0.12"');
  assert.equal(installedVersion('mvn', env), 'Apache Maven 3.9.16');
  fs.rmSync(path.join(root, 'release'));
  assert.equal(installedVersion('java', env), undefined);
  fs.rmSync(path.join(root, 'bin/java'));
  assert.equal(installedVersion('java', env), '');
});
