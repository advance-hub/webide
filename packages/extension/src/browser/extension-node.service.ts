import { Autowired, INJECTOR_TOKEN, Injectable, Injector } from '@opensumi/di';
import {
  BaseConnection,
  IRPCProtocol,
  SumiConnectionMultiplexer,
  WSChannel,
  createExtMessageIO,
} from '@opensumi/ide-connection';
import { WSChannelHandler } from '@opensumi/ide-connection/browser';
import {
  AppConfig,
  ContributionProvider,
  Deferred,
  Disposable,
  DisposableStore,
  ExtHostSpawnOptions,
  IApplicationService,
  IExtensionProps,
  toDisposable,
} from '@opensumi/ide-core-browser';

import {
  CONNECTION_HANDLE_BETWEEN_EXTENSION_AND_MAIN_THREAD,
  ExtensionNodeServiceServerPath,
  IExtension,
  IExtensionHostService,
  IExtensionNodeClientService,
} from '../common';
import { ActivatedExtensionJSON } from '../common/activator';
import { AbstractNodeExtProcessService } from '../common/extension.service';
import { IMainThreadExtenderService, MainThreadExtenderContribution } from '../common/main.thread.extender';
import { ExtHostAPIIdentifier } from '../common/vscode';
import { knownProtocols } from '../common/vscode/protocols';

import { createSumiAPIFactory } from './sumi/main.thread.api.impl';
import { initNodeThreadAPIProxy } from './vscode/api/main.thread.api.impl';
import { initSharedAPIProxy } from './vscode/api/main.thread.api.shared-impl';

type NodeExtHostGenerationState = 'idle' | 'starting' | 'ready' | 'failed' | 'disposed';

interface NodeExtHostGeneration {
  readonly id: number;
  readonly ready: Deferred<void>;
  readonly updated: Deferred<void>;
  readonly apiFactoryDisposables: DisposableStore;
  state: NodeExtHostGenerationState;
  connection?: BaseConnection<Uint8Array>;
  channel?: WSChannel;
  protocol?: IRPCProtocol;
}

/**
 * Keep the public Deferred object stable for existing consumers while making
 * every access to `promise` follow the current Extension Host generation.
 */
class GenerationDeferred<T> {
  constructor(private current: Deferred<T>) {}

  public get promise(): Promise<T> {
    return this.current.promise;
  }

  public readonly resolve = (value?: T | PromiseLike<T>) => {
    this.current.resolve(value);
  };

  public readonly reject = (error?: unknown) => {
    this.current.reject(error);
  };

  public bind(deferred: Deferred<T>): void {
    this.current = deferred;
  }
}

class StaleNodeExtHostGenerationError extends Error {
  constructor(generation: number) {
    super(`Node Extension Host generation ${generation} is no longer current`);
    this.name = 'StaleNodeExtHostGenerationError';
  }
}

function createHandledDeferred<T>(): Deferred<T> {
  const deferred = new Deferred<T>();
  // A generation can be retired without a waiter. Mark the rejection handled
  // while preserving the rejected promise for callers that await it later.
  void deferred.promise.catch(() => undefined);
  return deferred;
}

@Injectable()
export class NodeExtProcessService implements AbstractNodeExtProcessService<IExtensionHostService> {
  @Autowired(AppConfig)
  private readonly appConfig: AppConfig;

  @Autowired(INJECTOR_TOKEN)
  protected readonly injector: Injector;

  @Autowired(ExtensionNodeServiceServerPath)
  private readonly extensionNodeClient: IExtensionNodeClientService;

  @Autowired(IApplicationService)
  protected readonly applicationService: IApplicationService;

  @Autowired(WSChannelHandler)
  private readonly channelHandler: WSChannelHandler;

  @Autowired(IMainThreadExtenderService)
  private readonly mainThreadExtenderService: IMainThreadExtenderService;

  @Autowired(MainThreadExtenderContribution)
  private readonly mainThreadExtenderContributionProvider: ContributionProvider<MainThreadExtenderContribution>;

  private generationCounter = 0;
  private generation = this.createGeneration();
  private readonly readyBarrier = new GenerationDeferred(this.generation.ready);
  private activation?: { generation: NodeExtHostGeneration; promise: Promise<IRPCProtocol> };
  private disposePromise?: Promise<void>;

  public ready: Deferred<void> = this.readyBarrier as Deferred<void>;

  private extensions: IExtension[] = [];
  public protocol: IRPCProtocol;
  public connection: BaseConnection<Uint8Array>;
  public channel: WSChannel;

  public disposeApiFactory() {
    this.generation.apiFactoryDisposables.clear();
  }

  public disposeProcess(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }

    const retiringGeneration = this.generation;
    const activation = this.activation?.generation === retiringGeneration ? this.activation.promise : undefined;
    this.replaceGeneration('disposed by Browser restart');

