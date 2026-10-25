import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { resolveProductRuntimeMode } from '@opensumi/ide-startup/runtime-mode';

import { assertMemoryHeadroom } from './fn/memory.ts';
import { buildArtifacts, inspectArtifacts } from './runtime-artifacts.ts';

import type { ArtifactRecipe } from './runtime-artifacts.ts';
import type { ProductRuntimeMode } from '@opensumi/ide-startup/runtime-mode';

const repoRoot = path.resolve(import.meta.dirname, '..');
const generatedPreload = 'packages/webview/src/browser/iframe/prebuilt.ts';

export function runtimeRecipes(root: string, mode: ProductRuntimeMode): ArtifactRecipe[] {
  const require = createRequire(path.join(root, 'package.json'));
  const packages = readdirSync(path.join(root, 'packages'))
    .filter((name) => existsSync(path.join(root, 'packages', name, 'package.json')))
    .sort()
    .map((name) => `packages/${name}`);
  const inputs = packages.flatMap((directory) => [
    `${directory}/src`,
    `${directory}/proto`,
    `${directory}/package.json`,
    ...readdirSync(path.join(root, directory))
      .filter((file) => /^(?:rspack|tsconfig).*\.(?:js|json|ts)$/.test(file))
      .map((file) => `${directory}/${file}`),
  ]);
  const version = (name: string) => (require(`${name}/package.json`) as { version: string }).version;
  const javascript: ArtifactRecipe = {
    id: 'javascript',
    inputs: [
      ...inputs,
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      'patches',
      'tsconfig.json',
      'typings',
      'configs/ts',
      'scripts',
      'tools/dev-tool/src',
      'tools/dev-tool/cli',
      'tools/dev-tool/package.json',
      'tools/playwright/src',
      'packages/core-electron-main/browser-preload',
      'packages/startup/bootstrap',
      'packages/webview/scripts',
      'server/src',
      'server/package.json',
      'server/tsconfig.json',
      'server/tsconfig.build.json',
    ],
    excludeInputs: [generatedPreload],
    outputs: [
      ...packages.map((directory) => `${directory}/lib`),
      'tools/playwright/lib',
      'tools/dev-tool/lib',
      'packages/components/dist',
      'packages/monaco/worker',
      'server/dist',
      generatedPreload,
    ],
    requiredOutputs: [
      ...packages.flatMap((directory) => {
        const manifest = JSON.parse(readFileSync(path.join(root, directory, 'package.json'), 'utf8')) as {
          main?: string;
        };
        return manifest.main?.startsWith('lib/') ? [`${directory}/${manifest.main}`] : [];
      }),
      'packages/extension/lib/worker-host.js',
      'packages/extension/lib/hosted/ext.process.js',
      'packages/file-service/lib/node/hosted/watcher.process.js',
      'tools/dev-tool/lib/server.js',
      'tools/dev-tool/lib/ext-host.js',
      'tools/dev-tool/lib/mock-log-service.js',
      'tools/dev-tool/lib/mock-injector.js',
      'tools/dev-tool/lib/rspack.js',
      'tools/dev-tool/lib/asset-manifest.js',
      'tools/dev-tool/lib/index.html',
      'packages/components/dist/index.css',
      'packages/monaco/worker/editor.worker.bundle.js',
      'packages/monaco/worker/manifest.json',
      'server/dist/main.js',
      generatedPreload,
    ],
    toolchain: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      typescript: version('@typescript/native'),
      typescriptAPI: version('typescript-api'),
      rspack: version('@rspack/core'),
      tsx: version('tsx'),
      esbuild: version('esbuild'),
    },
    commands: [
      'build:webview-prebuilt',
      'build',
      'build:worker-host',
      'build:ext-host',
      'build:watcher-host',
      'build:components',
      'build:monaco-worker',
      'build:server',
    ].map((name) => ['run', name]),
  };
  const clients: ArtifactRecipe = {
    id: 'clients',
    inputs: [
      ...inputs,
      'client/src',
      'client/package.json',
      'client/rspack.config.ts',
      'client/tsconfig.rspack.json',
      'application/src',
      'application/shared',
      'application/runtime',
      'application/server',
      'application/package.json',
      'application/rspack.config.ts',
      'application/tsconfig.json',
      'tools/dev-tool/src/index.html',
      'configs/ts',
      'package.json',
      'pnpm-lock.yaml',
      'patches',
    ],
    outputs: ['client/dist', 'application/dist', 'application/server/main.mjs'],
    excludeInputs: ['application/server/main.mjs'],
    requiredOutputs: [
      'client/dist/index.html',
      'client/dist/monaco/editor.worker.bundle.js',
      'application/dist/index.html',
      'application/server/main.mjs',
    ],
    toolchain: {
      node: process.version,
      typescript: version('@typescript/native'),
      rspack: version('@rspack/core'),
    },
    commands: [
      ['run', 'build:client'],
      ['run', 'build:application'],
    ],
  };
  return [javascript, clients];
}

