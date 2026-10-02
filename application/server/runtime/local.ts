import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { type Project, type Workspace } from '../domain/models';
import { type Environment, type Machine, type RuntimeDriver, startupRecord } from '../domain/runtime';
import { type Config } from '../platform/config';
import { command } from '../platform/process';
import { Store, newID, now } from '../platform/store';
import { readTextTail } from '../platform/text-tail';
import { HTTPError } from '../platform/validation';

import { runtimeFingerprint } from './fingerprint';

import type { RepositorySource } from '../domain/repository-source';

async function availablePort(): Promise<number> {
  const listener = net.createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', resolve);
  });
  const port = (listener.address() as net.AddressInfo).port;
  await new Promise<void>((resolve, reject) => listener.close((error) => (error ? reject(error) : resolve())));
  return port;
}

export class LocalRuntime implements RuntimeDriver {
  readonly name = 'local' as const;
  private readonly children = new Map<string, ChildProcess>();
  constructor(
    readonly config: Config,
    readonly store: Store,
  ) {}
  machineRoot(id: string): string {
    return path.join(this.config.data, 'machines', id);
  }
  root(workspace: Workspace): string {
    return path.join(this.machineRoot(String(workspace.machineId)), 'workspaces', workspace.id);
  }
  projectDirectory(workspace: Workspace): string {
    return path.join(this.root(workspace), 'project');
  }
  home(workspace: Workspace): string {
    return path.join(this.machineRoot(String(workspace.machineId)), 'home');
  }

  private repository(workspace: Workspace): string {
    return path.join(this.machineRoot(String(workspace.machineId)), 'repositories', `${workspace.projectId}.git`);
  }

