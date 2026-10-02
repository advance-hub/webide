import { type Project, type Workspace } from '../../domain/models';
import { mavenKey } from '../../domain/resource-keys';
import { type Machine, startupRecord } from '../../domain/runtime';
import { now } from '../../platform/store';
import { HTTPError } from '../../platform/validation';

import type { WorkspaceServices } from './context';

/** 生命周期任务在资源锁内执行，状态写入仍沿用原有持久化协议。 */
export class WorkspaceOperations {
  constructor(readonly services: WorkspaceServices) {}
  recoverInterrupted(): void {
    // 将中断的任务恢复为可见失败，不能当作全新检出处理。
    for (const workspace of this.services.store.list<Workspace>('workspace')) {
      if (workspace.mavenJob && ['queued', 'running', 'cancelling'].includes(workspace.mavenJob.status)) {
        workspace.mavenJob.status = 'failed';
        workspace.mavenJob.error = '控制面重启中断了任务，请检查任务日志后重试';
        workspace.mavenJob.finishedAt = now();
        this.services.store.put('workspace', workspace);
      }
      if (
        ['queued', 'preparing', 'starting', 'stopping', 'resetting', 'deleting', 'updating'].includes(workspace.status)
      ) {
        workspace.status = 'failed';
        workspace.op = undefined;
        workspace.error = '控制面重启中断了任务，请重试';
        this.services.store.put('workspace', workspace);
      }
    }
  }
  importProject(project: Project): void {
    this.services.jobs.enqueue(
      `project:${project.id}`,
      'heavy',
      async () => {
        project.status = 'preparing';
        this.services.store.put('project', project);
        await this.services.repositories.import(project);
      },
      (error) => {
        project.status = 'failed';
        project.error = error.message;
        this.services.store.put('project', project);
      },
    );
    project.status = 'queued';
    project.error = undefined;
    this.services.store.put('project', project);
  }

  lifecycle(workspace: Workspace, action: string): void {
    const ownerMachine = this.services.store.get<Machine>('machine', String(workspace.machineId));
    if (ownerMachine) {
      this.services.machines.assertAvailable(ownerMachine);
    }
    if (this.services.jobs.busy(mavenKey(workspace))) {
      throw new HTTPError(409, '开发机有 Maven 任务，请先结束或取消任务');
    }
    const states: Record<string, string> = {
      start: 'starting',
      stop: 'stopping',
      restart: 'starting',
      reset: 'resetting',
      delete: 'deleting',
    };
    this.services.jobs.enqueue(
      `workspace:${workspace.id}`,
      ['stop', 'restart', 'delete'].includes(action) ? 'quick' : 'heavy',
      async () => {
        const project = this.services.access.project(workspace.projectId, workspace.owner);
        if (['stop', 'restart', 'reset', 'delete'].includes(action)) {
          await this.services.driver.stop(workspace);
        }
        if (action === 'delete') {
          await this.services.driver.remove(workspace, project, this.services.repositories);
          this.services.store.delete('workspace', workspace.id);
          this.services.store.db.prepare('DELETE FROM credentials WHERE owner=?').run(`runtime:${workspace.id}`);
          return;
        }
        if (action === 'stop') {
          workspace.status = 'stopped';
          workspace.op = undefined;
          workspace.updatedAt = now();
          this.services.store.put('workspace', workspace);
          return;
        }
        const machine = this.services.store.get<Machine>('machine', String(workspace.machineId));
        if (!machine) {
          throw new Error('开发机记录不存在');
        }
        await this.services.repositories.pinWorkspace(project, workspace);
        await this.services.driver.provision(machine);
        workspace.envId = machine.envId;
        this.services.store.put('workspace', workspace);
        await this.services.driver.prepare(workspace, project, this.services.repositories, action === 'reset');
        await this.services.gitControl.install(workspace, project);
        await this.services.driver.start(workspace);
        try {
          await this.services.resources.sync(workspace, this.services.driver);
        } catch {
          startupRecord(workspace).editorConnections = {
            mysql: false,
            redis: false,
            additionalDatabases: 0,
            error: '编辑器资源连接同步失败，请重试',
          };
        }
        workspace.status = 'ready';
        workspace.op = undefined;
        workspace.error = undefined;
        workspace.updatedAt = now();
        this.services.store.put('workspace', workspace);
      },
      (error) => {
        workspace.status = 'failed';
        workspace.error = error.message;
        workspace.op = undefined;
        workspace.updatedAt = now();
        this.services.store.put('workspace', workspace);
      },
      [`machine:${workspace.machineId}`],
    );
    workspace.status = states[action];
    workspace.op = action;
    workspace.error = undefined;
    workspace.updatedAt = now();
    this.services.store.put('workspace', workspace);
  }

  async resumeWorkspace(workspace: Workspace): Promise<void> {
    const machine = this.services.store.get<Machine>('machine', String(workspace.machineId));
    if (!machine) {
      throw new HTTPError(409, '开发机不存在');
    }
    const project = this.services.access.project(workspace.projectId, workspace.owner);
    await this.services.driver.provision(machine);
    workspace.envId = machine.envId;
    await this.services.driver.prepare(workspace, project, this.services.repositories);
    await this.services.gitControl.install(workspace, project);
    await this.services.driver.start(workspace);
    await this.services.resources.sync(workspace, this.services.driver).catch(() => undefined);
    workspace.status = 'ready';
    workspace.op = undefined;
    workspace.error = undefined;
    workspace.updatedAt = now();
    this.services.store.put('workspace', workspace);
  }
}
