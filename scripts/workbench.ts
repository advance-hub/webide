import { type ChildProcess, spawn } from 'node:child_process';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { ensureRuntimeArtifacts } from './build-runtime.ts';

const root = path.resolve(import.meta.dirname, '..');
const development = process.argv.includes('--dev');
const unknown = process.argv.slice(2).filter((argument) => argument !== '--dev');
if (unknown.length) {
  throw new Error(`Unknown workbench options: ${unknown.join(', ')}`);
}
if (Number(process.versions.node.split('.')[0]) !== 24) {
  throw new Error('The workbench requires Node.js 24');
}

await ensureRuntimeArtifacts({ root });

const children: ChildProcess[] = [];
let stopping = false;
const exited = (child: ChildProcess) => child.exitCode !== null || child.signalCode !== null;
function signal(child: ChildProcess, value: NodeJS.Signals): void {
  if (!child.pid || exited(child)) {
    return;
  }
  try {
    process.kill(process.platform === 'win32' ? child.pid : -child.pid, value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
      throw error;
    }
  }
}
async function shutdown(code = 0): Promise<void> {
  if (stopping) {
    return;
  }
  stopping = true;
  process.exitCode = code;
  children.forEach((child) => signal(child, 'SIGTERM'));
  const deadline = Date.now() + 15000;
  while (children.some((child) => !exited(child)) && Date.now() < deadline) {
    await delay(100);
  }
  children.forEach((child) => signal(child, 'SIGKILL'));
}
function start(args: string[]): void {
  const child = spawn(path.join(root, 'node_modules/pnpm/pnpm'), args, {
    cwd: root,
    stdio: 'inherit',
    detached: process.platform !== 'win32',
    env: { ...process.env, OPENSUMI_RUNTIME_MODE: 'node', WORKBENCH_DEV: development ? '1' : '0' },
  });
  children.push(child);
  child.once('error', (error) => {
    process.stderr.write(`${error.message}\n`);
    void shutdown(1);
  });
  child.once('exit', (code) => {
    if (!stopping) {
      void shutdown(code || 0);
    }
  });
}
for (const value of ['SIGINT', 'SIGTERM'] as const) {
  process.once(value, () => {
    void shutdown();
  });
}
start(['--filter', '@opensumi/application', development ? 'dev' : 'start']);
if (development) {
  start(['--filter', '@opensumi/application', 'dev:client']);
  process.stdout.write('Workbench development UI: http://127.0.0.1:8792\n');
}