    const disposePromise = (async () => {
      await activation?.catch(() => undefined);
      await this.extensionNodeClient.disposeClientExtProcess(this.clientId, false);
    })();
    this.disposePromise = disposePromise;
    void disposePromise.then(
      () => this.clearDisposePromise(disposePromise),
      () => this.clearDisposePromise(disposePromise),
    );
    return disposePromise;
  }

  public activate(): Promise<IRPCProtocol> {
    const currentActivation = this.activation;
    if (currentActivation?.generation === this.generation) {
      return currentActivation.promise;
    }
    const generation =
      this.generation.state === 'idle'
        ? this.generation
        : this.replaceGeneration('superseded by a newer Browser activation');
    generation.state = 'starting';
    const pendingDispose = this.disposePromise;
    const promise = (async () => {
      await pendingDispose;
      this.assertCurrentGeneration(generation);
      return this.activateGeneration(generation);
    })();
    const activation = { generation, promise };
    this.activation = activation;
    void promise.then(
      () => this.clearActivation(activation),
      () => this.clearActivation(activation),
    );
    return promise;
  }

  public async activeExtension(extension: IExtension, isWebExtension: boolean): Promise<void> {
    if (!this.appConfig.noExtHost && !isWebExtension) {
      // 只有当 proxy.$updateExtHostData 调用之后才可以开始激活插件
      const proxy = await this.getUpdatedProxy();
      await proxy.$activateExtension(extension.id);
    }
  }

  public async updateExtensionData(extensions: IExtension[]): Promise<void> {
    this.extensions = extensions;
    if (this.protocol) {
      const proxy: IExtensionHostService = await this.getProxy();
      // 同步 host 进程中的 extension 列表
      await proxy.$updateExtHostData();
      // 发送 extension 变化
      proxy.$fireChangeEvent();
    }
  }

  public getExtension(extensionId: string): IExtension | undefined {
    return this.extensions.find((n) => n.id === extensionId);
  }

  // 以下两者是给插件进程调用的 rpc call
  public async $activateExtension(extensionPath: string): Promise<void> {
    const extension = this.extensions.find((n) => n.path === extensionPath);
    if (extension) {
      await extension.activate();
    }
  }

  public async $getExtensions(): Promise<IExtensionProps[]> {
    return this.extensions.map((n) => n.toJSON());
  }

  public async getProxy(): Promise<IExtensionHostService> {
    while (true) {
      const generation = this.generation;
      try {
        await generation.ready.promise;
      } catch (error) {
        if (generation !== this.generation) {
          continue;
        }
        throw error;
      }
      if (generation === this.generation && generation.state === 'ready' && generation.protocol) {
        return this.getGenerationProxy(generation);
      }
    }
  }

  private async getUpdatedProxy(): Promise<IExtensionHostService> {
    while (true) {
      const generation = this.generation;
      try {
        await generation.updated.promise;
      } catch (error) {
        if (generation !== this.generation) {
          continue;
        }
        throw error;
      }
      if (generation === this.generation && generation.state === 'ready' && generation.protocol) {
        return this.getGenerationProxy(generation);
      }
    }
  }

  private async createBrowserMainThreadAPI(generation: NodeExtHostGeneration) {
    const protocol = generation.protocol!;
    const apiProxy = initSharedAPIProxy(protocol, this.injector);
    generation.apiFactoryDisposables.add(apiProxy);
    generation.apiFactoryDisposables.add(toDisposable(initNodeThreadAPIProxy(protocol, this.injector, this)));
    generation.apiFactoryDisposables.add(toDisposable(createSumiAPIFactory(protocol, this.injector)));
    generation.apiFactoryDisposables.add(this.createExternalSumiAPIFactory(protocol));
    await apiProxy.setup();
  }

  getSpawnOptions(): ExtHostSpawnOptions {
    return {};
  }

  /**
   * register external main thread class
   * @returns disposer
   */
  private createExternalSumiAPIFactory(protocol: IRPCProtocol) {
    const disposer = new Disposable();
    // register main thread extender contribution
    const contributions = this.mainThreadExtenderContributionProvider.getContributions();
    for (const contribution of contributions) {
      contribution.registerMainThreadExtender(this.mainThreadExtenderService);
    }
    // instantiate this MainThreadExtenderClass
    const extenders = this.mainThreadExtenderService.getMainThreadExtenders();
    for (const extender of extenders) {
      const service = this.injector.get(extender.serviceClass, [protocol]);
      protocol.set(extender.identifier, service);
      disposer.addDispose(service);
    }
    return disposer;
  }

  public async getActivatedExtensions(): Promise<ActivatedExtensionJSON[]> {
    const proxy = await this.getProxy();
    return await proxy.$getActivatedExtensions();
  }

  private get clientId() {
    return this.applicationService.clientId;
  }

  /**
   * 这个 protocol 需要每次都重新创建，因为服务端是会在该 channel 连上后才开始进行插件进程相关的逻辑的
   */
  private async initExtProtocol(generation: NodeExtHostGeneration): Promise<void> {
    const channel = await this.channelHandler.openChannel(CONNECTION_HANDLE_BETWEEN_EXTENSION_AND_MAIN_THREAD);
    if (generation !== this.generation || generation.state !== 'starting') {
      channel.dispose();
      throw new StaleNodeExtHostGenerationError(generation.id);
    }

    try {
      const connection = channel.createConnection();
      const protocol = this.createProtocol(connection);
      if (generation !== this.generation || generation.state !== 'starting') {
        (protocol as SumiConnectionMultiplexer).dispose?.();
        throw new StaleNodeExtHostGenerationError(generation.id);
      }
      generation.channel = channel;
      generation.connection = connection;
      generation.protocol = protocol;
    } catch (error) {
      if (generation.channel !== channel) {
        channel.dispose();
      }
      throw error;
    }
  }

  private createProtocol(connection: BaseConnection<Uint8Array>): IRPCProtocol {
    return new SumiConnectionMultiplexer(connection, {
      timeout: this.appConfig.rpcMessageTimeout,
      name: 'node-ext-host',
      io: createExtMessageIO(knownProtocols),
    });
  }

  private async activateGeneration(generation: NodeExtHostGeneration): Promise<IRPCProtocol> {
    try {
      await this.extensionNodeClient.createProcess(this.clientId, {
        enableDebugExtensionHost: this.appConfig.enableDebugExtensionHost,
        inspectExtensionHost: this.appConfig.inspectExtensionHost,
        extensionConnectOption: this.appConfig.extensionConnectOption,
        extHostSpawnOptions: this.getSpawnOptions(),
      });
      this.assertCurrentGeneration(generation);

      await this.initExtProtocol(generation);
      this.assertCurrentGeneration(generation);

      await this.createBrowserMainThreadAPI(generation);
      this.assertCurrentGeneration(generation);

      const proxy = this.getGenerationProxy(generation);
      await proxy.$updateExtHostData();
      this.assertCurrentGeneration(generation);

      generation.state = 'ready';
      this.channel = generation.channel!;
      this.connection = generation.connection!;
      this.protocol = generation.protocol!;
      generation.updated.resolve();
      generation.ready.resolve();
      return generation.protocol!;
    } catch (error) {
      if (generation === this.generation && generation.state !== 'disposed') {
        generation.state = 'failed';
        this.disposeGenerationResources(generation);
        generation.updated.reject(error);
        generation.ready.reject(error);
        try {
          await this.extensionNodeClient.disposeClientExtProcess(this.clientId, false);
        } catch {
          // Preserve the activation error; Node owns idempotent Host cleanup.
        }
      }
      throw error;
    }
  }

  private getGenerationProxy(generation: NodeExtHostGeneration): IExtensionHostService {
    return generation.protocol!.getProxy<IExtensionHostService>(ExtHostAPIIdentifier.ExtHostExtensionService);
  }

  private createGeneration(): NodeExtHostGeneration {
    return {
      id: ++this.generationCounter,
      ready: createHandledDeferred<void>(),
      updated: createHandledDeferred<void>(),
      apiFactoryDisposables: new DisposableStore(),
      state: 'idle',
    };
  }

  private replaceGeneration(reason: string): NodeExtHostGeneration {
    const previous = this.generation;
    const next = this.createGeneration();
    this.generation = next;
    this.readyBarrier.bind(next.ready);
    this.retireGeneration(previous, reason);
    return next;
  }

  private retireGeneration(generation: NodeExtHostGeneration, reason: string): void {
    if (generation.state === 'disposed') {
      return;
    }
    generation.state = 'disposed';
    this.disposeGenerationResources(generation);
    const error = new StaleNodeExtHostGenerationError(generation.id);
    error.message = `${error.message}: ${reason}`;
    generation.updated.reject(error);
    generation.ready.reject(error);
  }

  private disposeGenerationResources(generation: NodeExtHostGeneration): void {
    if (this.channel === generation.channel) {
      this.channel = undefined as unknown as WSChannel;
    }
    if (this.connection === generation.connection) {
      this.connection = undefined as unknown as BaseConnection<Uint8Array>;
    }
    if (this.protocol === generation.protocol) {
      this.protocol = undefined as unknown as IRPCProtocol;
    }
    generation.apiFactoryDisposables.dispose();
    generation.channel?.dispose();
    (generation.protocol as SumiConnectionMultiplexer | undefined)?.dispose?.();
    generation.channel = undefined;
    generation.connection = undefined;
    generation.protocol = undefined;
  }

  private assertCurrentGeneration(generation: NodeExtHostGeneration): void {
    if (generation !== this.generation || generation.state !== 'starting') {
      throw new StaleNodeExtHostGenerationError(generation.id);
    }
  }

  private clearActivation(activation: { generation: NodeExtHostGeneration; promise: Promise<IRPCProtocol> }): void {
    if (this.activation === activation) {
      this.activation = undefined;
    }
  }

  private clearDisposePromise(disposePromise: Promise<void>): void {
    if (this.disposePromise === disposePromise) {
      this.disposePromise = undefined;
    }
  }
}
