import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { Sandbox, type Volume } from '@alibaba-group/opensandbox';

import { type Project, type Workspace } from '../domain/models';
import { type Environment, type Machine, type RuntimeDriver, startupRecord } from '../domain/runtime';
import { DockerEngine } from '../infrastructure/docker';
import { KubernetesVolumes } from '../infrastructure/kubernetes-volumes';
import { SandboxService, shellQuote as q } from '../infrastructure/opensandbox';
import { type Config } from '../platform/config';
import { type Store, hash, newID, now } from '../platform/store';
import { HTTPError } from '../platform/validation';

import type { RepositorySource } from '../domain/repository-source';

export class SandboxRuntime implements RuntimeDriver {
  readonly name = 'sandbox' as const;
  private readonly provisioning = new Map<string, Promise<void>>();

  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly service: SandboxService,
  ) {}

  root(workspace: Workspace): string {
    return `/workspace/workspaces/${workspace.id}`;
  }
  projectDirectory(workspace: Workspace): string {
    return `${this.root(workspace)}/project`;
  }
  private repository(workspace: Workspace): string {
    return `/workspace/projects/${workspace.projectId}/repo.git`;
  }
  private environment(workspace: Workspace): string {
    if (!workspace.envId) {
      throw new HTTPError(409, '开发机尚未分配沙箱');
    }
    return workspace.envId;
  }

  provision(machine: Machine): Promise<void> {
    const running = this.provisioning.get(machine.id);
    if (running) {
      return running.then(() => {
        machine.envId = this.store.get<Machine>('machine', machine.id)?.envId;
      });
    }
    const task = this.ensure(machine).finally(() => this.provisioning.delete(machine.id));
    this.provisioning.set(machine.id, task);
    return task;
  }

  private volume(machine: Machine): Volume {
    return {
      name: 'workspace',
      mountPath: '/workspace',
      pvc: {
        claimName: `opensumi-${machine.id}`,
        createIfNotExists: true,
        deleteOnSandboxTermination: false,
        storage: '5Gi',
        accessModes: ['ReadWriteOnce'],
        ...(this.config.storageClass ? { storageClass: this.config.storageClass } : {}),
      },
    };
  }

  private async ensure(machine: Machine, image = this.config.sandboxImage): Promise<void> {
    const metadata = { 'opensumi.workspace': machine.id, application: 'opensumi-workbench' };
    const owner = hash(machine.owner).slice(0, 32);
    const matches = (await this.service.list(metadata)).filter((info) => !info.metadata?.['opensumi.gc']);
    if (matches.some((info) => info.metadata?.['opensumi.owner'] && info.metadata['opensumi.owner'] !== owner)) {
      throw new HTTPError(409, '沙箱账户所有权不匹配');
    }
    if (matches.length > 1) {
      throw new HTTPError(409, '多个沙箱持有同一开发机，请管理员处理');
    }
    if (!matches.length && machine.envId && this.config.storageMode === 'retained') {
      throw new HTTPError(409, '原沙箱已丢失，文件保存在沙箱内；请从备份恢复，不能创建空环境覆盖记录');
    }
    if (!matches.length) {
      if (!image) {
        throw new HTTPError(409, '请配置 OPEN_SANDBOX_IMAGE');
      }
      let sandbox: Sandbox | undefined;
      try {
        sandbox = await Sandbox.create({
          connectionConfig: this.service.connection,
          image,
          platform: this.config.sandboxPlatform
            ? { os: 'linux', arch: this.config.sandboxPlatform === 'linux/amd64' ? 'amd64' : 'arm64' }
            : undefined,
          entrypoint: ['/bin/sh', '-c', 'exec sleep infinity'],
          metadata: { ...metadata, 'opensumi.owner': owner },
          resource: { cpu: this.config.sandboxCPU, memory: this.config.sandboxMemory },
          timeoutSeconds: null,
          skipHealthCheck: true,
          volumes: this.config.storageMode === 'pvc' ? [this.volume(machine)] : undefined,
        });
        machine.envId = sandbox.id;
        this.store.put('machine', machine);
        await sandbox.waitUntilReady({ readyTimeoutSeconds: 180, pollingIntervalMillis: 1000 });
      } catch (error) {
        // 创建请求可能已受理但客户端超时，重试前先核对持久元数据。
        const recovered = (await this.service.list(metadata)).filter((info) => !info.metadata?.['opensumi.gc']);
        if (recovered.length === 1) {
          machine.envId = recovered[0].id;
          this.store.put('machine', machine);
        }
        throw error;
      } finally {
        await sandbox?.close();
      }
      return;
    }
    const info = matches[0];
    machine.envId = info.id;
    this.store.put('machine', machine);
    if (info.status.state === 'Paused') {
      await this.service.manager.resumeSandbox(info.id);
    }
    await this.service.withSandbox(info.id, (sandbox) =>
      sandbox.waitUntilReady({ readyTimeoutSeconds: 180, pollingIntervalMillis: 1000 }),
    );
  }

  async prepare(workspace: Workspace, project: Project, repositories: RepositorySource, reset = false): Promise<void> {
    const env = this.environment(workspace);
    const root = this.root(workspace);
    const directory = this.projectDirectory(workspace);
    const repository = this.repository(workspace);
    if (reset) {
      await this.service.run(
        env,
        `set -eu
if test -e ${q(directory + '/.git')}; then git --git-dir=${q(repository)} worktree remove --force -- ${q(directory)}; fi
rm -f -- ${q(root + '/.platform/development-init.json')}`,
      );
    }
    if (
      (await this.service.run(env, `if test -e ${q(directory + '/.git')}; then printf existing; fi`)).trim() ===
      'existing'
    ) {
      return;
    }
    const sha = await repositories.pinWorkspace(project, workspace);
    const bundle = `${root}/.platform/baseline.bundle`;
    // Execd SDK 的 JSON 权限使用十进制表示的八进制数字 700/600，与 fs 权限不同。
    await this.service.withSandbox(env, async (sandbox) => {
      await sandbox.files.createDirectories([{ path: `${root}/.platform`, mode: 700 }]);
      await sandbox.files.writeFiles([
        { path: bundle, data: createReadStream(repositories.bundle(project, sha)), mode: 600 },
        { path: `${root}/.platform/workspace-id`, data: workspace.id, mode: 600 },
      ]);
    });
    await this.service.run(
      env,
      `set -eu
mkdir -p ${q(path.posix.dirname(repository))} /workspace/home
if ! test -d ${q(repository)}; then git init --bare ${q(repository)}; fi
git --git-dir=${q(repository)} fetch ${q(bundle)} ${q(`refs/opensumi/baselines/${sha}:refs/opensumi/baselines/${sha}`)}
git --git-dir=${q(repository)} worktree prune
git --git-dir=${q(repository)} worktree add --detach -- ${q(directory)} ${q(sha)}
git -C ${q(directory)} switch -C ${q(workspace.branch)}
git -C ${q(directory)} remote remove origin 2>/dev/null || true
git -C ${q(directory)} remote add origin ${q(project.url)}
rm -f -- ${q(bundle)}`,
    );
  }

  async start(workspace: Workspace): Promise<void> {
    if ((await this.inspect(workspace)).ideReady) {
      return;
    }
    if (!workspace.idePort) {
      throw new HTTPError(409, '工作区 IDE 端口未分配');
    }
    await this.service.run(
      this.environment(workspace),
      `WORKSPACE_ROOT=${q(this.root(workspace))} WORKSPACE_ID=${q(workspace.id)} OPENSUMI_RUNTIME_MODE=node OPENSUMI_NODE_WATCHER_MODE=${q(this.config.nodeWatcherMode)} OPENSUMI_RUNTIME_TOKEN=${q(newID() + newID())} OPENSUMI_RUNTIME_FINGERPRINT="$(cat /app/.runtime-fingerprint)" PORT=${workspace.idePort} /opt/opensumi/bin/start-workspace`,
      180,
    );
    const state = await this.inspect(workspace);
    if (!state.ideReady) {
      throw new HTTPError(502, '沙箱 IDE 启动后未通过就绪检查');
    }
    const runtime = state.runtime as { fingerprint?: string; node?: string; architecture?: string } | undefined;
    startupRecord(workspace).runtime = { source: 'sandbox', ...runtime };
    workspace.lastActivityAt = now();
    this.store.put('workspace', workspace);
  }

  async stop(workspace: Workspace): Promise<void> {
    if (!workspace.envId) {
      return;
    }
    await this.service.run(workspace.envId, `node /opt/opensumi/bin/stop-ide.cjs ${q(this.root(workspace))}`);
  }

  async inspect(workspace: Workspace): Promise<Environment> {
    if (!workspace.envId) {
      return { exists: false, phase: 'absent', ideReady: false };
    }
    const info = await this.service.manager.getSandboxInfo(workspace.envId);
    const base: Environment = {
      exists: true,
      phase: info.status.state,
      ideReady: false,
      createdAt: info.createdAt,
      expiresAt: info.expiresAt,
      imageName: info.image?.uri,
    };
    if (info.status.state !== 'Running' || !workspace.idePort) {
      return base;
    }
    const endpoint = await this.service.endpoint(info.id, workspace.idePort);
    try {
      const response = await fetch(endpoint.endpoint.replace(/\/$/, '') + '/readyz', {
        headers: { ...endpoint.headers, 'X-Workspace-Id': workspace.id },
        signal: AbortSignal.timeout(8000),
      });
      const data = (await response.json()) as {
        runtime?: {
          workspace?: { id?: string; directory?: string };
          fingerprint?: string;
          node?: string;
          architecture?: string;
        };
      };
      const owned =
        data.runtime?.workspace?.id === workspace.id &&
        data.runtime.workspace.directory === this.projectDirectory(workspace);
      return { ...base, ...endpoint, ideReady: response.ok && owned, runtime: data.runtime };
    } catch {
      return base;
    }
  }

  async helper(workspace: Workspace, name: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (name === 'editor-connections' || (name === 'git' && input.action === 'configure')) {
      const temporary = `${this.root(workspace)}/.platform/editor-connections-${newID()}.json`;
      return this.service.withSandbox(this.environment(workspace), async (sandbox) => {
        try {
          await sandbox.files.createDirectories([{ path: path.posix.dirname(temporary), mode: 700 }]);
          await sandbox.files.writeFiles([
            { path: temporary, data: JSON.stringify(name === 'git' ? input : input.spec || {}), mode: 600 },
          ]);
          return JSON.parse(
            await this.service.run(
              this.environment(workspace),
              name === 'git'
                ? `node /opt/opensumi/bin/git.cjs ${q(this.root(workspace))} ${q('@' + temporary)}`
                : `node /opt/opensumi/bin/editor-connections.cjs ${input.action === 'remove' ? 'remove' : 'install'} ${q(this.root(workspace))} ${q(temporary)}`,
            ),
          );
        } finally {
          await sandbox.files.deleteFiles([temporary]);
        }
      });
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
    const { action, ...options } = input;
    const payload = Buffer.from(JSON.stringify(name === 'maven' ? options : input)).toString('base64');
    const args =
      name === 'maven' ? [String(action || 'inspect'), this.root(workspace), payload] : [this.root(workspace), payload];
    const result = JSON.parse(
      await this.service.run(
        this.environment(workspace),
        `node ${q(`/opt/opensumi/bin/${name}.cjs`)} ${args.map(q).join(' ')}`,
        name === 'maven' ? Number(input.timeoutMinutes || 15) * 60 + 30 : 180,
      ),
    ) as Record<string, unknown>;
    if (result.error) {
      throw new HTTPError(400, String(result.error));
    }
    return result;
  }

  async upgradeMachine(machine: Machine): Promise<void> {
    if (this.config.storageMode !== 'pvc') {
      throw new HTTPError(409, '保留沙箱模式不能替换容器，请先备份并迁移到持久卷模式');
    }
    if (!this.config.sandboxImage) {
      throw new HTTPError(409, '请配置目标 OPEN_SANDBOX_IMAGE');
    }
    const instances = await this.service.list({ 'opensumi.workspace': machine.id, application: 'opensumi-workbench' });
    if (
      instances.some(
        (info) =>
          info.metadata?.['opensumi.owner'] && info.metadata['opensumi.owner'] !== hash(machine.owner).slice(0, 32),
      )
    ) {
      throw new HTTPError(409, '沙箱账户所有权不匹配');
    }
    if (instances.length > 1) {
      throw new HTTPError(409, '多个沙箱持有同一开发机，不能升级');
    }
    machine.runtimePreviousImage ||= instances[0]?.image?.uri;
    machine.runtimeTargetImage = this.config.sandboxImage;
    this.store.put('machine', machine);
    for (const info of instances) {
      await this.service.manager.killSandbox(info.id);
    }
    try {
      await this.ensure(machine, this.config.sandboxImage);
      machine.runtimeImage = this.config.sandboxImage;
      machine.runtimePreviousImage = undefined;
      this.store.put('machine', machine);
    } catch (error) {
      throw new HTTPError(502, '目标运行时未就绪，持久卷已保留，请恢复升级任务', { cause: error });
    }
  }

  async exportMachine(machine: Machine, target: string): Promise<void> {
    if (!machine.envId) {
      throw new HTTPError(409, '开发机环境不存在');
    }
    const temporary = `/tmp/webide-backup-${newID()}.tgz`;
    let size = 0;
    await this.service.withSandbox(
      machine.envId,
      async (sandbox) => {
        try {
          await this.service.run(
            machine.envId!,
            `node /opt/opensumi/bin/machine-archive.cjs /workspace export ${q(temporary)}`,
            1200,
          );
          await pipeline(
            Readable.from(sandbox.files.readBytesStream(temporary)),
            new Transform({
              transform(chunk, _encoding, done) {
                size += chunk.length;
                done(size > 5 * 1024 * 1024 * 1024 ? new Error('备份超过 5 GiB') : null, chunk);
              },
            }),
            createWriteStream(target, { flags: 'wx', mode: 0o600 }),
          );
        } finally {
          await sandbox.files.deleteFiles([temporary]);
        }
      },
      1215,
    );
  }
  async restoreMachine(
    machine: Machine,
    action: 'stage' | 'apply' | 'commit' | 'rollback',
    archive?: string,
  ): Promise<void> {
    if (!machine.envId) {
      throw new HTTPError(409, '开发机环境不存在');
    }
    if (action === 'stage') {
      const temporary = `/tmp/webide-restore-${newID()}.tgz`;
      await this.service.withSandbox(
        machine.envId,
        async (sandbox) => {
          try {
            await sandbox.files.writeFiles([{ path: temporary, data: createReadStream(archive!), mode: 600 }]);
            await this.service.run(
              machine.envId!,
              `node /opt/opensumi/bin/machine-archive.cjs /workspace stage ${q(temporary)}`,
              1200,
            );
          } finally {
            await sandbox.files.deleteFiles([temporary]);
          }
        },
        1215,
      );
    } else {
      await this.service.run(
        machine.envId,
        `node /opt/opensumi/bin/restore-machine.cjs /workspace ${action} /workspace/.clouddev-restore-next`,
      );
      if (action === 'commit' || action === 'rollback') {
        await this.service.run(machine.envId, 'rm -rf -- /workspace/.clouddev-restore-next');
      }
    }
  }

  async exportBranch(workspace: Workspace, target: string): Promise<string> {
    const result = await this.helper(workspace, 'git', { action: 'export', branch: workspace.branch });
    let size = 0;
    return this.service.withSandbox(this.environment(workspace), async (sandbox) => {
      try {
        await pipeline(
          Readable.from(sandbox.files.readBytesStream(String(result.bundle))),
          new Transform({
            transform(chunk, _encoding, done) {
              size += chunk.length;
              done(size > 512 * 1024 * 1024 ? new Error('提交包超过 512 MiB') : null, chunk);
            },
          }),
          createWriteStream(target, { flags: 'wx', mode: 0o600 }),
        );
        return String(result.sha);
      } finally {
        await sandbox.files.deleteFiles([String(result.bundle)]);
      }
    });
  }

  async remove(workspace: Workspace): Promise<void> {
    await this.stop(workspace);
    await this.service.run(
      this.environment(workspace),
      `set -eu
if test -e ${q(this.projectDirectory(workspace) + '/.git')}; then git --git-dir=${q(this.repository(workspace))} worktree remove --force -- ${q(this.projectDirectory(workspace))}; fi
rm -rf -- ${q(this.root(workspace))}`,
    );
  }

  async release(machine: Machine): Promise<void> {
    if (this.config.storageMode === 'pvc' && this.config.volumeBackend === 'external') {
      throw new HTTPError(
        409,
        '持久卷由外部平台管理；请配置相同 Docker 守护进程的 WORKBENCH_VOLUME_BACKEND=docker 后回收',
      );
    }
    const instances = await this.service.list({ 'opensumi.workspace': machine.id, application: 'opensumi-workbench' });
    if (
      instances.some(
        (info) =>
          info.metadata?.['opensumi.owner'] && info.metadata['opensumi.owner'] !== hash(machine.owner).slice(0, 32),
      )
    ) {
      throw new HTTPError(409, '沙箱账户所有权不匹配');
    }
    for (const info of instances) {
      await this.service.manager.killSandbox(info.id);
    }
    if (this.config.storageMode !== 'pvc') {
      return;
    }
    if (this.config.volumeBackend === 'kubernetes') {
      await new KubernetesVolumes(this.config, this.store).remove(machine);
    } else {
      await new DockerEngine(this.config).removeMachineVolume(machine.id);
    }
  }

  async close(): Promise<void> {
    /* 控制面重启不回收远程开发机。 */
  }
}
