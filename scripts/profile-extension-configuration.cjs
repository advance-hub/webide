'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

assert.equal(typeof global.gc, 'function', '请使用 node --expose-gc 运行该隔离探针');
const entry = path.resolve('packages/extension/lib/hosted/api/vscode/ext.host.preference.js');
const { ExtHostPreference } = require(entry);
const service = new ExtHostPreference({ getProxy: () => ({}) }, undefined);
const defaults = { 'sample.options': { nested: { value: 1 } } };
for (let index = 0; index < 2000; index++) {
  defaults[`fixture${index}.options`] = { index, enabled: true, label: `fixture-${index}` };
}
service.init({ 0: defaults, 1: {}, 2: {}, 3: {} });
const configuration = service.getConfiguration();
global.gc();
const before = process.memoryUsage();
const started = performance.now();
const cpu = process.cpuUsage();
const snapshots = [];
for (let index = 0; index < 80; index++) {
  const value = configuration.get('sample.options');
  value.nested.value = index;
  assert.equal(JSON.parse(JSON.stringify(value)).nested.value, index);
  snapshots.push(value);
}
assert.equal(configuration.get('sample.options').nested.value, 1);
global.gc();
const after = process.memoryUsage();
const usedCPU = process.cpuUsage(cpu);
process.stdout.write(
  `${JSON.stringify({
    scope: '隔离配置快照探针；显式 GC，不代表整棵 IDE',
    node: process.version,
    sourceSHA256: createHash('sha256').update(fs.readFileSync(entry)).digest('hex'),
    configurationKeys: Object.keys(defaults).length,
    retainedSnapshots: snapshots.length,
    heapDeltaMiB: (after.heapUsed - before.heapUsed) / 1024 ** 2,
    rssDeltaMiB: (after.rss - before.rss) / 1024 ** 2,
    elapsedMs: performance.now() - started,
    cpuMs: (usedCPU.user + usedCPU.system) / 1000,
  })}\n`,
);
