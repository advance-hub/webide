import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { Injector } from '@opensumi/di';
import { FileChangeType, ILogServiceManager, URI } from '@opensumi/ide-core-common';
import { RecursiveWatcherBackend } from '@opensumi/ide-core-common/file-watch';
import { collectProcessTreeMemory } from '@opensumi/ide-dev-tool/diagnostics/process-tree';
import { percentile } from '@opensumi/ide-dev-tool/diagnostics/runtime-profile-metrics';
import { FileServiceModule } from '@opensumi/ide-file-service/node';

import { AppConfig } from '../packages/core-node/src/types';

import type { FileSystemWatcherClient } from '@opensumi/ide-core-common/file-watch';

// Internal implementations are exercised through the module's registered DI tokens.
const watcherToken = (
  new FileServiceModule().providers.find(
    (provider) =>
      typeof provider === 'object' && 'token' in provider && String(provider.token) === 'Symbol(WatcherProcessManager)',
  ) as { token: symbol }
).token;
const poolToken = (
  new FileServiceModule().providers.find(
    (provider) =>
      typeof provider === 'object' && 'token' in provider && String(provider.token) === 'Symbol(SharedNodeWatcherPool)',
  ) as { token: symbol }
).token;

async function main() {
  const [variant, workspaceArgument, outputArgument, sessionsText = '5', backendText = 'parcel', crashMode] =
    process.argv.slice(2);
  const workspace = workspaceArgument && path.resolve(workspaceArgument);
  const outputDirectory = outputArgument && path.resolve(outputArgument);
  if (
    !['node', 'shared-node'].includes(variant) ||
    !['parcel', 'default'].includes(backendText) ||
    !workspace?.includes('/snapshots/') ||
    !outputDirectory
  ) {
    throw new Error(
      'Expected <node|shared-node> <isolated /snapshots/ workspace with README.md> <output directory> [sessions] [parcel|default]',
    );
  }
  const sessions = Number(sessionsText);
  assert(Number.isSafeInteger(sessions) && sessions >= 2);
  await mkdir(outputDirectory, { recursive: true });
  const probe = await mkdtemp(path.join(workspace, '.watch-sharing-'));
  // Use an established repository file for save notifications. Native macOS
  // backends can retain Created flags for a newly created fixture under load.
  const existingFile = path.join(workspace, 'README.md');
  const originalContents = await readFile(existingFile);
  const events = Array.from({ length: sessions }, () => [] as Array<{ uri: string; type: FileChangeType }>);
  const failures: unknown[] = [];
  const rescans: unknown[] = [];
  const samples: Awaited<ReturnType<typeof collectProcessTreeMemory>>[] = [];
  const steps: Array<{ name: string; elapsedMs: number }> = [];
  const started = Date.now();
  const originalEnv = { ...process.env };
  // The harness runs through tsx, but production watcher hosts execute emitted
  // JavaScript. Avoid counting one inherited tsx loader per Node host.
  const inheritedExecArgv = process.execArgv.splice(0);
  Object.assign(process.env, {
    OPENSUMI_RUNTIME_MODE: 'node',
    OPENSUMI_NODE_WATCHER_MODE: variant === 'shared-node' ? 'shared' : 'per-client',
  });
  const logger = { log() {}, debug() {}, error() {}, warn() {}, verbose() {}, critical() {} };
  const injector = new Injector();
  injector.addProviders(
    ...new FileServiceModule().providers,
    {
      token: AppConfig,
      useValue: {
        logDir: path.join(outputDirectory, 'logs'),
        logLevel: 3,
        watcherHost: path.resolve(import.meta.dirname, '../packages/file-service/lib/node/hosted/watcher.process.js'),
        watcherHostForkOptions: { execArgv: ['--max-old-space-size=256'] },
      },
    },
    { token: ILogServiceManager, useValue: { getLogger: () => logger } },
  );
  interface Manager {
    setClient(client: FileSystemWatcherClient): void;
    createProcess(id: string, backend?: RecursiveWatcherBackend): Promise<number>;
    whenReady: Promise<void>;
    watch(uri: object, options?: object): Promise<number>;
    unWatch(id: number): Promise<void>;
    setWatcherFileExcludes(excludes: string[]): Promise<void>;
    dispose(): Promise<void>;
  }
  const managers = Array.from({ length: sessions }, (_, index) => {
    const manager = injector.get(watcherToken) as Manager;
    manager.setClient({
      onDidFilesChanged: (event) => events[index].push(...event.changes),
      onWatcherFailed: (event) => failures.push(event),
      onWatcherOverflow: (event) => (crashMode === 'crash' ? rescans : failures).push(event),
    });
    return manager;
  });
  const watchIds: number[] = [];
  const result: Record<string, unknown> = {
    variant,
    sessions,
    workspace,
    nodeVersion: process.version,
    platform: process.platform,
    backend: backendText,
    sampleScope: 'Real watcher processes and parent DI/RPC harness; excludes IDE extensions and Chromium',
    loadAtStart: os.loadavg(),
    samples,
    steps,
    failures,
    rescans,
    functionalPass: false,
    lifecyclePass: false,
  };
  async function until(test: () => boolean, label: string) {
    const deadline = Date.now() + 20_000;
    while (!test() && Date.now() < deadline) {
      await delay(50);
    }
    assert(test(), label);
    assert.equal(failures.length, 0, 'No watcher failures or fallback');
  }
  async function mutate(
    name: string,
    file: string,
    type: FileChangeType,
    action: () => Promise<unknown>,
    recipients: number[],
  ) {
    // macOS FSEvents coalesces operations across a delivery window. Keep the
    // steady-state mutation probes separate; burst behavior is a distinct test.
    await delay(500);
    events.forEach((entry) => entry.splice(0));
    const uri = URI.file(file).toString();
    const start = Date.now();
    await action();
    await until(
      () => recipients.every((index) => events[index].some((event) => event.uri === uri && event.type === type)),
      name,
    );
    steps.push({ name, elapsedMs: Date.now() - start });
  }
  try {
    await Promise.all(
      managers.map(async (manager, index) => {
        await manager.createProcess(
          `sharing-probe-${index}`,
          backendText === 'parcel' ? RecursiveWatcherBackend.PARCEL : undefined,
        );
        await manager.whenReady;
        await manager.setWatcherFileExcludes(['**/node_modules/**', '**/.git/**']);
        watchIds[index] = await manager.watch(URI.file(workspace).codeUri, { recursive: true });
      }),
    );
    await delay(5_000);
    for (let index = 0; index < 8; index++) {
      const sample = await collectProcessTreeMemory(process.pid);
      const watchers = sample.byRole['watcher-host']?.count || 0;
      assert.equal(watchers, variant === 'node' ? sessions : 1);
      samples.push(sample);
      await delay(500);
    }
    const role = 'watcher-host';
    result.watcherP95MiB =
      percentile(
        samples.map((sample) => sample.byRole[role]?.rssBytes || 0),
        0.95,
      ) / 1048576;
    result.treeP95MiB =
      percentile(
        samples.map((sample) => sample.totalRssBytes),
        0.95,
      ) / 1048576;
    const all = managers.map((_, index) => index);
    const file = path.join(probe, 'event.ts');
    await mutate(
      'create-all-clients',
      file,
      FileChangeType.ADDED,
      () => writeFile(file, 'export const value = 1;\n'),
      all,
    );
    await mutate(
      'modify-all-clients',
      existingFile,
      FileChangeType.UPDATED,
      () => writeFile(existingFile, Buffer.concat([originalContents, Buffer.from('\n<!-- watcher save probe -->\n')])),
      all,
    );
    const renamed = path.join(probe, 'renamed.ts');
    await mutate('rename-all-clients', renamed, FileChangeType.ADDED, () => rename(file, renamed), all);
    await mutate('delete-all-clients', renamed, FileChangeType.DELETED, () => rm(renamed), all);

    await managers[0].setWatcherFileExcludes(['**/node_modules/**', '**/.git/**', '**/ignored/**']);
    const ignored = path.join(probe, 'ignored', 'event.ts');
    await mkdir(path.dirname(ignored), { recursive: true });
    await mutate(
      'per-client-exclusions',
      ignored,
      FileChangeType.ADDED,
      () => writeFile(ignored, 'ignored only by client zero'),
      all.slice(1),
    );
    await delay(1_000);
    assert(
      !events[0].some((event) => event.uri === URI.file(ignored).toString()),
      'Exclusion changes remain local to one client',
    );

    const privateRoots = [path.join(probe, 'one'), path.join(probe, 'two')];
    await Promise.all(privateRoots.map((directory) => mkdir(directory)));
    for (let index = 0; index < 2; index++) {
      await managers[index].unWatch(watchIds[index]);
      watchIds[index] = await managers[index].watch(URI.file(privateRoots[index]).codeUri, { recursive: true });
    }
    const privateFile = path.join(privateRoots[0], 'private.ts');
    await mutate(
      'path-isolation',
      privateFile,
      FileChangeType.ADDED,
      () => writeFile(privateFile, 'private root one'),
      [0, ...all.slice(2)],
    );
    await delay(1_000);
    assert(
      !events[1].some((event) => event.uri === URI.file(privateFile).toString()),
      'Unsubscribed roots receive no events',
    );
    await managers[0].dispose();
    const continuation = path.join(probe, 'remaining.ts');
    await mutate(
      'close-one-others-continue',
      continuation,
      FileChangeType.ADDED,
      () => writeFile(continuation, 'remaining clients'),
      all.slice(2),
    );
    assert.equal(events[0].length, 0, 'Disposed connection receives no events');
    if (crashMode === 'crash') {
      assert.equal(variant, 'shared-node', 'Crash acceptance requires a shared host');
      const before = await collectProcessTreeMemory(process.pid);
      const victim = before.processes.find((entry) => entry.role === 'watcher-host')!;
      assert(victim, 'Owned watcher host exists before crash');
      process.kill(victim.pid, 'SIGKILL');
      let after = await collectProcessTreeMemory(process.pid);
      const deadline = Date.now() + 20_000;
      while (
        (!after.processes.some((entry) => entry.role === 'watcher-host' && entry.pid !== victim.pid) ||
          rescans.length === 0) &&
        Date.now() < deadline
      ) {
        await delay(100);
        after = await collectProcessTreeMemory(process.pid);
      }
      assert(rescans.length > 0, 'Crash reports lost-event rescan to remaining clients');
      assert.equal(after.byRole['watcher-host']?.count, 1);
      assert(!after.processes.some((entry) => entry.pid === victim.pid));
      await delay(1000);
      await mutate(
        'crash-recovery-all-live-leases',
        existingFile,
        FileChangeType.UPDATED,
        () => writeFile(existingFile, Buffer.concat([originalContents, Buffer.from('\n<!-- recovered watcher -->\n')])),
        all.slice(2),
      );
      assert.equal(events[0].length, 0, 'Disposed lease stays detached after crash');
      const privateAfterCrash = path.join(privateRoots[1], 'recovered.ts');
      await mutate(
        'crash-recovery-isolated-root',
        privateAfterCrash,
        FileChangeType.ADDED,
        () => writeFile(privateAfterCrash, 'recovered isolated root'),
        all.slice(1),
      );
      result.crashRecovery = {
        pass: true,
        oldPid: victim.pid,
        newPid: after.processes.find((entry) => entry.role === 'watcher-host')!.pid,
        rescans: rescans.length,
      };
      samples.push(after);
    }
    result.functionalPass = true;
  } catch (error) {
    result.error = String(error instanceof Error ? error.stack : error);
    result.lastEvents = events;
    process.exitCode = 1;
  } finally {
    const cleanup = await Promise.allSettled([
      ...managers.map((manager) => manager.dispose()),
      (injector.get(poolToken) as { dispose(): Promise<void> }).dispose(),
    ]);
    result.cleanupErrors = cleanup
      .filter((entry): entry is PromiseRejectedResult => entry.status === 'rejected')
      .map((entry) => String(entry.reason));
    const cleanupDeadline = Date.now() + 20_000;
    let postClose = await collectProcessTreeMemory(process.pid);
    const ownedRoles = ['watcher-host'] as const;
    while (ownedRoles.some((role) => postClose.byRole[role]?.count) && Date.now() < cleanupDeadline) {
      await delay(100);
      postClose = await collectProcessTreeMemory(process.pid);
    }
    result.postClose = postClose;
    result.lifecyclePass =
      cleanup.every((entry) => entry.status === 'fulfilled') &&
      ownedRoles.every((role) => !postClose.byRole[role]?.count);
    if (!result.lifecyclePass) {
      process.exitCode = 1;
    }
    result.elapsedMs = Date.now() - started;
    result.loadAtEnd = os.loadavg();
    await writeFile(path.join(outputDirectory, 'result.json'), JSON.stringify(result, null, 2) + '\n');
    await writeFile(existingFile, originalContents);
    await rm(probe, { recursive: true, force: true });
    for (const [key, value] of Object.entries(originalEnv)) {
      process.env[key] = value;
    }
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    process.execArgv.push(...inheritedExecArgv);
    process.stdout.write(
      JSON.stringify({
        variant,
        functionalPass: result.functionalPass,
        lifecyclePass: result.lifecyclePass,
        watcherP95MiB: result.watcherP95MiB,
        treeP95MiB: result.treeP95MiB,
        error: result.error,
      }) + '\n',
    );
  }
}

main().catch((error) => {
  process.stderr.write(String(error.stack || error) + '\n');
  process.exitCode = 1;
});
