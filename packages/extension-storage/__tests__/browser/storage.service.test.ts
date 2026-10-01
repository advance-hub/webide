import { AppConfig } from '@opensumi/ide-core-browser';
import { createBrowserInjector } from '@opensumi/ide-dev-tool/browser';
import { MockInjector } from '@opensumi/ide-dev-tool/injector';
import { MockWorkspaceService } from '@opensumi/ide-dev-tool/mocks/workspace-service';
import { IWorkspaceService } from '@opensumi/ide-workspace';

import { ExtensionStorageService } from '../../src/browser';
import { IExtensionStorageServer, IExtensionStorageService } from '../../src/common';

describe('ExtensionStorage service should be work', () => {
  let injector: MockInjector;
  let extensionStorageService: IExtensionStorageService;
  let mockInit;
  beforeAll(async () => {
    injector = createBrowserInjector([]);

    // mock used instance
    injector.overrideProviders(
      {
        token: IExtensionStorageServer,
        useValue: {
          getAll: jest.fn(() => Promise.resolve({})),
          get: jest.fn(() => undefined),
          init: jest.fn(() => Promise.resolve({ workspace: '', global: '' })),
          set: jest.fn(() => Promise.resolve()),
        },
      },
      {
        token: AppConfig,
        useValue: {},
      },
      {
        token: IWorkspaceService,
        useClass: MockWorkspaceService,
      },
      {
        token: IExtensionStorageService,
        useClass: ExtensionStorageService,
      },
    );
    mockInit = jest.fn();
    extensionStorageService = injector.get(IExtensionStorageService);
    injector.mock(IExtensionStorageServer, 'init', mockInit);
    await extensionStorageService.whenReady;
  });

  afterAll(async () => {
    await injector.disposeAll();
  });

  it('01 #Init', async () => {
    expect(mockInit).toHaveBeenCalledTimes(1);
  });

  it('02 #Set', async () => {
    const mockSet = jest.fn();
    const key = 'key';
    const value = { hello: 'world' };
    const isGlobal = false;
    injector.mock(IExtensionStorageServer, 'set', mockSet);
    extensionStorageService.set(key, value, isGlobal);
    expect(mockSet).toHaveBeenCalledWith(key, value, isGlobal);
  });

  it('03 #Get', async () => {
    const mockGet = jest.fn();
    const key = 'key';
    const isGlobal = false;
    injector.mock(IExtensionStorageServer, 'get', mockGet);
    await extensionStorageService.get(key, isGlobal);
    expect(mockGet).toHaveBeenCalledWith(key, isGlobal);
  });

  it('04 #GetAll', async () => {
    const mockGetAll = jest.fn();
    const isGlobal = false;
    injector.mock(IExtensionStorageServer, 'getAll', mockGetAll);
    await extensionStorageService.getAll(isGlobal);
    expect(mockGetAll).toHaveBeenCalledWith(isGlobal);
  });

  it('05 #ReConnectInit', async () => {
    await extensionStorageService.reConnectInit();
    expect(mockInit).toHaveBeenCalledTimes(2);
  });
});
