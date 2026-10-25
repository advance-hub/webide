'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const readRuntimeMetrics = require('./runtime-metrics.cjs');

test('区分进程 RSS、缺失 PSS 和容器计数器，保留 OOM 与节流证据', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webide-metrics-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const proc = path.join(root, 'proc');
  const cgroup = path.join(root, 'cgroup');
  fs.mkdirSync(path.join(proc, '123'), { recursive: true });
  fs.mkdirSync(cgroup);
  fs.writeFileSync(path.join(proc, 'uptime'), '123.5 0\n');
  fs.writeFileSync(path.join(proc, '123/status'), 'PPid:\t12\nVmRSS:\t2048 kB\n');
  fs.writeFileSync(path.join(proc, '123/cmdline'), 'node\0server.js\0');
  for (const [name, value] of Object.entries({
    'memory.current': '4194304',
    'memory.peak': '8388608',
    'memory.max': '4294967296',
    'memory.stat': 'anon 1000\nfile 2000\n',
    'cpu.stat': 'usage_usec 3000\nthrottled_usec 4000\n',
    'memory.events': 'oom 2\noom_kill 1\n',
  }))
    fs.writeFileSync(path.join(cgroup, name), value);
  const first = readRuntimeMetrics(proc, cgroup);
  assert.equal(first.processes[0].rssKiB, 2048);
  assert.equal(first.processes[0].pssKiB, null);
  assert.equal(first.container.memoryCurrentBytes, 4194304);
  assert.equal(first.container.memoryMaxBytes, 4294967296);
  assert.equal(first.container.fileCacheBytes, 2000);
  assert.equal(first.container.cpuUsageUsec, 3000);
  assert.equal(first.container.oomKills, 1);
  fs.writeFileSync(path.join(proc, '123/smaps_rollup'), 'Pss: 1024 kB\n');
  assert.equal(readRuntimeMetrics(proc, cgroup).processes[0].pssKiB, 1024);
  fs.unlinkSync(path.join(cgroup, 'memory.current'));
  assert.equal(readRuntimeMetrics(proc, cgroup).container.available, false);
});
