import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { type Workspace } from '../../domain/models';
import { type Machine, type RuntimeDriver } from '../../domain/runtime';
import { type Config } from '../../platform/config';
import { Jobs } from '../../platform/jobs';
import { type Entity, Store, newID, now, publicEntity } from '../../platform/store';
import { HTTPError } from '../../platform/validation';

export interface MachinePolicy {
  idleMinutes: number;
  autoBackupHours: number;
}
interface MachineJob {
  action: string;
  status: string;
  phase: string;
  startedAt: string;
  finishedAt?: string;
  error?: string;
  needsRecovery?: boolean;
  resume: string[];
  previous?: Workspace[];
}
interface ManagedMachine extends Machine {
  policy?: MachinePolicy;
  job?: MachineJob;
  lastBackupAt?: string;
  lastBackupAttemptAt?: string;
}
interface Backup extends Entity {
  machineId: string;
  name: string;
  bytes: number;
  sha256: string;
  createdAt: string;
  automatic: boolean;
  workspaces: Workspace[];
}
const machineKey = (machine: Machine) => `machine:${machine.id}`;

/* * 开发机操作同时保存持久恢复状态与进程内资源锁。 */
export class Machines {
  private timer?: NodeJS.Timeout;
  private maintenance?: Promise<void>;
  private closing = false;

  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly driver: RuntimeDriver,
    readonly jobs: Jobs,
    private readonly resume: (workspace: Workspace) => Promise<void>,
    private readonly connected: (id: string) => boolean,
  ) {
    for (const machine of store.list<ManagedMachine>('machine')) {
      if (machine.job?.status === 'running') {
        machine.job.status = 'failed';
        machine.job.error = '控制面重启中断了任务，请先恢复任务';
        machine.job.needsRecovery = true;
        store.put('machine', machine);
      }
    }
  }
  machine(owner: string): ManagedMachine {
    const machine = this.store.list<ManagedMachine>('machine', owner)[0];
    if (!machine) {
      throw new HTTPError(409, '尚未创建开发机');
    }
    return machine;
  }
  workspaces(machine: Machine): Workspace[] {
    return this.store
      .list<Workspace>('workspace', machine.owner)
      .filter((w) => w.machineId === machine.id && !w.archived);
  }
  policy(machine: ManagedMachine): MachinePolicy {
    return machine.policy || { idleMinutes: 120, autoBackupHours: 0 };
  }
  assertAvailable(machine: ManagedMachine): void {
    if (machine.job?.needsRecovery) {
      throw new HTTPError(409, '开发机有中断的备份或恢复任务，请先恢复任务');
    }
  }
  view(machine?: ManagedMachine) {
    const job = machine?.job;
    return {
      policy: machine ? this.policy(machine) : { idleMinutes: 120, autoBackupHours: 0 },
      job: job && {
        action: job.action,
        status: job.status,
        error: job.error,
        needsRecovery: job.needsRecovery,
        startedAt: job.startedAt,
        finishedAt: job.finishedAt,
      },
    };
  }
  savePolicy(machine: ManagedMachine, input: Record<string, unknown>): MachinePolicy {
    const idleMinutes = Number(input.idleMinutes);
    const autoBackupHours = Number(input.autoBackupHours);
    if (
      !Number.isInteger(idleMinutes) ||
      idleMinutes < 0 ||
      idleMinutes > 10080 ||
      !Number.isInteger(autoBackupHours) ||
      autoBackupHours < 0 ||
      autoBackupHours > 168
    ) {
      throw new HTTPError(400, '空闲回收须为 0–10080 分钟，备份间隔须为 0–168 小时；0 表示关闭');
    }
    machine.policy = { idleMinutes, autoBackupHours };
    this.store.put('machine', machine);
    return machine.policy;
  }
  private backupFile(id: string): string {
    if (!/^[a-f0-9]{32}$/.test(id)) {
      throw new HTTPError(400, '备份标识无效');
    }
    return path.join(this.config.data, 'backups', `${id}.enc`);
  }
  private ownedBackup(machine: Machine, id: string): Backup {
    const backup = this.store.get<Backup>('backup', id);
    if (!backup || backup.owner !== machine.owner || backup.machineId !== machine.id) {
      throw new HTTPError(404, '备份不存在');
    }
    return backup;
  }
  private mark(machine: ManagedMachine, phase: string): void {
    machine.job!.phase = phase;
    this.store.put('machine', machine);
  }

  enqueue(
    machine: ManagedMachine,
    action: 'backup' | 'restore' | 'recover' | 'upgrade',
    backup?: Backup,
    name = '',
    automatic = false,
  ): void {
    if (action !== 'recover') {
      this.assertAvailable(machine);
    }
    if (action === 'recover' && !machine.job?.needsRecovery) {
      throw new HTTPError(409, '没有需要恢复的任务');
    }
    const workspaces = this.workspaces(machine);
    const previous = machine.job;
    const job: MachineJob =
      action === 'recover'
        ? { ...previous!, action, status: 'running', error: undefined }
        : {
            action,
            status: 'running',
            phase: 'stopping',
            startedAt: now(),
            resume: workspaces.filter((w) => w.status === 'ready').map((w) => w.id),
            previous: action === 'restore' ? workspaces : undefined,
          };
    const keys = workspaces.flatMap((w) => [`workspace:${w.id}`, `maven:${machine.id}`]);
    this.jobs.enqueue(
      machineKey(machine),
      'heavy',
      async () => {
        machine.job = job;
        this.store.put('machine', machine);
        if (action === 'recover') {
          await this.recover(machine);
        } else {
          for (const workspace of workspaces) {
            await this.driver.stop(workspace);
            workspace.status = 'stopped';
            workspace.op = undefined;
            this.store.put('workspace', workspace);
          }
          if (action === 'upgrade') {
            if (!this.driver.upgradeMachine) {
              throw new HTTPError(501, '当前运行环境不支持升级');
            }
            this.mark(machine, 'upgrading');
            await this.driver.upgradeMachine(machine);
            for (const workspace of workspaces) {
              workspace.envId = machine.envId;
              this.store.put('workspace', workspace);
            }
            this.mark(machine, 'committed');
          } else if (action === 'backup') {
            await this.backup(machine, name, automatic);
          } else {
            await this.restore(machine, backup!);
          }
        }
        const failures: string[] = [];
        for (const id of job.resume) {
          const workspace = this.store.get<Workspace>('workspace', id);
          if (workspace?.machineId !== machine.id || workspace.owner !== machine.owner) {
            continue;
          }
          try {
            await this.resume(workspace);
          } catch {
            workspace.status = 'failed';
            workspace.error = '备份或恢复已完成，IDE 重启失败，请重试启动';
            this.store.put('workspace', workspace);
            failures.push(id);
          }
        }
        job.status = failures.length ? 'failed' : 'done';
        job.error = failures.length ? '文件操作已完成，部分 IDE 未恢复就绪' : undefined;
        job.needsRecovery = false;
        job.finishedAt = now();
        this.store.put('machine', machine);
      },
      (error) => {
        job.status = 'failed';
        job.error = error.message;
        job.needsRecovery = true;
        job.finishedAt = now();
        machine.job = job;
        this.store.put('machine', machine);
      },
      keys,
    );
    machine.job = job;
    this.store.put('machine', machine);
  }

  private async stage<T>(task: (directory: string) => Promise<T>): Promise<T> {
    const root = path.join(this.config.data, 'backup-staging');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await mkdtemp(path.join(root, 'job-'));
    try {
      return await task(directory);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  private async backup(machine: ManagedMachine, name: string, automatic: boolean): Promise<void> {
    if (!this.driver.exportMachine) {
      throw new HTTPError(501, '当前运行环境不支持备份');
    }
    const id = newID();
    const filename = this.backupFile(id);
    await mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.mark(machine, 'exporting');
    try {
      await this.stage(async (stage) => {
        const archive = path.join(stage, 'machine.tgz');
        await this.driver.exportMachine!(machine, archive);
        const key = randomBytes(32);
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        const hash = createHash('sha256');
        await pipeline(
          createReadStream(archive),
          cipher,
          new Transform({
            transform(chunk, _encoding, done) {
              hash.update(chunk);
              done(null, chunk);
            },
          }),
          createWriteStream(filename, { flags: 'wx', mode: 0o600 }),
        );
        const backup: Backup = {
          id,
          owner: machine.owner,
          machineId: machine.id,
          name: name.trim().slice(0, 120) || (automatic ? '自动备份' : '开发机备份'),
          automatic,
          createdAt: now(),
          bytes: (await stat(filename)).size,
          sha256: hash.digest('hex'),
          workspaces: this.workspaces(machine),
        };
        this.store.transaction(() => {
          this.store.secret(`backup:${id}`, {
            key: key.toString('base64'),
            iv: iv.toString('base64'),
            tag: cipher.getAuthTag().toString('base64'),
          });
          this.store.put('backup', backup);
          machine.lastBackupAt = now();
          this.mark(machine, 'committed');
        });
      });
      const old = this.store
        .list<Backup>('backup', machine.owner)
        .filter((b) => b.machineId === machine.id && b.automatic)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        .slice(5);
      for (const backup of old) {
        await this.deleteBackup(machine, backup);
      }
    } catch (error) {
      if (!this.store.get('backup', id)) {
        await rm(filename, { force: true });
      }
      throw error;
    }
  }
  private async restore(machine: ManagedMachine, backup: Backup): Promise<void> {
    if (!this.driver.restoreMachine) {
      throw new HTTPError(501, '当前运行环境不支持恢复');
    }
    for (const workspace of backup.workspaces) {
      const project = this.store.get('project', workspace.projectId);
      const existing = this.store.get<Workspace>('workspace', workspace.id);
      if (
        project?.owner !== machine.owner ||
        workspace.owner !== machine.owner ||
        workspace.machineId !== machine.id ||
        (existing && (existing.owner !== machine.owner || existing.machineId !== machine.id))
      ) {
        throw new HTTPError(409, '备份所属项目或工作区已变更，不能覆盖当前记录');
      }
    }
    await this.stage(async (stage) => {
      const archive = path.join(stage, 'machine.tgz');
      const key = this.store.secret(`backup:${backup.id}`) as { key: string; iv: string; tag: string } | undefined;
      if (!key) {
        throw new HTTPError(409, '备份解密凭据不存在');
      }
      const checksum = createHash('sha256');
      for await (const chunk of createReadStream(this.backupFile(backup.id))) {
        checksum.update(chunk);
      }
      if (checksum.digest('hex') !== backup.sha256) {
        throw new HTTPError(409, '备份校验失败，保留当前文件');
      }
      const decipher = createDecipheriv('aes-256-gcm', Buffer.from(key.key, 'base64'), Buffer.from(key.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(key.tag, 'base64'));
      await pipeline(
        createReadStream(this.backupFile(backup.id)),
        decipher,
        createWriteStream(archive, { flags: 'wx', mode: 0o600 }),
      );
      await chmod(archive, 0o600);
      await this.driver.restoreMachine!(machine, 'stage', archive);
      this.mark(machine, 'applying');
      await this.driver.restoreMachine!(machine, 'apply');
      this.store.transaction(() => {
        this.replaceWorkspaces(machine, backup.workspaces);
        this.mark(machine, 'metadata');
      });
      this.mark(machine, 'committing');
      await this.driver.restoreMachine!(machine, 'commit');
      this.mark(machine, 'committed');
    });
  }
  private replaceWorkspaces(machine: Machine, workspaces: Workspace[]): void {
    for (const current of this.workspaces(machine)) {
      this.store.delete('workspace', current.id);
    }
    for (const workspace of workspaces) {
      this.store.put('workspace', {
        ...workspace,
        status: 'stopped',
        op: undefined,
        error: undefined,
        envId: machine.envId,
        mavenJob: undefined,
        updatedAt: now(),
      });
    }
  }
  private async recover(machine: ManagedMachine): Promise<void> {
    const job = machine.job!;
    for (const workspace of this.workspaces(machine)) {
      await this.driver.stop(workspace);
    }
    if (job.phase === 'upgrading') {
      if (!this.driver.upgradeMachine) {
        throw new HTTPError(501, '当前运行环境不支持升级');
      }
      await this.driver.upgradeMachine(machine);
      for (const workspace of this.workspaces(machine)) {
        workspace.envId = machine.envId;
        this.store.put('workspace', workspace);
      }
      this.mark(machine, 'committed');
      return;
    }
    if (job.phase === 'committing') {
      await this.driver.restoreMachine?.(machine, 'commit');
      this.mark(machine, 'committed');
    } else if (['applying', 'metadata'].includes(job.phase)) {
      if (!this.driver.restoreMachine) {
        throw new HTTPError(501, '当前运行环境不支持恢复');
      }
      await this.driver.restoreMachine(machine, 'rollback');
      this.store.transaction(() => {
        this.replaceWorkspaces(machine, job.previous || []);
        this.mark(machine, 'rolled-back');
      });
    } else if (job.phase !== 'committed') {
      await this.driver.restoreMachine?.(machine, 'rollback');
      this.mark(machine, 'rolled-back');
    }
  }
  private async deleteBackup(machine: Machine, backup: Backup): Promise<void> {
    this.ownedBackup(machine, backup.id);
    await rm(this.backupFile(backup.id), { force: true });
    this.store.transaction(() => {
      this.store.delete('backup', backup.id);
      this.store.db.prepare('DELETE FROM credentials WHERE owner=?').run(`backup:${backup.id}`);
    });
  }
  listBackups(owner: string) {
    const machine = this.machine(owner);
    return {
      backups: this.store
        .list<Backup>('backup', machine.owner)
        .filter((backup) => backup.machineId === machine.id)
        .map(({ workspaces: _workspaces, ...backup }) => publicEntity(backup))
        .sort((left, right) => String(right.createdAt).localeCompare(String(left.createdAt))),
      job: this.view(machine).job,
    };
  }
  async backupAction(owner: string, body: Record<string, unknown>) {
    const machine = this.machine(owner);
    if (body.action === 'delete') {
      this.assertAvailable(machine);
      await this.jobs.run([machineKey(machine)], () =>
        this.deleteBackup(machine, this.ownedBackup(machine, String(body.backupId))),
      );
      return { status: 200, body: { ok: true } };
    }
    if (!['backup', 'restore', 'recover'].includes(String(body.action))) {
      throw new HTTPError(400, '未知备份操作');
    }
    this.enqueue(
      machine,
      body.action as 'backup' | 'restore' | 'recover',
      body.action === 'restore' ? this.ownedBackup(machine, String(body.backupId)) : undefined,
      String(body.name || ''),
    );
    return { status: 202, body: this.view(machine).job };
  }
  start(): void {
    this.timer = setInterval(() => {
      if (!this.maintenance && !this.closing) {
        this.maintenance = this.tick()
          .catch(() => undefined)
          .finally(() => {
            this.maintenance = undefined;
          });
      }
    }, 60000);
    this.timer.unref();
  }
  async tick(timestamp = Date.now()): Promise<void> {
    for (const machine of this.store.list<ManagedMachine>('machine')) {
      if (this.closing || this.jobs.busy(machineKey(machine)) || machine.job?.needsRecovery) {
        continue;
      }
      const policy = this.policy(machine);
      const workspaces = this.workspaces(machine);
      for (const workspace of workspaces) {
        if (workspace.status !== 'ready' || !policy.idleMinutes || this.connected(workspace.id)) {
          continue;
        }
        const last = Date.parse(String(workspace.lastActivityAt || workspace.updatedAt));
        if (!Number.isFinite(last) || timestamp - last < policy.idleMinutes * 60000) {
          continue;
        }
        await this.jobs
          .run([machineKey(machine), `workspace:${workspace.id}`], async () => {
            if (this.connected(workspace.id) || !(await this.driver.inspect(workspace)).ideReady) {
              return;
            }
            await this.driver.stop(workspace);
            workspace.status = 'stopped';
            workspace.updatedAt = now();
            this.store.put('workspace', workspace);
          })
          .catch(() => undefined);
      }
      const stopped = this.workspaces(machine);
      if (
        policy.autoBackupHours &&
        stopped.length &&
        stopped.every((w) => w.status === 'stopped') &&
        timestamp - Date.parse(machine.lastBackupAt || machine.createdAt) >= policy.autoBackupHours * 3600000 &&
        timestamp - Date.parse(machine.lastBackupAttemptAt || machine.createdAt) >= 3600000
      ) {
        machine.lastBackupAttemptAt = new Date(timestamp).toISOString();
        this.store.put('machine', machine);
        try {
          this.enqueue(machine, 'backup', undefined, '', true);
        } catch {
          /* 限流结束后由下一轮维护任务重试。 */
        }
      }
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    clearInterval(this.timer);
    await this.maintenance;
  }
}