async function runCommands(root: string, commands: string[][]): Promise<void> {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: 'production',
    NODE_OPTIONS: '--max-old-space-size=768',
    OPENSUMI_BUILD_FORCE: '1',
  };
  delete environment.OPENSUMI_BUILD_FROM;
  for (const args of commands) {
    assertMemoryHeadroom(`Runtime build: pnpm ${args.join(' ')}`, {
      minimumFreeMemoryMb: 1024,
      minimumFreeMemoryPercent: 20,
    });
    await new Promise<void>((resolve, reject) => {
      // 使用已经安装的包管理器，执行命令时不触发依赖安装。
      const child = spawn(path.join(root, 'node_modules/pnpm/pnpm'), args, {
        cwd: root,
        env: environment,
        stdio: 'inherit',
        shell: process.platform === 'win32',
        detached: process.platform !== 'win32',
      });
      let interrupted = false;
      let stopped: Promise<void> | undefined;
      const signalTree = (signal: NodeJS.Signals) => {
        if (!child.pid) {
          return;
        }
        try {
          if (process.platform === 'win32') {
            child.kill(signal);
          } else {
            process.kill(-child.pid, signal);
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
            throw error;
          }
        }
      };
      const interrupt = () => {
        interrupted = true;
        signalTree('SIGTERM');
        stopped ||= new Promise((done) =>
          setTimeout(() => {
            signalTree('SIGKILL');
            done();
          }, 3_000),
        );
      };
      const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
      signals.forEach((signal) => process.on(signal, interrupt));
      const cleanup = () => signals.forEach((signal) => process.off(signal, interrupt));
      child.once('error', (error) => {
        cleanup();
        reject(error);
      });
      child.once('exit', async (code, signal) => {
        await stopped;
        cleanup();
        if (code === 0 && !interrupted) {
          resolve();
        } else {
          reject(new Error(`pnpm ${args.join(' ')} failed (${interrupted ? 'interrupted' : signal || code})`));
        }
      });
    });
  }
}

function acquireBuildLock(root: string): () => void {
  const lock = path.join(root, '.cache/runtime-artifacts/build.lock');
  mkdirSync(path.dirname(lock), { recursive: true });
  if (existsSync(lock)) {
    const owner = Number(readFileSync(lock, 'utf8'));
    let alive = true;
    if (Number.isSafeInteger(owner) && owner > 0) {
      try {
        process.kill(owner, 0);
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
      }
    }
    if (alive) {
      throw new Error(`A runtime build is already running (pid ${owner || 'unknown'}); wait for it to finish`);
    }
    rmSync(lock);
  }
  writeFileSync(lock, String(process.pid), { flag: 'wx' });
  return () => rmSync(lock, { force: true });
}

export async function ensureRuntimeArtifacts(
  options: {
    root?: string;
    mode?: ProductRuntimeMode;
    checkOnly?: boolean;
    force?: boolean;
  } = {},
): Promise<void> {
  const root = options.root || repoRoot;
  const mode = options.mode || resolveProductRuntimeMode(process.env);
  const release = options.checkOnly ? () => {} : acquireBuildLock(root);
  try {
    for (const recipe of runtimeRecipes(root, mode)) {
      const status = inspectArtifacts(root, recipe);
      if (status.fresh && !options.force) {
        process.stdout.write(`[artifacts] ${recipe.id}: ${status.reason}\n`);
        continue;
      }
      if (options.checkOnly) {
        throw new Error(`${recipe.id}: ${status.reason}; run pnpm build:all`);
      }
      process.stdout.write(
        `[artifacts] rebuilding ${recipe.id}: ${options.force ? 'requested clean build' : status.reason}\n`,
      );
      await buildArtifacts(root, recipe, async (commands) => {
        // 同时删除退役源码的产物；仅依赖编译器增量缓存
        // 无法证明 lib/ 中已经不存在被删除源码的旧输出。
        for (const output of recipe.outputs) {
          if (output !== generatedPreload) {
            rmSync(path.join(root, output), { recursive: true, force: true });
          }
        }
        await runCommands(root, commands);
      });
    }
  } finally {
    release();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const args = process.argv.slice(2).filter((argument) => argument !== '--');
  const unknown = args.filter((argument) => !['--check', '--force'].includes(argument));
  if (unknown.length) {
    throw new Error(`Unknown runtime build options: ${unknown.join(', ')}`);
  }
  void ensureRuntimeArtifacts({ checkOnly: args.includes('--check'), force: args.includes('--force') }).catch(
    (error) => {
      process.stderr.write(`[artifacts] ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    },
  );
}
