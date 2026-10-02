import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { build } from 'esbuild';

interface Measurement {
  scenario: string;
  heapDeltaBytes: number;
  rssDeltaBytes: number;
  entries?: number;
  fileBytes?: number;
  resultCharacters?: number;
}
const root = path.resolve(import.meta.dirname, '..');
const run = promisify(execFile);
const sample = () => {
  if (!global.gc) {
    throw new Error('测量子进程必须使用 --expose-gc');
  }
  global.gc();
  return process.memoryUsage();
};

async function worker(directory: string, scenario: string, log: string): Promise<void> {
  let result: Measurement;
  if (scenario === 'tickets') {
    const { IDEProxy } = await import(pathToFileURL(path.join(directory, 'ide-proxy.mjs')).href);
    const proxy = new IDEProxy({ publicURL: 'http://127.0.0.1:8790', ideHost: 'localhost' }, {}, {}, {});
    const original = Date.now;
    let clock = original();
    Date.now = () => clock;
    const before = sample();
    try {
      // 十批各 5000 个票据，批次之间推进时钟；测量的是过期后的保留量。
      for (let wave = 0; wave < 10; wave++) {
        for (let index = 0; index < 5000; index++) {
          proxy.enter({ id: 'a'.repeat(32), owner: 'memory-fixture' });
        }
        clock += 61_000;
      }
      proxy.enter({ id: 'a'.repeat(32), owner: 'memory-fixture' });
      const after = sample();
      result = {
        scenario,
        entries: proxy.tickets.size,
        heapDeltaBytes: after.heapUsed - before.heapUsed,
        rssDeltaBytes: after.rss - before.rss,
      };
    } finally {
      Date.now = original;
      proxy.dispose();
    }
  } else {
    const { readTextTail } = await import(pathToFileURL(path.join(directory, 'text-tail.mjs')).href);
    const before = sample();
    const text = await readTextTail(log);
    const after = sample();
    result = {
      scenario,
      fileBytes: (await stat(log)).size,
      resultCharacters: text.length,
      heapDeltaBytes: after.heapUsed - before.heapUsed,
      rssDeltaBytes: after.rss - before.rss,
    };
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function profile(): Promise<void> {
  const args = process.argv.slice(2);
  const option = (name: string) => args[args.indexOf(name) + 1];
  const baseline = args.includes('--baseline') && option('--baseline');
  if (!baseline || args.some((value, index) => index % 2 === 0 && !['--baseline', '--output'].includes(value))) {
    throw new Error('用法：profile:control-plane-memory --baseline <Git 提交> [--output <JSON 文件>]');
  }
  const revision = execFileSync('git', ['rev-parse', '--verify', `${baseline}^{commit}`], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  const source = (file: string) =>
    execFileSync('git', ['show', `${revision}:${file}`], { cwd: root, encoding: 'utf8' });
  const previousProxy = source('application/server/http/ide-proxy.ts');
  const previousRuntime = source('application/server/runtime/local.ts');
  if (!previousRuntime.includes("(await readFile(log, 'utf8')).slice(-4000)")) {
    throw new Error('基线不包含整文件读取后截取日志的实现，不能用该提交进行本实验');
  }
  const output = path.resolve(
    root,
    args.includes('--output') ? option('--output') : 'output/runtime-profiles/control-plane-memory.json',
  );
  await mkdir(path.join(root, '.tmp'), { recursive: true });
  const temporary = await mkdtemp(path.join(root, '.tmp/memory-'));
  try {
    const compile = async (directory: string, name: string, contents: string, sourcefile: string) => {
      await build({
        stdin: { contents, resolveDir: path.dirname(path.join(root, sourcefile)), sourcefile, loader: 'ts' },
        outfile: path.join(temporary, directory, `${name}.mjs`),
        bundle: true,
        platform: 'node',
        format: 'esm',
        packages: 'external',
      });
    };
    await compile('before', 'ide-proxy', previousProxy, 'application/server/http/ide-proxy.ts');
    await compile(
      'after',
      'ide-proxy',
      await readFile(path.join(root, 'application/server/http/ide-proxy.ts'), 'utf8'),
      'application/server/http/ide-proxy.ts',
    );
    await compile(
      'before',
      'text-tail',
      "import { readFile } from 'node:fs/promises'; export async function readTextTail(file) { return (await readFile(file, 'utf8')).slice(-4000); }",
      'application/server/platform/text-tail.ts',
    );
    await compile(
      'after',
      'text-tail',
      await readFile(path.join(root, 'application/server/platform/text-tail.ts'), 'utf8'),
      'application/server/platform/text-tail.ts',
    );
    const log = path.join(temporary, 'ide.log');
    const handle = await open(log, 'wx');
    try {
      const chunk = Buffer.alloc(1024 * 1024, 97);
      for (let index = 0; index < 64; index++) {
        await handle.writeFile(chunk);
      }
    } finally {
      await handle.close();
    }
    const measurements: { round: number; version: string; result: Measurement }[] = [];
    for (let round = 1; round <= 3; round++) {
      for (const version of round % 2 ? ['before', 'after'] : ['after', 'before']) {
        for (const scenario of ['tickets', 'log-tail']) {
          const { stdout } = await run(
            process.execPath,
            [
              '--expose-gc',
              '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
              path.join(root, 'scripts/profile-control-plane-memory.ts'),
              '--worker',
              path.join(temporary, version),
              scenario,
              log,
            ],
            { cwd: root, timeout: 60_000 },
          );
          measurements.push({ round, version, result: JSON.parse(stdout) as Measurement });
        }
      }
    }
    const report = {
      schemaVersion: 1,
      baselineRevision: revision,
      baselineProxySHA256: createHash('sha256').update(previousProxy).digest('hex'),
      node: process.version,
      platform: process.platform,
      architecture: process.arch,
      loadAtEnd: os.loadavg(),
      scope: '隔离子进程内过期票据与大日志尾部的受控对照；显式 GC，时钟推进；不代表整棵 IDE 性能',
      measurements,
    };
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${output}\n`);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[2] === '--worker') {
  await worker(process.argv[3], process.argv[4], process.argv[5]);
} else {
  await profile();
}
