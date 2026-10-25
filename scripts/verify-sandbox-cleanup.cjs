'use strict';
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');

const [runName, volume, output, ...images] = process.argv.slice(2);
if (!/^webide-acceptance-[a-f0-9]{12}$/.test(runName || '')) throw new Error('拒绝检查非本轮资源');
const inspect = (args) => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000 }).trim();
const result = { runName, timestamp: new Date().toISOString(), pass: false };
try {
  inspect(['info', '--format', '{{.ServerVersion}}']);
  result.containers = inspect(['ps', '-a', '--filter', `name=^/${runName}$`, '--format', '{{.Names}}']);
  result.volumes = inspect(['volume', 'ls', '--filter', `name=^${volume}$`, '--format', '{{.Name}}']);
  result.networks = inspect(['network', 'ls', '--filter', `name=^${runName}$`, '--format', '{{.Name}}']);
  result.contextPresent = inspect(['context', 'ls', '--format', '{{.Name}}']).split('\n').includes(runName);
  result.temporaryImages = images.filter((image) =>
    inspect(['image', 'ls', '--filter', `reference=${image}`, '--format', '{{.ID}}']),
  );
  result.pass =
    !result.containers &&
    !result.volumes &&
    !result.networks &&
    !result.contextPresent &&
    result.temporaryImages.length === 0;
} catch (error) {
  // daemon 不可访问时不能把查询失败解释为资源已经不存在。
  result.error = error.message;
}
fs.writeFileSync(output, `${JSON.stringify(result, null, 2)}\n`);
if (!result.pass) process.exitCode = 1;
