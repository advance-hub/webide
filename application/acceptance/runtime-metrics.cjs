'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** 同时记录进程树与容器计数器；不可读取的 PSS 保持缺失，不冒充零占用。 */
function readRuntimeMetrics(procRoot = '/proc', cgroupRoot = '/sys/fs/cgroup') {
  const read = (root, file) => fs.readFileSync(path.join(root, file), 'utf8');
  const counters = (text) =>
    Object.fromEntries(
      text
        .trim()
        .split('\n')
        .map((line) => {
          const [key, value] = line.trim().split(/\s+/);
          return [key, Number(value)];
        }),
    );
  const processes = [];
  for (const name of fs.readdirSync(procRoot).filter((item) => /^\d+$/.test(item))) {
    const directory = path.join(procRoot, name);
    try {
      const status = read(directory, 'status');
      let pssKiB = null;
      try {
        const match = read(directory, 'smaps_rollup').match(/^Pss:\s+(\d+)/m);
        if (match) pssKiB = Number(match[1]);
      } catch {
        // 进程退出或权限不足时，RSS 仍可记录，PSS 明确标记为未知。
      }
      processes.push({
        pid: Number(name),
        ppid: Number(status.match(/^PPid:\s+(\d+)/m)[1]),
        rssKiB: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] || 0),
        pssKiB,
        command: read(directory, 'cmdline').split('\0').join(' ').slice(0, 400),
      });
    } catch {
      // /proc 是动态视图，读取期间已经退出的进程不属于完整快照。
    }
  }
  let container;
  try {
    const memory = counters(read(cgroupRoot, 'memory.stat'));
    const cpu = counters(read(cgroupRoot, 'cpu.stat'));
    const events = counters(read(cgroupRoot, 'memory.events'));
    const maximum = read(cgroupRoot, 'memory.max').trim();
    container = {
      available: true,
      timestamp: Date.now(),
      uptimeSeconds: Number(read(procRoot, 'uptime').split(/\s+/)[0]),
      memoryCurrentBytes: Number(read(cgroupRoot, 'memory.current')),
      memoryPeakBytes: Number(read(cgroupRoot, 'memory.peak')),
      memoryMaxBytes: maximum === 'max' ? null : Number(maximum),
      fileCacheBytes: memory.file,
      cpuUsageUsec: cpu.usage_usec,
      cpuThrottledUsec: cpu.throttled_usec,
      oomKills: events.oom_kill,
      oomEvents: events.oom,
    };
  } catch (error) {
    container = { available: false, error: error.message };
  }
  return { processes, container };
}

module.exports = readRuntimeMetrics;
