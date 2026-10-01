'use strict';
const fs = require('node:fs'),
  path = require('node:path'),
  { spawnSync } = require('node:child_process');
const root = path.resolve(process.argv[2]);
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
    for (const pid of fs.readdirSync('/proc').filter((p) => /^\d+$/.test(p))) {
      try {
        const args = fs.readFileSync('/proc/' + pid + '/cmdline', 'utf8');
        if (/org\.codehaus\.plexus\.classworlds|maven-wrapper/.test(args))
          throw new Error('检测到终端 Maven 进程，请构建结束后再清理缓存');
      } catch (e) {
        if (!e.code) throw e;
      }
    }
    const cache = '/workspace/home/.m2/repository';
    fs.rmSync(cache, { recursive: true, force: true });
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  } else if (input.action === 'finish-restore') {
    fs.rmSync('/workspace/.clouddev-restore-previous', { recursive: true, force: true });
  } else if (input.action !== 'inspect') throw new Error('未知开发机操作');
  const stat = fs.statfsSync('/workspace');
  process.stdout.write(
    JSON.stringify({
      diskTotal: stat.blocks * stat.bsize,
      diskFree: stat.bavail * stat.bsize,
      workspaceBytes: size('/workspace'),
      mavenCacheBytes: size('/workspace/home/.m2/repository'),
      memoryUsed: bytes('/sys/fs/cgroup/memory.current') || bytes('/sys/fs/cgroup/memory/memory.usage_in_bytes'),
      memoryLimit: bytes('/sys/fs/cgroup/memory.max') || bytes('/sys/fs/cgroup/memory/memory.limit_in_bytes'),
    }),
  );
} catch (e) {
  process.stdout.write(JSON.stringify({ error: e.message }));
  process.exitCode = 1;
}
