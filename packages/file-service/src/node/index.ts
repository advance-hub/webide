import { INJECTOR_TOKEN, Inject, Injectable, Injector, Token } from '@opensumi/di';
import { IConnectionScopeRetirement, NodeModule } from '@opensumi/ide-core-node';

import {
  DiskFileServiceRuntimeBinding,
  FileServicePath,
  FileSystemProvider,
  IDiskFileProvider,
  IFileService,
  IShadowFileProvider,
  ShadowFileServicePath,
} from '../common';
import { DiskFileServiceProtocol } from '../common/protocols/disk-file-service';

import { DiskFileSystemProvider } from './disk-file-system.provider';
import { getSafeFileservice } from './file-service';
import {
  SharedNodeWatcherLifecycleContribution,
  SharedNodeWatcherPool,
  SharedNodeWatcherPoolToken,
} from './shared-node-watcher';
import { WatcherProcessManagerImpl, WatcherProcessManagerToken } from './watcher-process-manager';
import {
  WorkspaceAgentClient,
  WorkspaceAgentClientToken,
  WorkspaceAgentLifecycleContribution,
} from './workspace-agent';

export * from './file-service';

const fsInstanceMap = new WeakMap<Injector, FileSystemProvider>();

@Injectable()
class ServerSharedNodeWatcherPool extends SharedNodeWatcherPool {
  constructor(@Inject(INJECTOR_TOKEN) injector: Injector) {
    super(() => {
      const host = injector.get(WatcherProcessManagerToken) as WatcherProcessManagerImpl;
      host.useSharedNodeHost();
      return host;
    });
  }
}
function getConnectionScopeRetirement(injector: Injector): IConnectionScopeRetirement | undefined {
  return injector.creatorMap?.has(IConnectionScopeRetirement)
    ? (injector.get(IConnectionScopeRetirement) as IConnectionScopeRetirement)
    : undefined;
}

export function getFileservice(injector: Injector, providerToken: Token): FileSystemProvider {
  const cachedFileService = fsInstanceMap.get(injector);
  if (cachedFileService) {
    return cachedFileService;
  }
  const fileService = injector.get(providerToken) as FileSystemProvider;
  const scopeRetirement = getConnectionScopeRetirement(injector);
  if (scopeRetirement && fileService instanceof DiskFileSystemProvider) {
    fileService.setConnectionScopeRetirement(scopeRetirement);
  }
  fsInstanceMap.set(injector, fileService);
  try {
    injector.addProviders({
      token: Symbol('DiskFileServiceConnectionScopeCleanup'),
      useValue: {
        dispose: async () => {
          try {
            await (fileService as FileSystemProvider & { dispose?: () => void | Promise<void> }).dispose?.();
          } finally {
            fsInstanceMap.delete(injector);
          }
        },
      },
    });
  } catch (error) {
    fsInstanceMap.delete(injector);
    throw error;
  }
  return fileService;
}

@Injectable()
export class FileServiceModule extends NodeModule {
  providers = [
    { token: IFileService, useFactory: (injector: Injector) => getSafeFileservice(injector) },
    { token: IDiskFileProvider, useFactory: (injector: Injector) => getFileservice(injector, DiskFileSystemProvider) },
    { token: WorkspaceAgentClientToken, useClass: WorkspaceAgentClient },
    WorkspaceAgentLifecycleContribution,
    { token: SharedNodeWatcherPoolToken, useClass: ServerSharedNodeWatcherPool },
    SharedNodeWatcherLifecycleContribution,
    { token: WatcherProcessManagerToken, useClass: WatcherProcessManagerImpl },
  ];

  backServices = [
    {
      servicePath: DiskFileServiceRuntimeBinding.servicePath,
      token: IDiskFileProvider,
      protocol: DiskFileServiceProtocol,
    },
    {
      servicePath: ShadowFileServicePath,
      token: IShadowFileProvider,
    },
    {
      servicePath: FileServicePath,
      token: IFileService,
    },
  ];
}
