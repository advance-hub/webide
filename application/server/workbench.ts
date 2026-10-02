import http from 'node:http';

import Koa from 'koa';

import { type Project, type Workspace } from './domain/models';
import { type RuntimeDriver } from './domain/runtime';
import { createHTTPApp } from './http/app';
import { IDEProxy } from './http/ide-proxy';
import { SandboxService } from './infrastructure/opensandbox';
import { AccessControl } from './modules/accounts/access';
import { GitControl } from './modules/git/control';
import { Machines } from './modules/machines/service';
import { Repositories } from './modules/projects/repositories';
import { DevelopmentResources } from './modules/resources/service';
import { WorkspaceOperations } from './modules/workspaces/operations';
import { WorkspaceSharing } from './modules/workspaces/sharing';
import { type Config } from './platform/config';
import { Jobs } from './platform/jobs';
import { Store } from './platform/store';
import { LocalRuntime } from './runtime/local';
import { SandboxRuntime } from './runtime/sandbox';

/** 唯一组装根：创建依赖、启动服务并按所有权顺序释放资源。 */
export class Workbench {
  readonly app: Koa;
  readonly store: Store;
  readonly repositories: Repositories;
  readonly resources: DevelopmentResources;
  readonly gitControl: GitControl;
  readonly machines: Machines;
  readonly jobs = new Jobs();
  readonly driver: RuntimeDriver;
  readonly server: http.Server;
  readonly sandbox?: SandboxService;
  readonly access: AccessControl;
  readonly ide: IDEProxy;
  readonly workspaces: WorkspaceOperations;
  readonly sharing: WorkspaceSharing;
  private closing = false;
  private shutdown?: Promise<void>;
  constructor(
    readonly config: Config,
    driverFactory?: (store: Store) => RuntimeDriver,
  ) {
    this.store = new Store(config.data);
    this.repositories = new Repositories(config, this.store);
    this.resources = new DevelopmentResources(config, this.store);
    this.sandbox = config.sandboxURL ? new SandboxService(config) : undefined;
    this.driver = driverFactory
      ? driverFactory(this.store)
      : config.driver === 'sandbox' && this.sandbox
        ? new SandboxRuntime(config, this.store, this.sandbox)
        : new LocalRuntime(config, this.store);
    if (config.driver !== this.driver.name) {
      this.store.close();
      throw new Error(`Runtime driver ${config.driver} is not configured`);
    }
    this.gitControl = new GitControl(config, this.store, this.repositories, this.driver, this.jobs);
    this.machines = new Machines(
      config,
      this.store,
      this.driver,
      this.jobs,
      (workspace) => this.workspaces.resumeWorkspace(workspace),
      (id) => this.ide.connected(id),
    );
    this.access = new AccessControl(config, this.store);
    this.sharing = new WorkspaceSharing(this.store, this.access);
    this.ide = new IDEProxy(config, this.store, this.driver, this.access);
    this.workspaces = new WorkspaceOperations(this);
    this.workspaces.recoverInterrupted();
    this.app = createHTTPApp(this, () => this.closing);
    this.server = http.createServer(this.app.callback());
    this.server.on('upgrade', (request, socket, head) => {
      if (this.closing) {
        socket.destroy();
        return;
      }
      void this.ide.upgrade(request, socket, head).catch(() => socket.destroy());
    });
  }
  project(id: string, owner: string): Project {
    return this.access.project(id, owner);
  }
  workspace(id: string, owner: string): Workspace {
    return this.access.workspace(id, owner);
  }
  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.port, this.config.host, resolve);
    });
    this.machines.start();
  }
  close(): Promise<void> {
    if (!this.shutdown) {
      this.closing = true;
      this.shutdown = this.closeOwners();
    }
    return this.shutdown;
  }
  private async closeOwners(): Promise<void> {
    await this.machines.close();
    this.ide.closeConnections();
    this.server.closeIdleConnections();
    for (const workspace of this.store.list<Workspace>('workspace')) {
      if (workspace.mavenJob && ['queued', 'running', 'cancelling'].includes(workspace.mavenJob.status)) {
        const queued = workspace.mavenJob.status === 'queued';
        workspace.mavenJob.status = 'cancelling';
        this.store.put('workspace', workspace);
        if (!queued && workspace.mavenJob.id) {
          await this.driver.helper(workspace, 'maven', { action: 'cancel', id: workspace.mavenJob.id }).catch(() => {});
        }
      }
    }
    await this.jobs.close();
    await this.driver.close();
    await this.sandbox?.close();
    if (this.server.listening) {
      await new Promise<void>((resolve, reject) => {
        const deadline = setTimeout(() => {
          this.server.closeAllConnections();
          this.ide.terminateConnections();
        }, 5000);
        deadline.unref();
        this.server.close((error) => {
          clearTimeout(deadline);
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      });
    }
    this.ide.dispose();
    this.store.close();
  }
}
