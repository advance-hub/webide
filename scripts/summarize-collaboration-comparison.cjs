'use strict';
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const quantile = (values, ratio) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * ratio) - 1];
const median = (values) => quantile(values, 0.5);
const roles = {
  typescript: (command) => /\/(?:tsserver|typingsInstaller)\.js(?: |$)/.test(command),
  otherLanguageServers: (command) => /\/(?:eslintServer|languageserver)\.js(?: |$)/.test(command),
  extensionHosts: (command) => /\/ext\.process\.js(?: |$)/.test(command),
  watchers: (command) => /\/watcher\.process\.js(?: |$)/.test(command),
};
function summarizeComparison(root) {
  const scenarios = ['shared-workspace', 'independent-workspaces'];
  const variants = {};
  let harness;
  const evidence = [];
  const imageManifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json')));
  const cleanupRoot = path.join(root, 'cleanup');
  const cleanupFiles = fs.readdirSync(cleanupRoot).map((name) => path.join(cleanupRoot, name, 'cleanup.json'));
  assert.equal(cleanupFiles.length, 1, '每组正式对照应只拥有一个隔离 daemon');
  assert.equal(JSON.parse(fs.readFileSync(cleanupFiles[0])).pass, true, '隔离资源尚未完全释放');
  for (const variant of ['baseline', 'optimized']) {
    const records = [1, 2, 3].map((round) => {
      const file = path.join(root, variant, `round-${round}/result.json`);
      const bytes = fs.readFileSync(file);
      const record = JSON.parse(bytes);
      assert.equal(record.pass, true, `${file} 尚未通过`);
      assert.equal(record.harnessChanged, false, `${file} 在运行中修改了探针`);
      assert.equal(record.unexpectedBrowserErrors, 0);
      assert.deepEqual(record.cleanupErrors, []);
      assert.equal(record.comparisonVariant, variant);
      assert.equal(record.comparisonRound, round);
      assert.equal(record.watcherMode, 'per-client');
      assert.equal(record.image, imageManifest[variant].name);
      assert.equal(record.samples.length, 60);
      harness ||= record.harnessSha256;
      assert.deepEqual(record.harnessSha256, harness, '六次运行必须使用相同探针');
      evidence.push({ file: path.relative(root, file), sha256: createHash('sha256').update(bytes).digest('hex') });
      return record;
    });
    const scenarioSummary = {};
    for (const scenario of scenarios) {
      const roundMetrics = records.map((record) => {
        const rows = record.samples.filter((sample) => sample.scenario === scenario);
        assert.equal(rows.length, 30);
        for (const sample of rows) {
          assert.equal(sample.containers.length, scenario === 'shared-workspace' ? 1 : 5);
          for (const container of sample.containers) {
            assert.equal(container.available, true);
            assert.equal(container.memoryMaxBytes, 4 * 1024 ** 3);
            assert.equal(container.oomKills, 0);
            assert(Number.isFinite(container.memoryCurrentBytes) && container.memoryCurrentBytes > 0);
          }
          assert(Number.isFinite(sample.rssMiB) && sample.rssMiB > 0);
          assert(sample.pssMiB === null || (Number.isFinite(sample.pssMiB) && sample.pssMiB > 0));
          assert(sample.processes.flat().every((process) => Number.isFinite(process.rssKiB) && process.rssKiB >= 0));
        }
        const cpu = rows.filter((sample) =>
          sample.containers.every((container) => Number.isFinite(container.cpuPercent)),
        );
        assert.equal(cpu.length, 29, '每轮第一份用于建立 CPU 差分，其他份不能缺失');
        return {
          rssP95MiB: quantile(
            rows.map((sample) => sample.rssMiB),
            0.95,
          ),
          pssP95MiB: rows.every((sample) => sample.pssMiB !== null)
            ? quantile(
                rows.map((sample) => sample.pssMiB),
                0.95,
              )
            : null,
          containerMemoryP95MiB: quantile(
            rows.map((sample) => sample.containers.reduce((sum, c) => sum + c.memoryCurrentBytes / 1024 ** 2, 0)),
            0.95,
          ),
          sumContainerLifetimePeaksMiB: Math.max(
            ...rows.map((sample) => sample.containers.reduce((sum, c) => sum + c.memoryPeakBytes / 1024 ** 2, 0)),
          ),
          cpuP95Percent: quantile(
            cpu.map((sample) => sample.containers.reduce((sum, c) => sum + c.cpuPercent, 0)),
            0.95,
          ),
          lifetimeThrottledUsec: Math.max(
            ...rows.map((sample) => sample.containers.reduce((sum, c) => sum + c.cpuThrottledUsec, 0)),
          ),
          ...Object.fromEntries(
            Object.entries(roles).map(([name, matches]) => [
              `${name}RssP95MiB`,
              quantile(
                rows.map((sample) =>
                  sample.processes
                    .flat()
                    .filter((process) => matches(process.command))
                    .reduce((sum, process) => sum + process.rssKiB / 1024, 0),
                ),
                0.95,
              ),
            ]),
          ),
        };
      });
      const allRows = records.flatMap((record) => record.samples.filter((sample) => sample.scenario === scenario));
      const tsservers = allRows.map(
        (sample) => sample.processes.flat().filter((p) => /\/tsserver\.js(?: |$)/.test(p.command)).length,
      );
      scenarioSummary[scenario] = {
        samples: allRows.length,
        rounds: roundMetrics,
        medianRoundMetrics: Object.fromEntries(
          Object.keys(roundMetrics[0]).map((key) => [
            key,
            roundMetrics.every((round) => round[key] !== null) ? median(roundMetrics.map((round) => round[key])) : null,
          ]),
        ),
        tsserverCount: { minimum: Math.min(...tsservers), maximum: Math.max(...tsservers) },
      };
    }
    const latencies = records.flatMap((record) => record.performanceMeasurements);
    assert(latencies.length >= 30);
    const loads = records.flatMap((record) => record.samples.map((sample) => sample.hostLoad[0]));
    variants[variant] = {
      samples: records.reduce((sum, record) => sum + record.samples.length, 0),
      scenarios: scenarioSummary,
      latencyMs: Object.fromEntries(
        ['editorReadyMs', 'completionMs', 'diagnosticMs', 'searchMs', 'quickOpenMs'].map((key) => {
          const values = latencies.map((value) => value[key]);
          assert(values.every(Number.isFinite), `缺少 ${key}`);
          return [key, { samples: values.length, p50: quantile(values, 0.5), p95: quantile(values, 0.95) }];
        }),
      ),
      hostLoad: { minimum: Math.min(...loads), maximum: Math.max(...loads) },
    };
  }
  const changes = {};
  for (const scenario of scenarios) {
    changes[scenario] = Object.fromEntries(
      Object.keys(variants.baseline.scenarios[scenario].medianRoundMetrics).map((key) => {
        const before = variants.baseline.scenarios[scenario].medianRoundMetrics[key];
        const after = variants.optimized.scenarios[scenario].medianRoundMetrics[key];
        return [
          key,
          {
            before,
            after,
            reductionPercent:
              before !== null && after !== null && before !== 0 ? ((before - after) / before) * 100 : null,
          },
        ];
      }),
    );
  }
  const summary = {
    schemaVersion: 1,
    functionalPass: true,
    generatedAt: new Date().toISOString(),
    hostLogicalCPUs: os.cpus().length,
    harnessSha256: harness,
    imageManifest,
    variants,
    changes,
    evidence,
    interpretation:
      '前后同一探针、各三轮交替顺序；内存取每轮 P95 的中位数。RSS、PSS 与容器实际内存分开。CPU 单位为一个逻辑核的百分比，包含采样开销；延迟包含真实 UI 操作。外部主机负载必须一并评估，不据此自动承诺稳定容量。',
  };
  return summary;
}

if (require.main === module) {
  assert(process.argv[2], '请提供完整对照结果目录');
  const root = path.resolve(process.argv[2]);
  const summary = summarizeComparison(root);
  fs.writeFileSync(path.join(root, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify({ functionalPass: true, changes: summary.changes }, null, 2)}\n`);
}

module.exports = { summarizeComparison };
