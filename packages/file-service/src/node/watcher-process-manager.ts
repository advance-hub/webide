import { ChildProcess, fork } from 'child_process';
import { existsSync } from 'fs';
import { Server, Socket, createServer } from 'net';
import path from 'path';

import { Autowired, Injectable } from '@opensumi/di';
import { NetSocketConnection, SumiConnectionMultiplexer } from '@opensumi/ide-connection';
import {
  DidFilesChangedParams,
  FileSystemWatcherClient,
  FileWatcherFailureParams,
  FileWatcherOverflowParams,
  RecursiveWatcherBackend,
} from '@opensumi/ide-core-common/file-watch';
import { ILogServiceManager, SupportLogNamespace } from '@opensumi/ide-core-common/log';
import { normalizedIpcHandlerPathAsync } from '@opensumi/ide-core-common/node/ipc';
import { AppConfig, Deferred, ILogService, UriComponents } from '@opensumi/ide-core-node';
import { process as processUtil } from '@opensumi/ide-utils';

import {
  IWatcherHostService,
  IWatcherProcessManager,
  SUMI_WATCHER_PROCESS_SOCK_KEY,
  WATCHER_INIT_DATA_KEY,
  WatcherProcessManagerProxy,
  WatcherServiceProxy,
} from '../common/watcher';

import { SharedNodeWatcherLease, SharedNodeWatcherPool, SharedNodeWatcherPoolToken } from './shared-node-watcher';

import type { ForkOptions } from 'child_process';

export const WatcherProcessManagerToken = Symbol('WatcherProcessManager');

@Injectable({ multiple: true })
export class WatcherProcessManagerImpl implements IWatcherProcessManager {
  private protocol?: SumiConnectionMultiplexer;

  private watcherSocket?: Socket;

  private watcherProcess?: ChildProcess;

  @Autowired(SharedNodeWatcherPoolToken)
  private readonly sharedNodeWatcherPool: SharedNodeWatcherPool;

  private sharedNodeLease?: SharedNodeWatcherLease;
  private sharedNodeHost = false;

  useSharedNodeHost(): void {
    this.sharedNodeHost = true;
  }

  private logger: ILogService;

  private _whenReadyDeferred: Deferred<void> = new Deferred();

  @Autowired(ILogServiceManager)
  private readonly loggerManager: ILogServiceManager;

  @Autowired(AppConfig)
  private readonly appConfig: AppConfig;

  private watcherClient: FileSystemWatcherClient;

  private disposing = false;

  private disposePromise?: Promise<void>;

  private lifecycleGeneration = 0;
  private unexpectedExitHandler?: () => void;

  setUnexpectedExitHandler(handler: () => void): void {
    this.unexpectedExitHandler = handler;
  }

  constructor() {
    this.logger = this.loggerManager.getLogger(SupportLogNamespace.Node);
  }

  setClient(client: FileSystemWatcherClient) {
    if (!this.watcherClient) {
      this.watcherClient = client;
    }
  }

  $onDidFilesChanged(changes: DidFilesChangedParams) {
    this.watcherClient.onDidFilesChanged(changes);
  }

  $onWatcherOverflow(event: FileWatcherOverflowParams) {
    this.watcherClient.onWatcherOverflow?.(event);
  }

  $onWatcherFailed(event: FileWatcherFailureParams) {
    this.watcherClient.onWatcherFailed?.(event);
  }

  get whenReady() {
    return this._whenReadyDeferred.promise;
  }

  private clientWatcherConnectionServer: Map<string, Server> = new Map();

  private setProxyConnection(socket: Socket) {
    if (this.disposing) {
      socket.destroy();
      return;
    }
    this.watcherSocket?.destroy();
    this.protocol?.dispose();
    const protocol = new SumiConnectionMultiplexer(new NetSocketConnection(socket), {
      timeout: -1,
    });
    protocol.set(WatcherProcessManagerProxy, this);

    this.protocol = protocol;
    this.watcherSocket = socket;
    socket.on('close', () => {
      protocol.dispose();
      if (this.protocol === protocol) {
        this.protocol = undefined;
      }
      if (this.watcherSocket === socket) {
        this.watcherSocket = undefined;
      }
    });

    this._whenReadyDeferred.resolve();
  }

  private getProxy() {
    if (!this.protocol) {
      throw new Error('Watcher process is not connected');
    }
    return this.protocol.getProxy<IWatcherHostService>(WatcherServiceProxy);
  }

  private async getIPCHandlerPath(name: string) {
    return await normalizedIpcHandlerPathAsync(name, true, this.appConfig.extHostIPCSockPath);
  }

