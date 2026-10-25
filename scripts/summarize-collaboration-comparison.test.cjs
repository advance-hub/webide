'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { summarizeComparison } = require('./summarize-collaboration-comparison.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webide-comparison-summary-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, value) => {
    const file = path.join(root, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value));
  };
  write('manifest.json', { baseline: { name: 'baseline' }, optimized: { name: 'optimized' } });
  write('cleanup/owned/cleanup.json', { pass: true });
  const records = [];
  for (const variant of ['baseline', 'optimized']) {
    for (const round of [1, 2, 3]) {
      // 中间轮显著更高，用于区分三轮中位数与直接合并所有采样的统计口径。
      const amount = [100, 1000, 200][round - 1] * (variant === 'baseline' ? 1 : 0.5);
      const record = {
        pass: true,
        harnessChanged: false,
        unexpectedBrowserErrors: 0,
        cleanupErrors: [],
        comparisonVariant: variant,
        comparisonRound: round,
        watcherMode: 'per-client',
        image: variant,
        harnessSha256: { probe: 'same' },
        samples: ['shared-workspace', 'independent-workspaces'].flatMap((scenario) =>
          Array.from({ length: 30 }, (_, index) => ({
            scenario,
            rssMiB: amount,
            pssMiB: amount / 2,
            hostLoad: [1, 1, 1],
            processes: [[{ command: '/node/tsserver.js --flag', rssKiB: amount * 1024 }]],
            containers: Array.from({ length: scenario === 'shared-workspace' ? 1 : 5 }, () => ({
              available: true,
              memoryMaxBytes: 4 * 1024 ** 3,
              oomKills: 0,
              memoryCurrentBytes: amount * 1024 ** 2,
              memoryPeakBytes: amount * 1024 ** 2,
              cpuPercent: index ? 10 : undefined,
              cpuThrottledUsec: 0,
            })),
          })),
        ),
        performanceMeasurements: Array.from({ length: 10 }, () => ({
          editorReadyMs: 1,
          completionMs: 2,
          diagnosticMs: 3,
          searchMs: 4,
          quickOpenMs: 5,
        })),
      };
      const name = `${variant}/round-${round}/result.json`;
      write(name, record);
      records.push({ name, record });
    }
  }
  return { root, records, write };
}

test('完整三轮使用每轮 P95 的中位数，分别汇总进程和容器口径', (t) => {
  const { root } = fixture(t);
  const result = summarizeComparison(root);
  assert.equal(result.variants.baseline.samples, 180);
  assert.deepEqual(result.changes['shared-workspace'].rssP95MiB, { before: 200, after: 100, reductionPercent: 50 });
  assert.equal(
    result.variants.baseline.scenarios['independent-workspaces'].medianRoundMetrics.containerMemoryP95MiB,
    1000,
  );
  assert.equal(result.evidence.length, 6);
  assert.deepEqual(result.changes['shared-workspace'].typescriptRssP95MiB, {
    before: 200,
    after: 100,
    reductionPercent: 50,
  });
});

test('失败、探针变化、缺失 CPU 区间或未回收均拒绝发布统计', (t) => {
  const { root, records, write } = fixture(t);
  const first = records[0];
  for (const mutate of [
    (record) => {
      record.pass = false;
    },
    (record) => {
      record.harnessSha256.probe = 'different';
    },
    (record) => {
      record.samples[1].containers[0].cpuPercent = undefined;
    },
    (record) => {
      record.samples[0].containers[0].oomKills = 1;
    },
  ]) {
    const value = structuredClone(first.record);
    mutate(value);
    write(first.name, value);
    assert.throws(() => summarizeComparison(root));
    write(first.name, first.record);
  }
  write('cleanup/owned/cleanup.json', { pass: false });
  assert.throws(() => summarizeComparison(root), /尚未完全释放/);
});

test('任一轮没有 PSS 时保留空值，不能计算虚假的百分比', (t) => {
  const { root, records, write } = fixture(t);
  const last = records.at(-1);
  last.record.samples[0].pssMiB = null;
  write(last.name, last.record);
  assert.deepEqual(summarizeComparison(root).changes['shared-workspace'].pssP95MiB, {
    before: 100,
    after: null,
    reductionPercent: null,
  });
});
