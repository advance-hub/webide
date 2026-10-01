'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  os = require('node:os'),
  { spawnSync } = require('node:child_process');
const root = path.resolve(process.argv[2]);
const machineHome = path.resolve(process.env.WORKBENCH_MACHINE_HOME || '/workspace/home');
const machineRoot = path.dirname(machineHome);
const cache = path.join(machineHome, '.m2/repository');
const input = JSON.parse(
  process.argv[3].startsWith('@')
    ? fs.readFileSync(process.argv[3].slice(1), 'utf8')
    : Buffer.from(process.argv[3], 'base64').toString(),
);
const bytes = (file) => {
  try {
    const n = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
};
const size = (dir) => {
  if (!fs.existsSync(dir)) return 0;
  const r = spawnSync('du', ['-sk', dir], { encoding: 'utf8', timeout: 15000 });
  return r.status === 0 ? Number(r.stdout.split(/\s+/)[0]) * 1024 : null;
};
try {
  if (input.action === 'clean-cache') {
    // Protect Maven started manually in a terminal as well as platform jobs.
    let argumentsText;
    if (process.platform === 'linux') {
      argumentsText = fs
        .readdirSync('/proc')
        .filter((p) => /^\d+$/.test(p))
        .map((pid) => {
          try {
            return fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8');
          } catch {
            return '';
          }
        })
        .join('\n');
    } else {
      const result =
        process.platform === 'win32'
          ? spawnSync(
              'powershell.exe',
              ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object -ExpandProperty CommandLine'],
              { encoding: 'utf8', timeout: 15000 },
            )
          : spawnSync('ps', ['-ax', '-o', 'command='], { encoding: 'utf8', timeout: 15000 });
      if (result.status !== 0) throw new Error('无法确认手动 Maven 进程，暂不清理缓存');
      argumentsText = result.stdout;
    }
    if (/org\.codehaus\.plexus\.classworlds|maven-wrapper/.test(argumentsText))
      throw new Error('检测到终端 Maven 进程，请构建结束后再清理缓存');
    fs.rmSync(cache, { recursive: true, force: true });
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  } else if (input.action !== 'inspect') throw new Error('未知开发机操作');
  const stat = fs.statfsSync(machineRoot);
  process.stdout.write(
    JSON.stringify({
      diskTotal: stat.blocks * stat.bsize,
      diskFree: stat.bavail * stat.bsize,
      workspaceBytes: size(machineRoot),
      mavenCacheBytes: size(cache),
      memoryUsed:
        bytes('/sys/fs/cgroup/memory.current') ||
        bytes('/sys/fs/cgroup/memory/memory.usage_in_bytes') ||
        os.totalmem() - os.freemem(),
      memoryLimit:
        bytes('/sys/fs/cgroup/memory.max') || bytes('/sys/fs/cgroup/memory/memory.limit_in_bytes') || os.totalmem(),
    }),
  );
} catch (e) {
  process.stdout.write(JSON.stringify({ error: e.message }));
  process.exitCode = 1;
}