  private async createWatcherServer(clientId: string, ipcHandlerPath: string) {
    this.assertAcceptingWork();
    const listenOptions = {
      path: ipcHandlerPath,
    };

    const server = createServer();
    this.clientWatcherConnectionServer.set(clientId, server);

    server.on('connection', (socket) => {
      this.logger.log('watcher process connected');
      this.setProxyConnection(socket);
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.clientWatcherConnectionServer.delete(clientId);
        reject(error);
      };
      server.once('error', onError);
      server.listen(listenOptions, () => {
        server.off('error', onError);
        if (this.disposing) {
          this.clientWatcherConnectionServer.delete(clientId);
          server.close(() => undefined);
          reject(new Error('WatcherProcessManager was disposed while its IPC server was starting'));
          return;
        }
        this.logger.log(`watcher process listen on ${JSON.stringify(listenOptions)}`);
        resolve();
      });
    });
  }

  private async closeWatcherServers() {
    this.watcherSocket?.destroy();
    this.watcherSocket = undefined;
    this.protocol?.dispose();
    this.protocol = undefined;

    const servers = Array.from(this.clientWatcherConnectionServer.values());
    this.clientWatcherConnectionServer.clear();
    await Promise.all(
      servers.map(
        (server) =>
          new Promise<void>((resolve) => {
            if (!server.listening) {
              resolve();
              return;
            }
            server.close(() => resolve());
          }),
      ),
    );
  }

  private async stopWatcherProcess() {
    const watcherProcess = this.watcherProcess;
    this.watcherProcess = undefined;
    if (!watcherProcess || watcherProcess.exitCode !== null || watcherProcess.signalCode !== null) {
      return;
    }

    await new Promise<void>((resolve) => {
      const finish = () => {
        clearTimeout(forceKillTimer);
        clearTimeout(stopTimeout);
        watcherProcess.off('exit', finish);
        resolve();
      };
      watcherProcess.once('exit', finish);
      const forceKillTimer = setTimeout(() => {
        watcherProcess.kill('SIGKILL');
      }, 2_000);
      forceKillTimer.unref?.();
      const stopTimeout = setTimeout(finish, 3_000);
      stopTimeout.unref?.();
      watcherProcess.kill('SIGTERM');
    });
  }

  private async startNodeWatcherProcess(clientId: string, backend?: RecursiveWatcherBackend) {
    this.logger.log('create watcher process for client: ', clientId);
    this.logger.log('appconfig watcherHost: ', this.watcherHost);

    const ipcHandlerPath = await this.getIPCHandlerPath('watcher_process');
    this.assertAcceptingWork();
    await this.createWatcherServer(clientId, ipcHandlerPath);
    this.assertAcceptingWork();
    return this.createWatcherProcess(clientId, ipcHandlerPath, backend);
  }

  get watcherHost() {
    if (process.env.EXT_MODE === 'js') {
      if (!this.appConfig.watcherHost || this.isDefaultBuiltWatcherHost(this.appConfig.watcherHost)) {
        return this.getSourceWatcherHost();
      }
    }

    return this.appConfig.watcherHost || this.getBuiltWatcherHost();
  }

  private getBuiltWatcherHost() {
    return path.join(__dirname, 'hosted', 'watcher.process.' + processUtil.extFileType);
  }

  private getSourceWatcherHost() {
    const sourceWatcherHost = path.join(__dirname, 'hosted', 'watcher.process.ts');
    if (existsSync(sourceWatcherHost)) {
      return sourceWatcherHost;
    }
    return path.join(__dirname, '../../src/node/hosted/watcher.process.ts');
  }

  private isDefaultBuiltWatcherHost(watcherHost: string) {
    const resolvedWatcherHost = path.resolve(watcherHost);
    const hostNames = Array.from(new Set(['watcher.process.js', 'watcher.process.' + processUtil.extFileType]));

    return hostNames
      .flatMap((hostName) => [
        path.join(__dirname, 'hosted', hostName),
        path.join(__dirname, '../../lib/node/hosted', hostName),
      ])
      .map((candidate) => path.resolve(candidate))
      .includes(resolvedWatcherHost);
  }

  private getWatcherProcessExecArgv() {
    if (process.env.EXT_MODE !== 'js') {
      return process.execArgv;
    }

    const execArgv: string[] = [];
    for (let index = 0; index < process.execArgv.length; index++) {
      const arg = process.execArgv[index];
      if (arg.startsWith('--inspect')) {
        continue;
      }
      if (arg === '--require' || arg === '-r') {
        const moduleName = process.execArgv[index + 1];
        if (moduleName?.startsWith('ts-node/register') || moduleName === 'tsconfig-paths/register') {
          index++;
          continue;
        }
        if (moduleName) {
          execArgv.push(arg, moduleName);
        } else {
          execArgv.push(arg);
        }
        index++;
        continue;
      }
      if (arg.startsWith('--require=')) {
        const moduleName = arg.slice('--require='.length);
        if (moduleName.startsWith('ts-node/register') || moduleName === 'tsconfig-paths/register') {
          continue;
        }
      }
      execArgv.push(arg);
    }
    const ensureRequire = (moduleName: string) => {
      if (
        execArgv.includes(moduleName) ||
        execArgv.includes(`--require=${moduleName}`) ||
        execArgv.some((arg, index) => arg === '--require' && execArgv[index + 1] === moduleName) ||
        execArgv.some((arg, index) => arg === '-r' && execArgv[index + 1] === moduleName)
      ) {
        return;
      }
      execArgv.unshift(moduleName);
      execArgv.unshift('--require');
    };

    ensureRequire('tsconfig-paths/register');
    ensureRequire('ts-node/register/transpile-only');

    return execArgv;
  }

  private getWatcherProcessCwd() {
    if (process.env.EXT_MODE !== 'js') {
      return process.cwd();
    }

    return path.join(__dirname, '../../../..');
  }

  private getWatcherProcessForkOptions(): ForkOptions {
    const configuredOptions = this.appConfig.watcherHostForkOptions;
    const configuredExecArgv = configuredOptions?.execArgv || [];
    const stdioDiagnostics = process.env.OPENSUMI_WATCHER_STDIO_DIAGNOSTICS === '1';
    const overridesHeapLimit = configuredExecArgv.some(
      (argument) => argument.startsWith('--max-old-space-size=') || argument.startsWith('--max_old_space_size='),
    );
    const inheritedExecArgv = this.getWatcherProcessExecArgv().filter(
      (argument) =>
        !overridesHeapLimit ||
        (!argument.startsWith('--max-old-space-size=') && !argument.startsWith('--max_old_space_size=')),
    );

    return {
      ...configuredOptions,
      silent: true,
      execArgv: [...inheritedExecArgv, ...configuredExecArgv],
      cwd: configuredOptions?.cwd || this.getWatcherProcessCwd(),
      env: stdioDiagnostics
        ? { ...process.env, ...configuredOptions?.env, KTLOG_SHOW_DEBUG: '1' }
        : configuredOptions?.env,
    };
  }

  private async createWatcherProcess(clientId: string, ipcHandlerPath: string, backend?: RecursiveWatcherBackend) {
    this.assertAcceptingWork();
    const forkArgs = [
      `--${SUMI_WATCHER_PROCESS_SOCK_KEY}=${JSON.stringify({
        path: ipcHandlerPath,
      })}`,
      `--${WATCHER_INIT_DATA_KEY}=${JSON.stringify({
        logDir: this.appConfig.logDir,
        logLevel: this.appConfig.logLevel,
        backend,
        clientId,
        shared: this.sharedNodeHost,
      })}`,
    ];

    this.logger.log('Watcher process path: ', this.watcherHost);
    this.watcherProcess = fork(this.watcherHost, forkArgs, this.getWatcherProcessForkOptions());

    if (process.env.OPENSUMI_WATCHER_STDIO_DIAGNOSTICS === '1') {
      this.watcherProcess.stdout?.on('data', (chunk) => {
        process.stderr.write(`[watcher-host:stdout] ${String(chunk)}`);
      });
      this.watcherProcess.stderr?.on('data', (chunk) => {
        process.stderr.write(`[watcher-host:stderr] ${String(chunk)}`);
      });
    }

    this.logger.log('Watcher process fork success, pid: ', this.watcherProcess.pid);

    const watcherProcess = this.watcherProcess;
    watcherProcess.on('exit', async (code, signal) => {
      this.logger.warn('watcher process exit: ', code, signal);
      if (this.watcherProcess === watcherProcess) {
        this.watcherProcess = undefined;
        if (!this.disposing) {
          this.unexpectedExitHandler?.();
        }
      }
    });

    return watcherProcess.pid;
  }

  async createProcess(clientId: string, backend?: RecursiveWatcherBackend) {
    this.assertAcceptingWork();
    const generation = this.lifecycleGeneration;
    await this.sharedNodeLease?.dispose();
    this.sharedNodeLease = undefined;
    await this.closeWatcherServers();
    await this.stopWatcherProcess();
    this.assertCurrentGeneration(generation);
    this._whenReadyDeferred = new Deferred();
    try {
      if (!this.sharedNodeHost && process.env.OPENSUMI_NODE_WATCHER_MODE === 'shared') {
        const lease = await this.sharedNodeWatcherPool.acquire(
          {
            onDidFilesChanged: (event) => this.$onDidFilesChanged(event),
            onWatcherOverflow: (event) => this.$onWatcherOverflow(event),
            onWatcherFailed: (event) => this.$onWatcherFailed(event),
          },
          backend,
        );
        try {
          this.assertCurrentGeneration(generation);
          this.sharedNodeLease = lease;
          this._whenReadyDeferred.resolve();
          return await lease.pid;
        } catch (error) {
          await lease.dispose();
          throw error;
        }
      }
      const pid = await this.startNodeWatcherProcess(clientId, backend);
      this.assertCurrentGeneration(generation);
      return pid;
    } catch (error) {
      if (this.disposing || generation !== this.lifecycleGeneration) {
        await this.closeWatcherServers();
        await this.stopWatcherProcess();
      }
      throw error;
    }
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.disposing = true;
    this.lifecycleGeneration += 1;
    this.disposePromise = this.doDispose();
    return this.disposePromise;
  }

  private async doDispose(): Promise<void> {
    if (this.sharedNodeLease) {
      await this.sharedNodeLease.dispose();
      this.sharedNodeLease = undefined;
      return;
    }
    try {
      if (this.protocol) {
        let timeout: NodeJS.Timeout | undefined;
        await Promise.race([
          this.getProxy().$dispose(),
          new Promise<void>((resolve) => {
            timeout = setTimeout(resolve, 1_000);
            timeout.unref?.();
          }),
        ]);
        if (timeout) {
          clearTimeout(timeout);
        }
      }
    } catch {
    } finally {
      await this.closeWatcherServers();
      await this.stopWatcherProcess();
    }
  }

  async watch(
    uri: UriComponents,
    options?: { excludes?: string[]; recursive?: boolean; pollingWatch?: boolean },
  ): Promise<number> {
    this.assertAcceptingWork();
    const generation = this.lifecycleGeneration;
    this.logger.log('Wait for watcher process ready...');
    await this._whenReadyDeferred.promise;
    this.assertCurrentGeneration(generation);
    this.logger.log('start watch: ', uri);
    if (this.sharedNodeLease) {
      const id = await this.sharedNodeLease.watch(uri, options);
      try {
        this.assertCurrentGeneration(generation);
        return id;
      } catch (error) {
        await this.sharedNodeLease?.unWatch(id);
        throw error;
      }
    }
    const nodeWatchId = await this.getProxy().$watch(uri, options);
    this.assertOwnedNodeWatch(generation, nodeWatchId);
    return nodeWatchId;
  }

  async unWatch(watcheId: number) {
    if (this.disposing) {
      return;
    }
    await this._whenReadyDeferred.promise;
    if (this.disposing) {
      return;
    }
    if (this.sharedNodeLease) {
      return this.sharedNodeLease.unWatch(watcheId);
    }
    return this.getProxy().$unwatch(watcheId);
  }

  async setWatcherFileExcludes(excludes: string[]) {
    this.assertAcceptingWork();
    await this._whenReadyDeferred.promise;
    this.assertAcceptingWork();
    if (this.sharedNodeLease) {
      return this.sharedNodeLease.setExcludes(excludes);
    }
    return this.getProxy().$setWatcherFileExcludes(excludes);
  }

  private assertAcceptingWork(): void {
    if (this.disposing) {
      throw new Error('WatcherProcessManager is disposing and cannot accept new work');
    }
  }

  private assertCurrentGeneration(generation: number): void {
    this.assertAcceptingWork();
    if (generation !== this.lifecycleGeneration) {
      throw new Error('WatcherProcessManager lifecycle changed while watcher startup was in progress');
    }
  }

  private assertOwnedNodeWatch(generation: number, nodeWatchId: number): void {
    try {
      this.assertCurrentGeneration(generation);
    } catch (error) {
      // The watcher host may answer after its connection owner has already
      // retired. Do not publish that stale id, and keep cleanup observed even
      // when the old transport can no longer acknowledge the unwatch request.
      void Promise.resolve()
        .then(() => this.getProxy().$unwatch(nodeWatchId))
        .catch((cleanupError) =>
          this.logger.warn('Could not reclaim a watcher created after its connection scope retired', cleanupError),
        );
      throw error;
    }
  }
}
