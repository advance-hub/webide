// Stop only the acknowledged IDE process and its descendants. Process start
// times prevent a recycled PID from targeting an unrelated workload.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(process.argv[2] || '/workspace');
const pidFile = path.join(root, '.platform', 'ide.pid');
const read = (file) => {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};
const identity = (pid) => {
  const stat = read(`/proc/${pid}/stat`);
  const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
  return fields[0] === 'Z' ? '' : fields[19] || '';
};
async function main() {
  const pid = Number(read(pidFile).trim());
  if (!Number.isSafeInteger(pid) || pid < 2 || !read(`/proc/${pid}/cmdline`).includes('server/dist/main.js')) return;
  // A sandbox restart resets PID allocation while the PID files survive.
  // All IDEs run the same entrypoint, so its name alone cannot prove ownership.
  // Check the process's original workspace before signalling any descendants.
  const environment = Object.fromEntries(
    read(`/proc/${pid}/environ`)
      .split('\0')
      .filter(Boolean)
      .map((entry) => {
        const separator = entry.indexOf('=');
        return [entry.slice(0, separator), entry.slice(separator + 1)];
      }),
  );
  if (environment.WORKSPACE_DIR !== path.join(root, 'project')) return;
  const parents = new Map();
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    const stat = read(`/proc/${entry}/stat`);
    parents.set(Number(entry), Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]));
  }
  const targets = new Map([[pid, identity(pid)]]);
  for (let changed = true; changed;) {
    changed = false;
    for (const [child, parent] of parents)
      if (targets.has(parent) && !targets.has(child)) {
        targets.set(child, identity(child));
        changed = true;
      }
  }
  const signal = (value) => {
    for (const [child, start] of [...targets].reverse())
      if (start && identity(child) === start) {
        try {
          process.kill(child, value);
        } catch (error) {
          if (error.code !== 'ESRCH') throw error;
        }
      }
  };
  signal('SIGTERM');
  const deadline = Date.now() + 3000;
  while ([...targets].some(([child, start]) => start && identity(child) === start) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  signal('SIGKILL');
  if (Number(read(pidFile).trim()) === pid) fs.rmSync(pidFile, { force: true });
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
