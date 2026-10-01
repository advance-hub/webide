import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { collectProcessTreeMemory } from '@opensumi/ide-dev-tool/diagnostics/process-tree';

async function main() {
  const [url, outputArgument, log] = process.argv.slice(2);
  const origin = new URL(url);
  assert(['127.0.0.1', 'localhost'].includes(origin.hostname), 'Acceptance server must be a local isolated fixture');
  const state = await (await fetch(new URL('/readyz', origin))).json();
  assert.equal(state.runtime.workspace.id, 'active-browser-fixture');
  assert(state.runtime.workspace.directory.includes('/webide-active-browser-'), 'Never signal a user IDE');
  const before = await collectProcessTreeMemory(state.runtime.pid);
  assert.equal(before.byRole['watcher-host']?.count, 1);
  assert((before.byRole['extension-host']?.count || 0) >= 1);
  assert((before.byRole['terminal-shell']?.count || 0) >= 1);
  const started = Date.now();
  process.kill(state.runtime.pid, 'SIGTERM');
  const live = (pid: number) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  while (before.processes.some((process) => live(process.pid)) && Date.now() - started < 35000) {
    await delay(100);
  }
  const remaining = before.processes.filter((process) => live(process.pid));
  const text = await readFile(log, 'utf8');
  const report = JSON.parse(
    text
      .split('\n')
      .find((line) => line.startsWith('OpenSumi server shutdown: '))!
      .slice('OpenSumi server shutdown: '.length),
  );
  const result = {
    platform: process.platform,
    node: process.version,
    before,
    report,
    remaining,
    elapsedMs: Date.now() - started,
    pass:
      remaining.length === 0 &&
      !report.timedOut &&
      report.phases.length === 4 &&
      report.phases.every((phase: { status: string }) => phase.status === 'completed'),
  };
  const output = path.resolve(outputArgument);
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  assert(result.pass, 'Report completion and every sampled process must both pass while the browser stays open');
  process.stdout.write(
    JSON.stringify({
      pass: result.pass,
      processes: before.processCount,
      activeConnections: report.activeConnections,
      elapsedMs: result.elapsedMs,
    }) + '\n',
  );
}
main().catch((error) => {
  process.stderr.write(String(error.stack || error) + '\n');
  process.exitCode = 1;
});
