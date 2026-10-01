import {
  Emitter,
  IApplicationService,
  IClipboardService,
  IContextKeyService,
  OperatingSystem,
  PreferenceService,
  QuickOpenService,
  URI,
} from '@opensumi/ide-core-browser';
import { IDecorationsService } from '@opensumi/ide-decoration';
import { createBrowserInjector } from '@opensumi/ide-dev-tool/browser';
import { MockInjector } from '@opensumi/ide-dev-tool/injector';
import { MockContextKeyService } from '@opensumi/ide-dev-tool/mocks/context-key';
import { MockWorkbenchEditorService } from '@opensumi/ide-dev-tool/mocks/editor-workbench';
import { MockQuickOpenService } from '@opensumi/ide-dev-tool/mocks/quick-open';
import { WorkbenchEditorService } from '@opensumi/ide-editor';
import { EXPLORER_CONTAINER_ID } from '@opensumi/ide-explorer/contribution';
import { IFileServiceClient } from '@opensumi/ide-file-service';
import { IFileTreeAPI, IFileTreeService } from '@opensumi/ide-file-tree-next';
import { IMainLayoutService, IViewsRegistry } from '@opensumi/ide-main-layout';
import { ViewsRegistry } from '@opensumi/ide-main-layout/views';
import { IDialogService, IMessageService, IWindowDialogService } from '@opensumi/ide-overlay';
import { IWorkspaceService } from '@opensumi/ide-workspace';

import { FileTreeContribution } from '../../src/browser/file-tree-contribution';
import { FileTreeModelService } from '../../src/browser/services/file-tree-model.service';

