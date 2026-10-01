import os from 'os';

import { HashCalculateServiceImpl, IHashCalculateService } from '@opensumi/ide-core-common/hash';
import { AppConfig, INodeLogger, getDebugLogger, path } from '@opensumi/ide-core-node';
import { createNodeInjector } from '@opensumi/ide-dev-tool/injector';
import { IExtensionStoragePathServer } from '@opensumi/ide-extension-storage';
import { IDiskFileProvider, IFileService } from '@opensumi/ide-file-service';
import { FileService, FileSystemNodeOptions } from '@opensumi/ide-file-service/node';
import { DiskFileSystemProvider } from '@opensumi/ide-file-service/node/disk-provider';

import { IExtensionNodeClientService, IExtensionNodeService } from '../../src/common';
import { ExtensionNodeServiceImpl } from '../../src/node/extension.service';
import { ExtensionServiceClientImpl } from '../../src/node/extension.service.client';

export const extensionDir = path.join(__dirname, '../../__mocks__/extensions');

export const getBaseInjector = () => {
  const injector = createNodeInjector([]);
  injector.overrideProviders({
    token: AppConfig,
    useValue: {
      marketplace: {
        extensionDir,
        ignoreId: [],
      },
    },
  });
  injector.addProviders(
    {
      token: INodeLogger,
      useValue: getDebugLogger(),
    },
    {
      token: IFileService,
      useClass: FileService,
    },
    {
      token: IDiskFileProvider,
      useClass: DiskFileSystemProvider,
    },
    {
      token: 'FileServiceOptions',
      useValue: FileSystemNodeOptions.DEFAULT,
    },
    {
      token: IExtensionStoragePathServer,
      useValue: {
        getLastStoragePath: () => Promise.resolve(path.join(os.homedir(), '.sumi-extension-test', 'workspace-storage')),
      },
    },
    {
      token: IExtensionNodeService,
      useClass: ExtensionNodeServiceImpl,
    },
    {
      token: IExtensionNodeClientService,
      useClass: ExtensionServiceClientImpl,
    },
    {
      token: IHashCalculateService,
      useClass: HashCalculateServiceImpl,
    },
  );
  return injector;
};
