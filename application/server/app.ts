import { createReadStream } from 'node:fs';
import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';
import path from 'node:path';

import Router from '@koa/router';
import Koa from 'koa';
import serve from 'koa-static';
import WebSocket, { WebSocketServer } from 'ws';

import { type Config, HTTPError, requireString } from './config';
import { DockerEngine } from './docker';
import { type Connection, type Project, Repositories, type Workspace } from './git';
import { GitControl } from './git-control';
import { Jobs } from './jobs';
import { Machines } from './machines';
import { mavenKey, mavenRoutes } from './maven';
import { proxyTarget } from './proxy';
import { DevelopmentResources } from './resources';
import { LocalRuntime, type Machine, type RuntimeDriver, startupRecord } from './runtime';
import { SandboxService } from './sandbox';
import { sandboxRoutes } from './sandbox-routes';
import { SandboxRuntime } from './sandbox-runtime';
import { Store, hash, newID, now, publicEntity } from './store';

type Body = Record<string, unknown>;
interface Ticket {
  owner: string;
  workspace: string;
  expires: number;
}

function cookie(request: IncomingMessage, name: string): string {
  return (
    (request.headers.cookie || '')
      .split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${name}=`))
      ?.slice(name.length + 1) || ''
  );
}

export class Workbench {
  readonly app = new Koa();
  readonly store: Store;
  readonly repositories: Repositories;
  readonly resources: DevelopmentResources;
  readonly gitControl: GitControl;
  readonly machines: Machines;
  readonly jobs = new Jobs();
  readonly driver: RuntimeDriver;
  readonly server: http.Server;
  readonly sandbox?: SandboxService;
  private readonly tickets = new Map<string, Ticket>();
  private readonly ideSessions = new Map<string, Ticket>();
  private readonly websocketServer = new WebSocketServer({ noServer: true });
  private readonly sockets = new Map<string, Set<WebSocket>>();
  private closing = false;

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
      (workspace) => this.resumeWorkspace(workspace),
      (id) => !!this.sockets.get(id)?.size,
    );
    // Recover interrupted work as a visible failure, never as a fresh checkout.
    for (const workspace of this.store.list<Workspace>('workspace')) {
      if (workspace.mavenJob && ['queued', 'running', 'cancelling'].includes(workspace.mavenJob.status)) {
        workspace.mavenJob.status = 'failed';
        workspace.mavenJob.error = '控制面重启中断了任务，请检查任务日志后重试';
        workspace.mavenJob.finishedAt = now();
        this.store.put('workspace', workspace);
      }
      if (
        ['queued', 'preparing', 'starting', 'stopping', 'resetting', 'deleting', 'updating'].includes(workspace.status)
      ) {
        workspace.status = 'failed';
        workspace.op = undefined;
        workspace.error = '控制面重启中断了任务，请重试';
        this.store.put('workspace', workspace);
      }
    }
    this.routes();
    this.server = http.createServer(this.app.callback());
    this.server.on('upgrade', (request, socket, head) => {
      void this.upgrade(request, socket, head).catch(() => socket.destroy());
    });
  }

  owner(context: Koa.Context): string {
    if (this.config.localDemo) {
      return 'local-developer';
    }
    const owner = this.store.session(context.cookies.get('workbench_session') || '');
    if (!owner) {
      throw new HTTPError(401, '请先登录工作台');
    }
    return owner;
  }

  project(id: string, owner: string): Project {
    const project = this.store.get<Project>('project', id);
    if (!project || project.owner !== owner) {
      throw new HTTPError(404, '项目不存在');
    }
    return project;
  }
  workspace(id: string, owner: string): Workspace {
    const workspace = this.store.get<Workspace>('workspace', id);
    if (!workspace || workspace.owner !== owner) {
      throw new HTTPError(404, '工作区不存在');
    }
    return workspace;
  }

  isAdmin(owner: string): boolean {
    return this.config.localDemo || this.config.adminUsers.includes(owner);
  }

  private admin(context: Koa.Context): void {
    if (!this.isAdmin(context.state.owner)) {
      throw new HTTPError(403, '需要工作台管理员权限');
    }
  }

  private routes(): void {
    const router = new Router<{ owner: string; body: Body }>();
    const docker = new DockerEngine(this.config);
    this.app.use(async (context, next) => {
      context.set('X-Content-Type-Options', 'nosniff');
      try {
        if (this.closing) {
          throw new HTTPError(503, '服务正在关闭');
        }
        if (context.path.startsWith('/git/')) {
          await this.gitControl.bridge(context);
          return;
        }
        const workspaceId = this.workspaceHost(context.req);
        if (workspaceId) {
          await this.proxyIDE(context, workspaceId);
          return;
        }
        if (!['GET', 'HEAD', 'OPTIONS'].includes(context.method)) {
          const origin = context.get('Origin');
          if (
            origin &&
            origin !== new URL(this.config.publicURL).origin &&
            !((this.config.localDemo || process.env.WORKBENCH_DEV === '1') && origin === 'http://127.0.0.1:8792')
          ) {
            throw new HTTPError(403, '请求来源不匹配');
          }
          if (!context.is('application/json')) {
            throw new HTTPError(415, '需要 JSON 请求');
          }
          let body = '';
          for await (const chunk of context.req) {
            body += chunk.toString();
            if (Buffer.byteLength(body) > 1024 * 1024) {
              throw new HTTPError(413, '请求过大');
            }
          }
          try {
            context.state.body = JSON.parse(body || '{}');
          } catch {
            throw new HTTPError(400, 'JSON 请求无效');
          }
        }
        if (context.path.startsWith('/api/') && !['/api/config', '/api/login'].includes(context.path)) {
          context.state.owner = this.owner(context);
        }
        await next();
      } catch (error) {
        context.status = error instanceof HTTPError ? error.status : 500;
        context.body = { error: (error as Error).message };
      }
    });

    router.get('/healthz', (context) => {
      context.body = { status: 'ok', runtime: 'node', node: process.version, driver: this.driver.name };
    });
    router.get('/api/config', (context) => {
      context.body = {
        gitlabURL: this.repositories.connection('local-developer').url,
        localDemo: this.config.localDemo,
        driver: this.driver.name,
        sandboxAdmin: !!this.config.sandboxURL,
      };
    });
    router.post('/api/login', async (context) => {
      let owner = 'local-developer';
      let name = '本地开发者';
      if (!this.config.localDemo) {
        const token = requireString(context.state.body.token, '令牌', 4000);
        const user = await this.verifyConnection({ url: this.config.gitlabURL, token });
        owner = `${this.config.gitlabURL}:${user.id}`;
        name = user.name;
        this.store.put('user', { id: owner, owner, name });
      }
      context.cookies.set('workbench_session', this.store.createSession(owner), {
        httpOnly: true,
        sameSite: 'strict',
        secure: this.config.publicURL.startsWith('https:'),
        maxAge: 86400000,
      });
      context.body = { id: hash(owner), name, mode: this.config.localDemo ? 'demo' : 'gitlab' };
    });
    router.get('/api/me', (context) => {
      const owner = context.state.owner;
      context.body = {
        id: hash(owner),
        name: this.store.get('user', owner)?.name || '本地开发者',
        mode: this.config.localDemo ? 'demo' : 'gitlab',
      };
    });
    router.post('/api/logout', (context) => {
      this.store.revoke(context.cookies.get('workbench_session') || '');
      context.cookies.set('workbench_session', '', { maxAge: 0 });
      context.body = { ok: true };
    });
    router.get('/api/catalog', (context) => {
      context.body = {
        environment: {
          driver: this.driver.name,
          imageConfigured: !!this.config.sandboxImage,
          cpu: this.config.sandboxCPU,
          memory: this.config.sandboxMemory,
          storageClass: this.config.storageClass,
          storageMode: this.driver.name === 'local' ? 'host' : this.config.storageMode,
        },
      };
    });
    router.get('/api/runtime', async (context) => {
      if (this.driver.name === 'sandbox') {
        await this.sandbox!.health();
      }
      context.body = { status: 'connected', driver: this.driver.name, node: process.version };
    });
    router.get('/api/images', async (context) => {
      const images = await docker.images();
      if (this.sandbox) {
        for (const sandbox of await this.sandbox.list()) {
          const image = images.find((item) => item.tags.includes(sandbox.image?.uri || ''));
          if (image) {
            image.inUse++;
          }
        }
      }
      context.body = { images };
    });
    router.post('/api/images/:reference/delete', async (context) => {
      this.admin(context);
      const reference = String(context.params.reference);
      if (this.sandbox && (await this.sandbox.list()).some((info) => info.image?.uri === reference)) {
        throw new HTTPError(409, '镜像仍关联运行环境');
      }
      await docker.removeImage(reference);
      context.body = { ok: true };
    });

    router.get('/api/connections/gitlab', (context) => {
      const project = context.query.projectId
        ? this.project(String(context.query.projectId), context.state.owner)
        : undefined;
      const connection = this.repositories.connection(context.state.owner, project);
      context.body = {
        url: connection.url,
        configured: !!connection.token,
        account: context.state.owner,
        provider: connection.provider,
        gitAccount: connection.account,
        inherited: !!project && !this.store.secret(`project:${project.id}`),
        canManage: !!project || this.isAdmin(context.state.owner),
      };
    });
    router.post('/api/connections/gitlab', async (context) => {
      const project = context.query.projectId
        ? this.project(String(context.query.projectId), context.state.owner)
        : undefined;
      const body = context.state.body;
      if (!project) {
        this.admin(context);
      }
      if (project && body.inherit) {
        this.store.db.prepare('DELETE FROM credentials WHERE owner=?').run(`project:${project.id}`);
        context.body = { ok: true };
        return;
      }
      const url = requireString(body.url, '代码源地址', 2000);
      const previous = this.repositories.connection(context.state.owner, project);
      const token =
        typeof body.token === 'string' && body.token ? body.token : previous.url === url ? previous.token : undefined;
      if (!token) {
        throw new HTTPError(400, '请填写代码源令牌');
      }
      const providerValue = body.provider || (previous.url === url ? previous.provider : undefined);
      if (
        providerValue &&
        (typeof providerValue !== 'string' || !['gitlab', 'github', 'gitee'].includes(providerValue))
      ) {
        throw new HTTPError(400, '代码源类型无效');
      }
      const provider = providerValue as Connection['provider'];
      const connection: Connection = {
        url,
        token,
        provider,
        account:
          typeof body.account === 'string'
            ? requireString(body.account, 'Git 账户', 200)
            : previous.url === url
              ? previous.account
              : undefined,
      };
      await this.verifyConnection(connection);
      this.store.secret(project ? `project:${project.id}` : 'connection:global', connection);
      context.body = { ok: true };
    });

    router.get('/api/projects', (context) => {
      context.body = this.store.list<Project>('project', context.state.owner).map(publicEntity);
    });
    router.post('/api/projects', async (context) => {
      const body = context.state.body;
      const project: Project = {
        id: newID(),
        owner: context.state.owner,
        name: requireString(body.name || path.basename(String(body.url)).replace(/\.git$/, ''), '项目名', 120),
        url: this.repositories.validateURL(body.url),
        branch: await this.repositories.validateBranch(body.branch || 'main'),
        sha: '',
        status: 'queued',
        createdAt: now(),
      };
      if (body.connection) {
        const connection = body.connection as Connection;
        await this.verifyConnection(connection);
        this.store.secret(`project:${project.id}`, connection);
      }
      this.store.put('project', project);
      this.importProject(project);
      context.status = 202;
      context.body = publicEntity(project);
    });
    router.get('/api/projects/:id/branches', async (context) => {
      const branches = await this.repositories.branches(this.project(String(context.params.id), context.state.owner));
      context.body = { branches, truncated: branches.length >= 1000 };
    });
    router.get('/api/projects/:id/repository', async (context) => {
      context.body = await this.repositories.browse(
        this.project(String(context.params.id), context.state.owner),
        String(context.query.path || ''),
      );
    });
    router.get('/api/projects/:id/commits', async (context) => {
      context.body = await this.repositories.commits(this.project(String(context.params.id), context.state.owner));
    });
    router.post('/api/projects/:id/retry', (context) => {
      const project = this.project(String(context.params.id), context.state.owner);
      this.importProject(project);
      context.status = 202;
      context.body = publicEntity(project);
    });
    router.post('/api/projects/:id/baseline', async (context) => {
      const project = this.project(String(context.params.id), context.state.owner);
      const body = context.state.body;
      if (body.expectedSha !== project.sha) {
        throw new HTTPError(409, '基线已更新，请刷新页面');
      }
      const branch = await this.repositories.validateBranch(body.branch || project.branch);
      if (body.sha && !/^[a-f0-9]{40}$/.test(String(body.sha))) {
        throw new HTTPError(400, '需要完整提交 SHA');
      }
      this.jobs.enqueue(
        `project:${project.id}`,
        'heavy',
        async () => {
          const latest = await this.repositories.fetch(project, branch);
          const sha = String(body.sha || latest);
          await this.repositories.git(project, ['cat-file', '-e', `${sha}^{commit}`]);
          await this.repositories.pin(project, branch, sha);
          project.baselineStatus = 'ready';
          project.baselineError = undefined;
          project.baselineUpdatedAt = now();
          this.store.put('project', project);
        },
        (error) => {
          project.baselineStatus = 'failed';
          project.baselineError = error.message;
          this.store.put('project', project);
        },
      );
      project.baselineStatus = 'queued';
      this.store.put('project', project);
      context.status = 202;
      context.body = publicEntity(project);
    });

    router.get('/api/workspaces', (context) => {
      context.body = this.store
        .list<Workspace>('workspace', context.state.owner)
        .filter((w) => !w.archived)
        .map((w) => ({
          ...publicEntity(w),
          projectName: this.store.get<Project>('project', w.projectId)?.name,
          ownerName: this.store.get('user', w.owner)?.name || '本地开发者',
        }));
    });
    router.post('/api/workspaces', async (context) => {
      const body = context.state.body;
      const project = this.project(String(body.projectId), context.state.owner);
      if (project.status !== 'ready') {
        throw new HTTPError(409, '项目还未导入完成');
      }
      const branch = await this.repositories.validateBranch(body.branch || project.branch);
      const existing = this.store
        .list<Workspace>('workspace', context.state.owner)
        .find((w) => w.projectId === project.id && w.branch === branch && !w.archived);
      if (existing) {
        context.body = publicEntity(existing);
        return;
      }
      const baseBranch = body.baseBranch ? await this.repositories.validateBranch(body.baseBranch) : undefined;
      const workspace = this.store.transaction(() => {
        let machine = this.store.list<Machine>('machine', context.state.owner)[0];
        if (!machine) {
          if (this.store.list('machine').length >= this.config.machineLimit) {
            throw new HTTPError(409, '个人开发机配额已满');
          }
          machine = this.store.put<Machine>('machine', {
            id: newID(),
            owner: context.state.owner,
            driver: this.driver.name,
            createdAt: now(),
          });
        }
        const occupied = new Set(
          this.store
            .list<Workspace>('workspace')
            .filter((item) => item.machineId === machine.id)
            .map((item) => item.idePort),
        );
        let idePort = 12000;
        while (occupied.has(idePort)) {
          idePort++;
        }
        if (idePort > 12999) {
          throw new HTTPError(409, '开发机工作区端口已满');
        }
        return this.store.put<Workspace>('workspace', {
          id: newID(),
          owner: context.state.owner,
          projectId: project.id,
          branch,
          baseBranch,
          machineId: machine.id,
          idePort,
          driver: this.driver.name,
          status: 'queued',
          createdAt: now(),
          updatedAt: now(),
        });
      });
      this.lifecycle(workspace, 'start');
      context.status = 202;
      context.body = publicEntity(workspace);
    });
    router.get('/api/workspaces/:id/environment', async (context) => {
      const workspace = this.workspace(String(context.params.id), context.state.owner);
      const { headers: _headers, ...environment } = await this.driver.inspect(workspace);
      context.body = { ...environment, workspace: publicEntity(workspace) };
    });
    router.post('/api/workspaces/:id/enter', async (context) => {
      const workspace = this.workspace(String(context.params.id), context.state.owner);
      if (workspace.status !== 'ready' || !(await this.driver.inspect(workspace)).ideReady) {
        throw new HTTPError(409, 'IDE 未就绪，请启动或重启工作区');
      }
      const ticket = newID() + newID();
      this.tickets.set(hash(ticket), { owner: workspace.owner, workspace: workspace.id, expires: Date.now() + 60000 });
      const address = new URL(this.config.publicURL);
      address.hostname = `${workspace.id}.${this.config.ideHost}`;
      address.searchParams.set('ticket', ticket);
      context.body = { url: address.href };
    });
    for (const action of ['start', 'stop', 'restart', 'reset', 'delete', 'update-runtime']) {
      router.post(`/api/workspaces/:id/${action}`, (context) => {
        const workspace = this.workspace(String(context.params.id), context.state.owner);
        if (
          action === 'reset' &&
          context.state.body.branch !== workspace.branch &&
          context.state.body.confirm !== workspace.branch
        ) {
          throw new HTTPError(400, '请确认工作区分支名');
        }
        if (action === 'update-runtime') {
          this.machines.enqueue(this.machines.machine(workspace.owner), 'upgrade');
          context.status = 202;
          context.body = { ...publicEntity(workspace), status: 'updating' };
          return;
        }
        this.lifecycle(workspace, action);
        context.status = 202;
        context.body = publicEntity(workspace);
      });
    }
    router.post('/api/workspaces/:id/git', async (context) => {
      const workspace = this.workspace(String(context.params.id), context.state.owner);
      this.machines.assertAvailable(this.machines.machine(workspace.owner));
      context.body = await this.jobs.run([`workspace:${workspace.id}`, `machine:${workspace.machineId}`], () =>
        this.driver.helper(workspace, 'git', context.state.body),
      );
    });
    router.post('/api/workspaces/:id/publish', async (context) => {
      const workspace = this.workspace(String(context.params.id), context.state.owner);
      this.machines.assertAvailable(this.machines.machine(workspace.owner));
      context.body = await this.gitControl.publish(
        workspace,
        this.project(workspace.projectId, workspace.owner),
        context.state.body,
      );
    });
    router.post('/api/workspaces/:id/editor-connections', async (context) => {
      const workspace = this.workspace(String(context.params.id), context.state.owner);
      this.machines.assertAvailable(this.machines.machine(workspace.owner));
      context.body = await this.jobs.run([`workspace:${workspace.id}`, `machine:${workspace.machineId}`], async () => {
        await this.resources.sync(workspace, this.driver);
        return startupRecord(workspace).editorConnections;
      });
    });
    router.get('/api/workspaces/:id/services', async (context) => {
      context.body = await this.driver.helper(
        this.workspace(String(context.params.id), context.state.owner),
        'services',
        { action: 'status' },
      );
    });
    router.post('/api/workspaces/:id/services', async (context) => {
      const workspace = this.workspace(String(context.params.id), context.state.owner);
      this.machines.assertAvailable(this.machines.machine(workspace.owner));
      context.body = await this.jobs.run([`workspace:${workspace.id}`, `machine:${workspace.machineId}`], () =>
        this.driver.helper(workspace, 'services', context.state.body),
      );
    });
    router.post('/api/workspaces/:id/maven-config', async (context) => {
      const workspace = this.workspace(String(context.params.id), context.state.owner);
      this.machines.assertAvailable(this.machines.machine(workspace.owner));
      context.body = await this.jobs.run([`workspace:${workspace.id}`, `machine:${workspace.machineId}`], () =>
        this.driver.helper(workspace, 'maven-config', context.state.body),
      );
    });

    router.get('/api/machine', (context) => {
      const machine = this.store.list<Machine>('machine', context.state.owner)[0];
      context.body = {
        machine: machine ? publicEntity(machine) : null,
        allocated: this.store.list('machine').length,
        limit: this.config.machineLimit,
        workspaces: this.store.list<Workspace>('workspace', context.state.owner).filter((w) => !w.archived).length,
        legacyWorkspaces: 0,
        ...this.machines.view(machine),
      };
    });
    router.post('/api/machine/release', async (context) => {
      if (this.store.list<Workspace>('workspace', context.state.owner).some((w) => !w.archived)) {
        throw new HTTPError(409, '请先删除开发机上的工作区');
      }
      const machine = this.store.list<Machine>('machine', context.state.owner)[0];
      if (machine) {
        this.machines.assertAvailable(machine);
        await this.jobs.run([`machine:${machine.id}`], async () => {
          await this.driver.release(machine);
          this.store.delete('machine', machine.id);
        });
      }
      context.body = { ok: true };
    });
    router.post('/api/machine/tools', async (context) => {
      const machine = this.machines.machine(context.state.owner);
      this.machines.assertAvailable(machine);
      if (context.state.body.action === 'policy-save') {
        context.body = await this.jobs.run([`machine:${machine.id}`], async () =>
          this.machines.savePolicy(machine, context.state.body),
        );
        return;
      }
      const workspace = this.store.list<Workspace>('workspace', context.state.owner).find((w) => !w.archived);
      if (!workspace) {
        throw new HTTPError(409, '尚未创建工作区');
      }
      const body = context.state.body;
      const action = String(body.action || 'inspect');
      context.body = await this.jobs.run([`machine:${machine.id}`], () =>
        this.driver.helper(workspace, action.startsWith('preferences-') ? 'preferences' : 'machine', {
          ...body,
          action: action.replace('preferences-', ''),
        }),
      );
    });
    sandboxRoutes(router, this.sandbox, this.store, (context) => this.admin(context));
    this.resources.routes(router);
    this.machines.routes(router);
    mavenRoutes(router, this.store, this.driver, this.jobs, (id, owner) => this.workspace(id, owner));
    this.app.use(router.routes()).use(router.allowedMethods());
    this.app.use(serve(path.join(this.config.root, 'application/dist')));
    this.app.use((context, next) => {
      if (
        ['GET', 'HEAD'].includes(context.method) &&
        /^\/(?:dashboard|images|development-resources|projects(?:\/[a-f0-9]{32})?|workspaces|environment|sandbox-admin|connection|import)\/?$/.test(
          context.path,
        )
      ) {
        context.type = 'html';
        context.body = createReadStream(path.join(this.config.root, 'application/dist/index.html'));
        return;
      }
      return next();
    });
    this.app.use((context) => {
      context.status = 404;
      context.body = { error: '接口或资源不存在' };
    });
  }

  private importProject(project: Project): void {
    this.jobs.enqueue(
      `project:${project.id}`,
      'heavy',
      async () => {
        project.status = 'preparing';
        this.store.put('project', project);
        await this.repositories.import(project);
      },
      (error) => {
        project.status = 'failed';
        project.error = error.message;
        this.store.put('project', project);
      },
    );
    project.status = 'queued';
    project.error = undefined;
    this.store.put('project', project);
  }

  private lifecycle(workspace: Workspace, action: string): void {
    const ownerMachine = this.store.get<Machine>('machine', String(workspace.machineId));
    if (ownerMachine) {
      this.machines.assertAvailable(ownerMachine);
    }
    if (this.jobs.busy(mavenKey(workspace))) {
      throw new HTTPError(409, '开发机有 Maven 任务，请先结束或取消任务');
    }
    const states: Record<string, string> = {
      start: 'starting',
      stop: 'stopping',
      restart: 'starting',
      reset: 'resetting',
      delete: 'deleting',
    };
    this.jobs.enqueue(
      `workspace:${workspace.id}`,
      ['stop', 'restart', 'delete'].includes(action) ? 'quick' : 'heavy',
      async () => {
        const project = this.project(workspace.projectId, workspace.owner);
        if (['stop', 'restart', 'reset', 'delete'].includes(action)) {
          await this.driver.stop(workspace);
        }
        if (action === 'delete') {
          await this.driver.remove(workspace, project, this.repositories);
          this.store.delete('workspace', workspace.id);
          return;
        }
        if (action === 'stop') {
          workspace.status = 'stopped';
          workspace.op = undefined;
          workspace.updatedAt = now();
          this.store.put('workspace', workspace);
          return;
        }
        const machine = this.store.get<Machine>('machine', String(workspace.machineId));
        if (!machine) {
          throw new Error('开发机记录不存在');
        }
        await this.repositories.pinWorkspace(project, workspace);
        await this.driver.provision(machine);
        workspace.envId = machine.envId;
        this.store.put('workspace', workspace);
        await this.driver.prepare(workspace, project, this.repositories, action === 'reset');
        await this.gitControl.install(workspace, project);
        await this.driver.start(workspace);
        try {
          await this.resources.sync(workspace, this.driver);
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
        this.store.put('workspace', workspace);
      },
      (error) => {
        workspace.status = 'failed';
        workspace.error = error.message;
        workspace.op = undefined;
        workspace.updatedAt = now();
        this.store.put('workspace', workspace);
      },
      [`machine:${workspace.machineId}`],
    );
    workspace.status = states[action];
    workspace.op = action;
    workspace.error = undefined;
    workspace.updatedAt = now();
    this.store.put('workspace', workspace);
  }

  private async resumeWorkspace(workspace: Workspace): Promise<void> {
    const machine = this.store.get<Machine>('machine', String(workspace.machineId));
    if (!machine) {
      throw new HTTPError(409, '开发机不存在');
    }
    const project = this.project(workspace.projectId, workspace.owner);
    await this.driver.provision(machine);
    workspace.envId = machine.envId;
    await this.driver.prepare(workspace, project, this.repositories);
    await this.gitControl.install(workspace, project);
    await this.driver.start(workspace);
    await this.resources.sync(workspace, this.driver).catch(() => undefined);
    workspace.status = 'ready';
    workspace.op = undefined;
    workspace.error = undefined;
    workspace.updatedAt = now();
    this.store.put('workspace', workspace);
  }

  private async verifyConnection(connection: Connection): Promise<{ id: string; name: string }> {
    const url = new URL(requireString(connection.url, '代码源地址', 2000));
    if (url.username || url.password || url.search || url.hash || !['https:', 'http:'].includes(url.protocol)) {
      throw new HTTPError(400, '代码源地址无效');
    }
    if (url.protocol === 'http:' && !this.config.localDemo && process.env.GITLAB_ALLOW_HTTP !== '1') {
      throw new HTTPError(400, '代码源需要 HTTPS');
    }
    const provider =
      connection.provider || (/gitee/i.test(url.host) ? 'gitee' : url.hostname === 'github.com' ? 'github' : 'gitlab');
    if (!['gitlab', 'github', 'gitee'].includes(provider)) {
      throw new HTTPError(400, '代码源类型无效');
    }
    const endpoint =
      provider === 'github'
        ? url.hostname === 'github.com'
          ? 'https://api.github.com/user'
          : `${url.href.replace(/\/$/, '')}/api/v3/user`
        : `${url.href.replace(/\/$/, '')}/api/${provider === 'gitee' ? 'v5' : 'v4'}/user`;
    const headers: Record<string, string> =
      provider === 'gitlab'
        ? { 'PRIVATE-TOKEN': connection.token || '' }
        : { Authorization: `Bearer ${connection.token || ''}` };
    const response = await fetch(endpoint, { headers, redirect: 'error', signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      throw new HTTPError(400, `代码源验证失败 (${response.status})`);
    }
    const user = (await response.json()) as { id: string; name?: string; username?: string; login?: string };
    return { id: String(user.id), name: user.name || user.username || user.login || String(user.id) };
  }

  private workspaceHost(request: IncomingMessage): string | undefined {
    const hostname = (request.headers.host || '').split(':')[0];
    const id = hostname.split('.')[0];
    return /^[a-f0-9]{32}$/.test(id) && hostname.endsWith(`.${this.config.ideHost}`) ? id : undefined;
  }

  private ideAuthorization(request: IncomingMessage, id: string): Ticket {
    const session = this.ideSessions.get(hash(cookie(request, 'ide_session')));
    if (!session || session.workspace !== id || session.expires < Date.now()) {
      throw new HTTPError(401, 'IDE 会话已过期，请从工作台重新进入');
    }
    this.workspace(id, session.owner);
    return session;
  }

  private async proxyIDE(context: Koa.Context, id: string): Promise<void> {
    const ticketValue = context.query.ticket;
    if (typeof ticketValue === 'string') {
      const key = hash(ticketValue);
      const ticket = this.tickets.get(key);
      this.tickets.delete(key);
      if (!ticket || ticket.workspace !== id || ticket.expires < Date.now()) {
        throw new HTTPError(401, '入口票据无效或已过期');
      }
      this.workspace(id, ticket.owner);
      const token = newID() + newID();
      this.ideSessions.set(hash(token), { ...ticket, expires: Date.now() + 8 * 60 * 60 * 1000 });
      context.cookies.set('ide_session', token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: this.config.publicURL.startsWith('https:'),
        maxAge: 8 * 60 * 60 * 1000,
      });
      context.redirect('/');
      return;
    }
    const session = this.ideAuthorization(context.req, id);
    const workspace = this.workspace(id, session.owner);
    workspace.lastActivityAt = now();
    this.store.put('workspace', workspace);
    const environment = await this.driver.inspect(workspace);
    if (!environment.ideReady || !environment.endpoint) {
      throw new HTTPError(502, 'IDE 未就绪');
    }
    const target = proxyTarget(String(environment.endpoint), context.originalUrl);
    const headers: http.OutgoingHttpHeaders = { ...context.headers, host: target.host };
    delete headers.cookie;
    delete headers.authorization;
    for (const [key, value] of Object.entries(environment.headers || {})) {
      headers[key.toLowerCase()] = value;
    }
    headers['x-workspace-id'] = id;
    context.respond = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const proxy = (target.protocol === 'https:' ? https : http).request(
          target,
          { method: context.method, headers },
          (response) => {
            context.res.writeHead(response.statusCode || 502, response.headers);
            response.pipe(context.res);
            response.once('end', resolve);
          },
        );
        proxy.once('error', reject);
        proxy.setTimeout(30000, () => proxy.destroy(new Error('IDE request timed out')));
        context.req.once('aborted', () => proxy.destroy());
        context.req.pipe(proxy);
      });
    } catch (error) {
      if (!context.res.headersSent) {
        context.respond = true;
        throw new HTTPError(502, 'IDE 代理连接失败');
      }
      context.res.destroy(error instanceof Error ? error : undefined);
    }
  }

  private async upgrade(request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): Promise<void> {
    const id = this.workspaceHost(request);
    if (!id) {
      socket.destroy();
      return;
    }
    const origin = request.headers.origin;
    const expected = `${new URL(this.config.publicURL).protocol}//${request.headers.host}`;
    if (origin && origin !== expected) {
      socket.destroy();
      return;
    }
    const session = this.ideAuthorization(request, id);
    const workspace = this.workspace(id, session.owner);
    workspace.lastActivityAt = now();
    this.store.put('workspace', workspace);
    const environment = await this.driver.inspect(workspace);
    if (!environment.ideReady || !environment.endpoint) {
      socket.destroy();
      return;
    }
    const connections = this.sockets.get(id) || new Set<WebSocket>();
    if (connections.size >= 8 || [...this.sockets.values()].reduce((n, s) => n + s.size, 0) >= 80) {
      socket.destroy();
      return;
    }
    const target = proxyTarget(String(environment.endpoint), request.url || '/');
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    const upstream = new WebSocket(target, {
      headers: { ...environment.headers, 'X-Workspace-Id': id },
      handshakeTimeout: 10000,
    });
    connections.add(upstream);
    this.sockets.set(id, connections);
    upstream.once('close', () => connections.delete(upstream));
    upstream.once('error', () => {
      connections.delete(upstream);
      socket.destroy();
    });
    socket.once('close', () => {
      if (upstream.readyState === WebSocket.CONNECTING) {
        upstream.terminate();
      }
    });
    upstream.once('open', () => {
      this.websocketServer.handleUpgrade(request, socket, head, (client) => {
        connections.delete(upstream);
        connections.add(client);
        this.sockets.set(id, connections);
        client.on('message', (data, binary) => {
          if (upstream.readyState === WebSocket.OPEN) {
            upstream.send(data, { binary });
          }
        });
        upstream.on('message', (data, binary) => {
          if (client.readyState === WebSocket.OPEN) {
            client.send(data, { binary });
          }
        });
        client.once('close', () => {
          connections.delete(client);
          upstream.close();
        });
        upstream.once('close', () => client.close());
        upstream.on('error', () => client.close(1011));
        client.on('error', () => upstream.close());
      });
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.port, this.config.host, resolve);
    });
    this.machines.start();
  }
  async close(): Promise<void> {
    if (this.closing) {
      return;
    }
    this.closing = true;
    await this.machines.close();
    for (const connections of this.sockets.values()) {
      for (const socket of connections) {
        socket.close(1001, 'Control plane stopping');
      }
    }
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
          for (const connections of this.sockets.values()) {
            for (const socket of connections) {
              socket.terminate();
            }
          }
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
    this.websocketServer.close();
    this.store.close();
  }
}