describe('FileTreeContribution', () => {
  let mockInjector: MockInjector;
  let mockClipboardService;
  let mockFileTreeModelService;
  const tabbarHandlerMap = new Map();

  const mockMainLayoutService = {
    collectViewComponent: jest.fn(),
    getTabbarHandler: (name: string) => {
      if (tabbarHandlerMap.has(name)) {
        return tabbarHandlerMap.get(name);
      }
      const handler = {
        updateViewTitle: jest.fn(),
        onActivate: jest.fn(),
        onInActivate: jest.fn(),
        isActivated: jest.fn(() => true),
      };
      tabbarHandlerMap.set(name, handler);
      return handler;
    },
  };
  const mockFileTreeService = {
    init: jest.fn(),
    reWatch: jest.fn(),
    getNodeByPathOrUri: () => ({
      filestat: {
        isSymbolicLink: true,
        isDirectory: false,
        lastModification: new Date().getTime(),
        uri: URI.file('userhome').resolve('test').toString(),
      },
    }),
  };
  const mockDecorationsService = {
    registerDecorationsProvider: jest.fn(),
  };
  const onWorkspaceLocationChangedEmitter = new Emitter();
  const mockWorkspaceService = {
    workspace: {
      isSymbolicLink: false,
      isDirectory: true,
      lastModification: new Date().getTime(),
      uri: URI.file('userhome').toString(),
    },
    onWorkspaceLocationChanged: onWorkspaceLocationChangedEmitter.event,
  };
  const mockFileService = {};

  beforeEach(() => {
    mockInjector = createBrowserInjector([]);
    mockClipboardService = {
      writeText: jest.fn(),
    };
    mockFileTreeModelService = {
      selectedFiles: [],
      focusedFile: undefined,
      contextMenuFile: undefined,
      whenReady: Promise.resolve(),
      contextKey: {
        explorerViewletVisibleContext: {
          set: jest.fn(),
        },
      },
      performLocationOnHandleShow: jest.fn(),
      handleTreeBlur: jest.fn(),
    };

    mockInjector.overrideProviders(
      {
        token: IMainLayoutService,
        useValue: mockMainLayoutService,
      },
      {
        token: IFileTreeService,
        useValue: mockFileTreeService,
      },
      {
        token: IFileServiceClient,
        useValue: mockFileService,
      },
      {
        token: IWorkspaceService,
        useValue: mockWorkspaceService,
      },
      {
        token: IDecorationsService,
        useValue: mockDecorationsService,
      },
      {
        token: WorkbenchEditorService,
        useClass: MockWorkbenchEditorService,
      },
      {
        token: IWindowDialogService,
        useValue: {},
      },
      {
        token: IFileTreeAPI,
        useValue: {},
      },
      {
        token: IMessageService,
        useValue: {},
      },
      {
        token: IClipboardService,
        useValue: mockClipboardService,
      },
      {
        token: FileTreeModelService,
        useValue: mockFileTreeModelService,
      },
      {
        token: IDialogService,
        useValue: {},
      },
      {
        token: IContextKeyService,
        useClass: MockContextKeyService,
      },
      {
        token: PreferenceService,
        useValue: {},
      },
      {
        token: IViewsRegistry,
        useClass: ViewsRegistry,
      },
      {
        token: QuickOpenService,
        useClass: MockQuickOpenService,
      },
      {
        token: IApplicationService,
        useValue: {
          backendOS: Promise.resolve(OperatingSystem.Linux),
          getBackendOS: () => Promise.resolve(OperatingSystem.Linux),
        },
      },
    );
  });

  afterAll(async () => {
    await mockInjector.disposeAll();
  });

  describe('01 #contribution should be work', () => {
    it('should onStart be work', async () => {
      const contribution = mockInjector.get(FileTreeContribution);
      await contribution.onStart();
      expect(mockMainLayoutService.collectViewComponent).toHaveBeenCalledTimes(1);
      await onWorkspaceLocationChangedEmitter.fireAndAwait(undefined);
      const handler = tabbarHandlerMap.get(EXPLORER_CONTAINER_ID);
      expect(handler.updateViewTitle).toHaveBeenCalledTimes(1);
    });

    it('should onDidStart be work', async () => {
      const contribution = mockInjector.get(FileTreeContribution);
      await contribution.onDidStart();
      expect(mockDecorationsService.registerDecorationsProvider).toHaveBeenCalledTimes(1);
    });

    it('should onDidRender be work', async () => {
      const contribution = mockInjector.get(FileTreeContribution);
      contribution.onDidRender();
      const handler = tabbarHandlerMap.get(EXPLORER_CONTAINER_ID);
      expect(handler.onActivate).toHaveBeenCalledTimes(1);
      expect(handler.onInActivate).toHaveBeenCalledTimes(1);
    });

    it('should getWorkspaceTitle be work', async () => {
      const contribution = mockInjector.get(FileTreeContribution);
      const title = contribution.getWorkspaceTitle();
      expect(title).toBe('userhome');
    });

    it('should registerCommands be work', async () => {
      const contribution = mockInjector.get(FileTreeContribution);
      const register = jest.fn();
      contribution.registerCommands({ registerCommand: register } as any);
      expect(register).toHaveBeenCalled();
    });

    it('should registerMenus be work', async () => {
      const contribution = mockInjector.get(FileTreeContribution);
      const register = jest.fn();
      contribution.registerMenus({ registerMenuItem: register } as any);
      expect(register).toHaveBeenCalled();
    });

    it('should registerKeybindings be work', async () => {
      const contribution = mockInjector.get(FileTreeContribution);
      const register = jest.fn();
      contribution.registerKeybindings({ registerKeybinding: register } as any);
      expect(register).toHaveBeenCalled();
    });

    it('should registerToolbarItems be work', async () => {
      const contribution = mockInjector.get(FileTreeContribution);
      const register = jest.fn();
      contribution.registerToolbarItems({ registerItem: register } as any);
      expect(register).toHaveBeenCalled();
    });
  });

  describe('copy path commands', () => {
    const registerCommands = () => {
      const contribution = mockInjector.get(FileTreeContribution);
      const commands = new Map<string, any>();
      contribution.registerCommands({
        registerCommand: jest.fn((command, handler) => {
          commands.set(command.id, { command, ...handler });
        }),
      } as any);
      return commands;
    };

    it('uses the selected explorer file when copy path is triggered from a shortcut', async () => {
      mockFileTreeModelService.selectedFiles = [{ uri: URI.file('/userhome/test.ts') }];
      const commands = registerCommands();

      await commands.get('filetree.copy.path').execute();

      expect(mockClipboardService.writeText).toHaveBeenCalledWith('/userhome/test.ts');
    });

    it('uses the selected explorer file when copy relative path is triggered from a shortcut', async () => {
      mockFileTreeModelService.selectedFiles = [{ uri: URI.file('/userhome/test.ts') }];
      const commands = registerCommands();

      await commands.get('filetree.copy.relativepath').execute();

      expect(mockClipboardService.writeText).toHaveBeenCalledWith('test.ts');
    });

    it('exposes labels for copy path commands so users can configure shortcuts', () => {
      const commands = registerCommands();

      expect(commands.get('filetree.copy.path').command.label).toBe('%file.copy.path%');
      expect(commands.get('filetree.copy.relativepath').command.label).toBe('%file.copy.relativepath%');
    });
  });
});
