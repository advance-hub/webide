import { type ChildProcess, spawn } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { copyFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { type Config, HTTPError } from './config';
import { type Project, type Repositories, type Workspace, command } from './git';
import { type Entity, Store, now } from './store';

export interface Machine extends Entity {
  driver: 'local' | 'sandbox';
  envId?: string;
  createdAt: string;
}
export interface Environment {
  exists: boolean;
  phase: string;
  ideReady: boolean;
  endpoint?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}
export interface RuntimeDriver {
  readonly name: 'local' | 'sandbox';
  root(workspace: Workspace): string;
  projectDirectory(workspace: Workspace): string;
  provision(machine: Machine): Promise<void>;
  prepare(workspace: Workspace, project: Project, repositories: Repositories, reset?: boolean): Promise<void>;
  start(workspace: Workspace): Promise<void>;
  stop(workspace: Workspace): Promise<void>;
  inspect(workspace: Workspace): Promise<Environment>;
  helper(workspace: Workspace, name: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  remove(workspace: Workspace, project: Project, repositories: Repositories): Promise<void>;
  release(machine: Machine): Promise<void>;
  close(): Promise<void>;
}

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

  async prepare(workspace: Workspace, project: Project, repositories: Repositories, reset = false): Promise<void> {
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
      const response = await fetch(`${endpoint}/readyz`, {
        headers: { 'X-Workspace-Id': workspace.id },
        signal: AbortSignal.timeout(2000),
      });
      return { exists, phase: response.ok ? 'running' : 'unhealthy', ideReady: response.ok, endpoint };
    } catch {
      return { exists, phase: 'stopped', ideReady: false };
    }
  }

  async start(workspace: Workspace): Promise<void> {
    if ((await this.inspect(workspace)).ideReady) {
      return;
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
        OPENSUMI_WORKSPACE_AGENT_WATCH_MODE: 'off',
        OPENSUMI_WORKSPACE_AGENT_SEARCH_MODE: 'off',
        OPENSUMI_WORKSPACE_AGENT_FILE_SEARCH_MODE: 'off',
        OPENSUMI_WS_GATEWAY_MODE: 'off',
        ENABLE_COLLABORATION: '0',
        OPENSUMI_EXTENSION_DIR: path.join(this.home(workspace), '.sumi/extensions'),
        OPENSUMI_BUILTIN_EXTENSION_DIR: path.join(this.config.root, 'tools/extensions'),
        ...(existsSync(path.join(this.config.root, 'builtin-extensions.manifest.json'))
          ? {
              OPENSUMI_BUILTIN_EXTENSION_MANIFEST: path.join(this.config.root, 'builtin-extensions.manifest.json'),
            }
          : {}),
        MAX_EXTENSION_HOSTS: '3',
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
    for (let attempt = 0; attempt < 120; attempt++) {
      if (spawnError) {
        throw spawnError;
      }
      if (child.exitCode !== null || child.signalCode !== null) {
        break;
      }
      if ((await this.inspect(workspace)).ideReady) {
        workspace.lastActivityAt = now();
        this.store.put('workspace', workspace);
        return;
      }
      await delay(500);
    }
    await this.stop(workspace);
    throw new Error(`IDE 启动失败：${(await readFile(log, 'utf8')).slice(-4000)}`);
  }

  async stop(workspace: Workspace): Promise<void> {
    const child = this.children.get(workspace.id);
    // Only signal children created by this control process; persisted PIDs alone are not ownership proof.
    if (!child?.pid) {
      if ((await this.inspect(workspace)).ideReady) {
        throw new HTTPError(409, 'IDE 由其他控制进程持有，请先关闭该进程');
      }
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
  }

  async helper(workspace: Workspace, name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
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