  async prepare(workspace: Workspace, project: Project, repositories: RepositorySource, reset = false): Promise<void> {
    const directory = this.projectDirectory(workspace);
    const repository = this.repository(workspace);
    if (reset && existsSync(path.join(directory, '.git'))) {
      await command('git', [`--git-dir=${repository}`, 'worktree', 'remove', '--force', '--', directory]);
    }
    if (existsSync(path.join(directory, '.git'))) {
      return;
    }
    const sha = await repositories.pinWorkspace(project, workspace);
    await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(repository), { recursive: true, mode: 0o700 });
    if (!existsSync(repository)) {
      await command('git', ['clone', '--bare', '--shared', '--', repositories.directory(project), repository]);
      await command('git', [`--git-dir=${repository}`, 'config', 'remote.origin.url', project.url]);
    }
    await command('git', [`--git-dir=${repository}`, 'worktree', 'prune']);
    await command('git', [`--git-dir=${repository}`, 'worktree', 'add', '--detach', '--', directory, sha]);
    await command('git', ['-C', directory, 'switch', '-C', workspace.branch]);
  }

  async provision(machine: Machine): Promise<void> {
    await mkdir(path.join(this.machineRoot(machine.id), 'home/.sumi'), { recursive: true, mode: 0o700 });
    const settings = path.join(this.machineRoot(machine.id), 'home/.sumi/settings.json');
    if (!existsSync(settings)) {
      await copyFile(path.join(this.config.root, 'application/runtime/default-settings.json'), settings);
    }
    machine.envId = `local-${machine.id}`;
    this.store.put('machine', machine);
  }

  async inspect(workspace: Workspace): Promise<Environment> {
    const exists = existsSync(this.projectDirectory(workspace));
    if (!workspace.idePort) {
      return { exists, phase: 'stopped', ideReady: false };
    }
    try {
      const endpoint = `http://127.0.0.1:${workspace.idePort}`;
      const owner = JSON.parse(await readFile(path.join(this.root(workspace), '.platform/ide-owner.json'), 'utf8')) as {
        pid: number;
        token: string;
      };
      const response = await fetch(`${endpoint}/runtime/identity`, {
        headers: { Authorization: `Bearer ${owner.token}`, 'X-Workspace-Id': workspace.id },
        signal: AbortSignal.timeout(2000),
      });
      if (!response.ok) {
        return { exists, phase: 'unowned', ideReady: false };
      }
      const identity = (await response.json()) as {
        workspace?: { id?: string; directory?: string };
        pid: number;
        fingerprint: string;
        node: string;
        architecture: string;
      };
      if (
        identity.workspace?.id !== workspace.id ||
        identity.workspace.directory !== this.projectDirectory(workspace) ||
        identity.pid !== owner.pid
      ) {
        return { exists, phase: 'unowned', ideReady: false };
      }
      const readiness = await fetch(`${endpoint}/readyz`, {
        headers: { 'X-Workspace-Id': workspace.id },
        signal: AbortSignal.timeout(2000),
      });
      return {
        exists,
        phase: readiness.ok ? 'running' : 'unhealthy',
        ideReady: readiness.ok,
        endpoint,
        headers: { Authorization: `Bearer ${owner.token}`, 'X-Opensumi-Runtime-Token': owner.token },
        runtime: identity,
        recovered: !this.children.has(workspace.id),
      };
    } catch {
      try {
        const response = await fetch(`http://127.0.0.1:${workspace.idePort}/health`, {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) {
          return { exists, phase: 'unowned', ideReady: false };
        }
      } catch {
        /* 没有正在监听的服务。 */
      }
      return { exists, phase: 'stopped', ideReady: false };
    }
  }

  async start(workspace: Workspace): Promise<void> {
    const environment = await this.inspect(workspace);
    if (environment.phase === 'unowned') {
      throw new HTTPError(409, 'IDE 进程所有权不匹配，保留进程等待检查');
    }
    if (environment.ideReady) {
      return;
    }
    if (environment.endpoint) {
      await this.stop(workspace);
    }
    const entry = path.join(this.config.root, 'server/dist/main.js');
    if (!existsSync(entry)) {
      throw new Error('IDE 服务尚未构建，请先运行 pnpm build:all');
    }
    const platform = path.join(this.root(workspace), '.platform');
    await mkdir(platform, { recursive: true, mode: 0o700 });
    const homeLink = path.join(this.root(workspace), 'home');
    await mkdir(path.join(homeLink, '.m2'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(this.home(workspace), '.m2/repository'), { recursive: true });
    if (!existsSync(path.join(homeLink, '.m2/repository'))) {
      await symlink(
        path.join(this.home(workspace), '.m2/repository'),
        path.join(homeLink, '.m2/repository'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    }
    await command(
      process.execPath,
      [path.join(this.config.root, 'application/runtime/personal-settings.cjs'), this.root(workspace)],
      {
        env: { ...process.env, WORKBENCH_MACHINE_HOME: this.home(workspace) },
      },
    );
    const settings = path.join(homeLink, '.sumi/settings.json');
    await command(process.execPath, [
      path.join(this.config.root, 'application/runtime/ensure-default-settings.cjs'),
      settings,
      path.join(this.config.root, 'application/runtime/default-settings.json'),
    ]);
    await mkdir(path.join(this.home(workspace), '.sumi/extensions'), { recursive: true });
    const port = await availablePort();
    workspace.idePort = port;
    workspace.envId = `local-${workspace.machineId}`;
    this.store.put('workspace', workspace);
    const token = newID() + newID();
    const fingerprint = await runtimeFingerprint(this.config.root);
    const log = path.join(platform, 'ide.log');
    const descriptor = openSync(log, 'a', 0o600);
    const child = spawn(process.execPath, ['--max-old-space-size=768', entry], {
      cwd: this.config.root,
      detached: process.platform !== 'win32',
      stdio: ['ignore', descriptor, descriptor],
      env: {
        ...process.env,
        NODE_ENV: 'production',
        HOST: '127.0.0.1',
        PORT: String(port),
        HOME: homeLink,
        WORKSPACE_DIR: this.projectDirectory(workspace),
        WORKSPACE_ID: workspace.id,
        IDE_ALLOW_ROOT: this.projectDirectory(workspace),
        OPENSUMI_RUNTIME_MODE: 'node',
        OPENSUMI_RUNTIME_TOKEN: token,
        OPENSUMI_RUNTIME_FINGERPRINT: fingerprint,
        OPENSUMI_NODE_WATCHER_MODE: this.config.nodeWatcherMode,
        ENABLE_COLLABORATION: '1',
        COLLABORATION_TRANSPORT: 'shared',
        ENABLE_AI: '1',
        OPENSUMI_EXTENSION_DIR: path.join(this.home(workspace), '.sumi/extensions'),
        OPENSUMI_BUILTIN_EXTENSION_DIR: path.join(this.config.root, 'tools/extensions'),
        ...(existsSync(path.join(this.config.root, 'builtin-extensions.manifest.json'))
          ? {
              OPENSUMI_BUILTIN_EXTENSION_MANIFEST: path.join(this.config.root, 'builtin-extensions.manifest.json'),
            }
          : {}),
        MAX_EXTENSION_HOSTS: '5',
        MAX_MANAGED_EXTENSION_PROCESSES: '5',
        EXTENSION_HOST_STARTUP_TIMEOUT: '60000',
      },
    });
    closeSync(descriptor);
    this.children.set(workspace.id, child);
    let spawnError: Error | undefined;
    child.once('error', (error) => {
      spawnError = error;
    });
    child.once('exit', () => {
      if (this.children.get(workspace.id) === child) {
        this.children.delete(workspace.id);
      }
    });
    await writeFile(path.join(platform, 'ide.pid'), String(child.pid || ''), { mode: 0o600 });
    await writeFile(path.join(platform, 'ide-owner.json'), JSON.stringify({ pid: child.pid, token, fingerprint }), {
      mode: 0o600,
    });
    for (let attempt = 0; attempt < 120; attempt++) {
      if (spawnError) {
        throw spawnError;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        break;
      }
      if ((await this.inspect(workspace)).ideReady) {
        startupRecord(workspace).runtime = {
          source: 'local',
          fingerprint,
          node: process.version,
          architecture: process.arch,
        };
        workspace.lastActivityAt = now();
        this.store.put('workspace', workspace);
        return;
      }
      await delay(500);
    }
    await this.stop(workspace);
    throw new Error(`IDE 启动失败：${await readTextTail(log)}`);
  }

  async stop(workspace: Workspace): Promise<void> {
    const child = this.children.get(workspace.id);
    if (!child?.pid) {
      const environment = await this.inspect(workspace);
      if (!environment.endpoint) {
        if (environment.phase === 'unowned') {
          throw new HTTPError(409, 'IDE 进程所有权不匹配，保留进程等待检查');
        }
        return;
      }
      const owner = JSON.parse(await readFile(path.join(this.root(workspace), '.platform/ide-owner.json'), 'utf8')) as {
        pid: number;
        token: string;
      };
      const response = await fetch(`${environment.endpoint}/runtime/shutdown`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${owner.token}`, 'X-Workspace-Id': workspace.id },
        signal: AbortSignal.timeout(5000),
      });
      if (response.status !== 202) {
        throw new HTTPError(409, '孤儿 IDE 未接受关闭请求');
      }
      const deadline = Date.now() + 35000;
      for (;;) {
        try {
          process.kill(owner.pid, 0);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
            break;
          }
          throw error;
        }
        if (Date.now() >= deadline) {
          throw new HTTPError(409, '孤儿 IDE 未退出，保留记录等待检查');
        }
        await delay(100);
      }
      await rm(path.join(this.root(workspace), '.platform/ide-owner.json'), { force: true });
      await rm(path.join(this.root(workspace), '.platform/ide.pid'), { force: true });
      return;
    }
    const signal = (value: NodeJS.Signals) => {
      try {
        process.kill(process.platform === 'win32' ? child.pid! : -child.pid!, value);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
          throw error;
        }
      }
    };
    signal('SIGTERM');
    const deadline = Date.now() + 10000;
    while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
      await delay(100);
    }
    if (child.exitCode === null && child.signalCode === null) {
      signal('SIGKILL');
    }
    this.children.delete(workspace.id);
    await rm(path.join(this.root(workspace), '.platform/ide.pid'), { force: true });
    await rm(path.join(this.root(workspace), '.platform/ide-owner.json'), { force: true });
  }

  async helper(workspace: Workspace, name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (name === 'editor-connections' || (name === 'git' && input.action === 'configure')) {
      const temporary = path.join(this.root(workspace), '.platform', `private-${newID()}.json`);
      await mkdir(path.dirname(temporary), { recursive: true, mode: 0o700 });
      try {
        await writeFile(temporary, JSON.stringify(name === 'git' ? input : input.spec || {}), {
          mode: 0o600,
          flag: 'wx',
        });
        const args =
          name === 'git'
            ? [this.root(workspace), `@${temporary}`]
            : [input.action === 'remove' ? 'remove' : 'install', this.root(workspace), temporary];
        return JSON.parse(
          await command(process.execPath, [path.join(this.config.root, `application/runtime/${name}.cjs`), ...args]),
        );
      } finally {
        await rm(temporary, { force: true });
      }
    }
    if (
      ![
        'git',
        'services',
        'maven',
        'maven-config',
        'machine',
        'preferences',
        'development',
        'editor-connections',
      ].includes(name)
    ) {
      throw new HTTPError(400, '未知工作区工具');
    }
    const file = path.join(this.config.root, 'application/runtime', `${name}.cjs`);
    const { action, ...options } = input;
    const payload = Buffer.from(JSON.stringify(name === 'maven' ? options : input)).toString('base64');
    const args =
      name === 'maven'
        ? [file, String(action || 'inspect'), this.root(workspace), payload]
        : [file, this.root(workspace), payload];
    let output: string;
    try {
      output = await command(process.execPath, args, {
        env: {
          ...process.env,
          HOME: path.join(this.root(workspace), 'home'),
          WORKBENCH_MACHINE_HOME: this.home(workspace),
        },
        timeout: name === 'maven' ? (Number(input.timeoutMinutes || 15) * 60 + 30) * 1000 : 120000,
      });
    } catch (error) {
      const stdout = (error as { stdout?: string }).stdout;
      if (!stdout) {
        throw new HTTPError(502, '工作区工具执行失败', { cause: error });
      }
      output = stdout;
    }
    const result = JSON.parse(output) as Record<string, unknown>;
    if (result.error) {
      throw new HTTPError(400, String(result.error));
    }
    return result;
  }

  async upgradeMachine(machine: Machine): Promise<void> {
    await command(
      process.execPath,
      ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', path.join(this.config.root, 'scripts/build-runtime.ts')],
      { cwd: this.config.root, timeout: 1200000 },
    );
    machine.runtimeFingerprint = await runtimeFingerprint(this.config.root);
    this.store.put('machine', machine);
  }

  async exportMachine(machine: Machine, target: string): Promise<void> {
    await command(
      process.execPath,
      [
        path.join(this.config.root, 'application/runtime/machine-archive.cjs'),
        this.machineRoot(machine.id),
        'export',
        target,
      ],
      { timeout: 1200000 },
    );
  }
  async restoreMachine(
    machine: Machine,
    action: 'stage' | 'apply' | 'commit' | 'rollback',
    archive?: string,
  ): Promise<void> {
    const root = this.machineRoot(machine.id);
    if (action === 'stage') {
      await command(
        process.execPath,
        [path.join(this.config.root, 'application/runtime/machine-archive.cjs'), root, action, archive!],
        { timeout: 1200000 },
      );
    } else {
      await command(process.execPath, [
        path.join(this.config.root, 'application/runtime/restore-machine.cjs'),
        root,
        action,
        path.join(root, '.clouddev-restore-next'),
      ]);
      if (action === 'commit' || action === 'rollback') {
        await rm(path.join(root, '.clouddev-restore-next'), { recursive: true, force: true });
      }
    }
  }

  async exportBranch(workspace: Workspace, target: string): Promise<string> {
    const result = await this.helper(workspace, 'git', { action: 'export', branch: workspace.branch });
    const source = String(result.bundle);
    try {
      await copyFile(source, target);
      return String(result.sha);
    } finally {
      await rm(source, { force: true });
    }
  }

  async remove(workspace: Workspace): Promise<void> {
    await this.stop(workspace);
    if (existsSync(path.join(this.projectDirectory(workspace), '.git'))) {
      await command('git', [
        `--git-dir=${this.repository(workspace)}`,
        'worktree',
        'remove',
        '--force',
        '--',
        this.projectDirectory(workspace),
      ]);
    }
    await rm(this.root(workspace), { recursive: true, force: true });
  }
  async release(machine: Machine): Promise<void> {
    await rm(this.machineRoot(machine.id), { recursive: true, force: true });
  }
  async close(): Promise<void> {
    await Promise.all(
      this.store.list<Workspace>('workspace').map(async (workspace) => {
        if (!this.children.has(workspace.id)) {
          return;
        }
        await this.stop(workspace);
        workspace.status = 'stopped';
        workspace.op = undefined;
        workspace.updatedAt = now();
        this.store.put('workspace', workspace);
      }),
    );
  }
}
