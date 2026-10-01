import fs from 'fs';
import os from 'os';
import path from 'path';

import { Injectable, Provider } from '@opensumi/di';
import { ICommentsService } from '@opensumi/ide-comments';
import { CommentsService } from '@opensumi/ide-comments/service';
import { WSChannel } from '@opensumi/ide-connection';
import { WSChannelHandler } from '@opensumi/ide-connection/browser';
import { SimpleConnection } from '@opensumi/ide-connection/drivers';
import {
  AppConfig,
  AppLifeCycleServiceToken,
  CommandRegistry,
  CommandRegistryImpl,
  DefaultStorageProvider,
  Deferred,
  Disposable,
  Emitter,
  IContextKeyService,
  ICredentialsService,
  ICryptoService,
  IFileServiceClient,
  IJSONSchemaRegistry,
  IPreferenceSettingsService,
  ISchemaStore,
  IScopedContextKeyService,
  KeybindingRegistry,
  KeybindingRegistryImpl,
  MaybeNull,
  PreferenceProvider,
  StaticResourceService,
  StorageProvider,
  StorageResolverContribution,
  URI,
  Uri,
  createContributionProvider,
} from '@opensumi/ide-core-browser';
import { AppLifeCycleService } from '@opensumi/ide-core-browser/lifecycle';
import { IMenuRegistry, MenuRegistryImpl } from '@opensumi/ide-core-browser/menu';
import { createBrowserInjector } from '@opensumi/ide-dev-tool/browser';
import { mockService } from '@opensumi/ide-dev-tool/injector';
import { MockFileServiceClient } from '@opensumi/ide-dev-tool/mocks/file-service-client';
import { MockContextKeyService } from '@opensumi/ide-dev-tool/mocks/monaco/context-keys';
import { MockPreferenceProvider } from '@opensumi/ide-dev-tool/mocks/preference';
import { MockWorkspaceService } from '@opensumi/ide-dev-tool/mocks/workspace-service';
import {
  IEditor,
  IEditorDocumentModel,
  IEditorGroup,
  INotebookService,
  IOpenResourceResult,
  IResource,
  IUntitledOptions,
  WorkbenchEditorService,
} from '@opensumi/ide-editor';
import {
  EditorComponentRegistry,
  IEditorActionRegistry,
  IEditorDocumentModelContentRegistry,
  IEditorDocumentModelService,
  ResourceService,
} from '@opensumi/ide-editor/browser';
import { ResourceServiceImpl } from '@opensumi/ide-editor/resources';
import { EditorActionRegistryImpl, EditorComponentRegistryImpl, NotebookService } from '@opensumi/ide-editor/runtime';
import { IExtensionStoragePathServer, IExtensionStorageService } from '@opensumi/ide-extension-storage';
import { FileSearchServicePath } from '@opensumi/ide-file-search';
import { IMainLayoutService, MainLayoutContribution } from '@opensumi/ide-main-layout';
import { LayoutService } from '@opensumi/ide-main-layout/layout';
import { MonacoSnippetSuggestProvider, SchemaRegistry, SchemaStore } from '@opensumi/ide-monaco/runtime';
import { PreferenceSettingsService } from '@opensumi/ide-preferences/settings';
import { IGlobalStorageServer, IWorkspaceStorageServer } from '@opensumi/ide-storage';
import { DatabaseStorageContribution } from '@opensumi/ide-storage/contribution';
import { IIconService, IThemeData, IThemeService, IThemeStore } from '@opensumi/ide-theme';
import { IconService } from '@opensumi/ide-theme/browser';
import { ThemeData } from '@opensumi/ide-theme/data';
import { ISemanticTokenRegistry } from '@opensumi/ide-theme/semantic-tokens';
import { SemanticTokenRegistryImpl } from '@opensumi/ide-theme/semantic-tokens/runtime';
import { ThemeStore } from '@opensumi/ide-theme/store';
import { WorkbenchThemeService } from '@opensumi/ide-theme/workbench';
import { IWebviewService } from '@opensumi/ide-webview';
import { IWorkspaceService } from '@opensumi/ide-workspace';
import { IWorkspaceFileService } from '@opensumi/ide-workspace-edit';
import { WorkspaceFileService } from '@opensumi/ide-workspace-edit/files';

import { MockExtNodeClientService } from '../../../__mocks__/extension.service.client';
import { MessagePort, MockWorker } from '../../../__mocks__/worker';
import { ActivationEventServiceImpl } from '../../../src/browser/activation.service';
import { ExtCommandManagementImpl } from '../../../src/browser/extension-command-management';
import { ExtInstanceManagementService } from '../../../src/browser/extension-instance-management';
import { ExtensionManagementService } from '../../../src/browser/extension-management.service';
import { NodeExtProcessService } from '../../../src/browser/extension-node.service';
import { ViewExtProcessService } from '../../../src/browser/extension-view.service';
import { WorkerExtProcessService } from '../../../src/browser/extension-worker.service';
import { ExtensionServiceImpl } from '../../../src/browser/extension.service';
import { BrowserRequireInterceptorContribution } from '../../../src/browser/require-interceptor.contribution';
import { SumiContributionsService, SumiContributionsServiceToken } from '../../../src/browser/sumi/contributes';
import { AbstractExtInstanceManagementService, IActivationEventService } from '../../../src/browser/types';
import { VSCodeContributesService, VSCodeContributesServiceToken } from '../../../src/browser/vscode/contributes';
import { WalkthroughsService } from '../../../src/browser/walkthroughs.service';
import {
  AbstractExtensionManagementService,
  ExtensionNodeServiceServerPath,
  ExtensionService,
  IExtCommandManagement,
  IExtension,
  IExtensionProps,
  IRequireInterceptorService,
  RequireInterceptorContribution,
  RequireInterceptorService,
} from '../../../src/common';
import {
  AbstractNodeExtProcessService,
  AbstractViewExtProcessService,
  AbstractWorkerExtProcessService,
} from '../../../src/common/extension.service';
import { MockExtensionStorageService } from '../../hosted/__mocks__/extensionStorageService';

const mockExtensionProps: IExtensionProps = {
  name: 'sumi-extension',
  id: 'test.sumi-extension',
  activated: false,
  enabled: true,
  path: path.join(__dirname, '../../__mocks__/extension'),
  realPath: path.join(__dirname, '../../__mocks__/extension'),
  extensionLocation: Uri.file(path.join(__dirname, '../../__mocks__/extension')),
  extensionId: 'uuid-for-test-extension',
  isUseEnable: true,
  enableProposedApi: false,
  isBuiltin: false,
  isDevelopment: false,
  packageJSON: {
    name: 'sumi-extension',
    extensionDependencies: ['uuid-for-test-extension-deps'],
    sumiContributes: {
      viewsProxies: ['Leftview', 'TitleView'],
      browserViews: {
        left: {
          type: 'add',
          view: [
            {
              id: 'KaitianViewContribute',
              icon: 'extension',
              title: 'KAIITAN 视图贡献点',
            },
            {
              id: 'Leftview',
              title: 'leftview',
              icon: 'extension',
              titleComponentId: 'TitleView',
            },
          ],
        },
      },
      browserMain: path.join(__dirname, '../../__mocks__/extension/browser.js'),
    },
    contributes: {
      actions: [{ type: 'action', title: 'test action' }],
      commands: [
        {
          command: 'HelloKaitian',
          title: 'HelloKaitian',
          icon: 'icon.svg',
        },
        {
          command: 'Test',
          title: '%test.label%',
          category: '%test.category%',
        },
      ],
      keybindings: [
        {
          command: 'HelloKaitian',
          key: 'ctrl+f1',
          mac: 'cmd+f1',
          when: 'editorTextFocus',
        },
      ],
      menus: {
        'editor/title': [
          {
            when: '!isIdeRunning',
            command: 'HelloKaitian',
            group: 'navigation',
          },
        ],
        'editor/context': [
          {
            when: 'isIdeRunning',
            command: 'HelloKaitian',
          },
        ],
      },
      viewsContainers: {
        activitybar: [
          {
            id: 'package-explorer',
            title: 'Package Explorer',
            icon: 'icon.svg',
          },
          {
            id: 'hold-container',
            title: 'Test Hold',
            icon: 'icon.svg',
          },
        ],
      },
      views: {
        explorer: [
          {
            id: 'mockviews',
            name: 'Mock Views',
            when: 'workspaceHasPackageJSON',
          },
        ],
        'package-explorer': [
          {
            id: 'mockviews',
            name: 'Mock Views',
          },
        ],
      },
      configuration: {
        title: 'Mock Extension Config',
        properties: {
          'mockext.useCodeSnippetsOnMethodSuggest': {
            type: 'boolean',
            default: false,
            description: 'Complete functions with their parameter signature.',
          },
        },
      },
      colors: [
        {
          id: 'mock.superstatus.error',
          description: 'Color for error message in the status bar.',
          defaults: {
            dark: '#ff004f',
            light: '#ff004f',
            highContrast: '#010203',
          },
        },
      ],
      snippets: [
        {
          language: 'javascript',
          path: './javascript.json',
        },
      ],
      walkthroughs: [
        {
          id: 'sample',
          title: 'Sample',
          description: 'A sample walkthrough',
          steps: [
            {
              id: 'runcommand',
              title: 'Run Command',
              description:
                '$(git-commit) This step will run a command and check off once it has been run.\n[Run Command](command:getting-started-sample.runCommand)',
              media: {
                image: 'media/image.png',
                altText: 'Empty image',
              },
              completionEvents: ['onCommand:getting-started-sample.runCommand'],
            },
            {
              id: 'usesvg',
              title: "Use SVG's",
              description:
                'Try out using SVG\'s in your content, they can react to the theme (try: ``var(--vscode-foreground)``) and even host command links (try: ``xlink:href="command:``)',
              media: {
                svg: 'media/image.svg',
                altText: 'Empty svg image',
              },
            },
            {
              id: 'mac',
              title: 'UI Platform: Mac',
              description: 'This step will only show on a Mac.',
              when: 'isMac',
              media: {
                markdown: 'media/mac.md',
              },
            },
          ],
        },
      ],
    },
  },
  extendConfig: {
    worker: {
      main: path.join(__dirname, '../../../__mocks__/extension/worker.js'),
    },
  },
  extraMetadata: {},
  packageNlsJSON: {
    'test.label': 'this is label',
    'test.category': 'this is category',
  },
  defaultPkgNlsJSON: {
    'test.label': 'this is alias',
    'test.category': 'this is aliasCategory',
  },
};

@Injectable()
class MockWorkbenchEditorService implements WorkbenchEditorService {
  onCursorChange = () => Disposable.NULL;
  onDidEditorGroupsChanged = () => Disposable.NULL;
  onDidCurrentEditorGroupChanged = () => Disposable.NULL;
  onActiveResourceChange = () => Disposable.NULL;
  onActiveEditorUriChange = () => Disposable.NULL;

  contributionsReady = new Deferred<void>();

  editorGroups = [];
  sortedEditorGroups: IEditorGroup[];
  currentEditor: IEditor | null;
  currentOrPreviousFocusedEditor: IEditor | null;
  currentResource: MaybeNull<IResource<any>>;
  currentEditorGroup: IEditorGroup;
  closeAll(uri?: URI | undefined, force?: boolean | undefined): Promise<void> {
    throw new Error('Method not implemented.');
  }
  openUris(uri: URI[]): Promise<void> {
    throw new Error('Method not implemented.');
  }
  save(uri: URI): Promise<URI | undefined> {
    throw new Error('Method not implemented.');
  }
  saveAs(uri: URI): Promise<URI | undefined> {
    throw new Error('Method not implemented.');
  }
  saveAll(includeUntitled?: boolean | undefined): Promise<void> {
    throw new Error('Method not implemented.');
  }
  close(uri: any, force?: boolean | undefined): Promise<void> {
    throw new Error('Method not implemented.');
  }
  getAllOpenedUris(): URI[] {
    throw new Error('Method not implemented.');
  }
  getAllOpenedDocuments(): Promise<IEditorDocumentModel[]> {
    throw new Error('Method not implemented.');
  }
  createUntitledResource(options?: IUntitledOptions | undefined): Promise<IOpenResourceResult> {
    throw new Error('Method not implemented.');
  }
  setEditorContextKeyService(contextKeyService: IScopedContextKeyService): void {
    throw new Error('Method not implemented.');
  }
  async open() {
    return {} as any;
  }
  apply() {}
}

const mockExtension = {
  ...mockExtensionProps,
  uri: Uri.file(mockExtensionProps.path),
  contributes: Object.assign(
    mockExtensionProps.packageJSON.contributes,
    mockExtensionProps.packageJSON.sumiContributes,
  ),
  activate: () => true,
  reset() {},
  enable() {},
  toJSON: () => mockExtensionProps,
  getDefaultIcon: () => '',
  addDispose() {},
};

export const MOCK_EXTENSIONS: IExtension[] = [mockExtension];

function mockGlobals() {
  (global as any).fetch = jest.fn().mockResolvedValueOnce({
    ok: true,
    text: async () => fs.readFileSync(path.join(__dirname, '../../../__mocks__/extension/browser-new.js'), 'utf8'),
  });

  (global as any).Worker = MockWorker;
  (global as any).MessagePort = MessagePort;
}

export const mockKaitianExtensionProviders: Provider[] = [
  {
    token: IExtCommandManagement,
    useClass: ExtCommandManagementImpl,
  },
  {
    token: AbstractExtInstanceManagementService,
    useClass: ExtInstanceManagementService,
  },
  {
    token: AbstractExtensionManagementService,
    useClass: ExtensionManagementService,
  },
  {
    token: AbstractNodeExtProcessService,
    useClass: NodeExtProcessService,
  },
  {
    token: AbstractWorkerExtProcessService,
    useClass: WorkerExtProcessService,
  },
  {
    token: AbstractViewExtProcessService,
    useClass: ViewExtProcessService,
  },
  {
    token: ExtensionService,
    useClass: ExtensionServiceImpl,
  },
  {
    token: EditorComponentRegistry,
    useClass: EditorComponentRegistryImpl,
  },
  {
    token: ResourceService,
    useClass: ResourceServiceImpl,
  },
];

export function setupExtensionServiceInjector() {
  mockGlobals();

  const injector = createBrowserInjector([]);
  injector.overrideProviders(
    ...mockKaitianExtensionProviders,
    DatabaseStorageContribution,
    {
      token: AppConfig,
      useValue: {
        isElectronRenderer: false,
        isRemote: true,
        noExtHost: true,
        extWorkerHost: path.join(__dirname, '../../lib/worker-host.js'),
      },
    },
    {
      token: ISemanticTokenRegistry,
      useClass: SemanticTokenRegistryImpl,
    },
    {
      token: StaticResourceService,
      useValue: {
        resolveStaticResource(uri: URI) {
          return uri.withScheme('file');
        },
        resourceRoots: () => [],
      },
    },
    {
      token: CommandRegistry,
      useClass: CommandRegistryImpl,
    },
    {
      token: IMenuRegistry,
      useClass: MenuRegistryImpl,
    },
    {
      token: WorkbenchEditorService,
      useClass: MockWorkbenchEditorService,
    },
    {
      token: AppLifeCycleServiceToken,
      useClass: AppLifeCycleService,
    },
    {
      token: IWebviewService,
      useValue: mockService({}),
    },
    {
      token: ICommentsService,
      useClass: CommentsService,
    },
    {
      token: IEditorActionRegistry,
      useClass: EditorActionRegistryImpl,
    },
    {
      token: IMainLayoutService,
      useClass: LayoutService,
    },
    {
      token: IPreferenceSettingsService,
      useClass: PreferenceSettingsService,
    },
    {
      token: KeybindingRegistry,
      useClass: KeybindingRegistryImpl,
    },
    {
      token: IActivationEventService,
      useClass: ActivationEventServiceImpl,
    },
    {
      token: IContextKeyService,
      useClass: MockContextKeyService,
    },
    {
      token: INotebookService,
      useClass: NotebookService,
    },
    {
      token: IWorkspaceStorageServer,
      useValue: {
        getItems(key) {
          return JSON.stringify({ language: 'zh_CN' });
        },
        init() {
          return Promise.resolve();
        },
      },
    },
    {
      token: IExtensionStorageService,
      useValue: MockExtensionStorageService,
    },
    {
      token: IGlobalStorageServer,
      useValue: {
        getItems(key) {
          return JSON.stringify({ language: 'zh_CN' });
        },
        init() {
          return Promise.resolve();
        },
      },
    },
    {
      token: IExtensionStoragePathServer,
      useValue: {
        getLastStoragePath() {
          return os.tmpdir();
        },
      },
    },
    {
      token: FileSearchServicePath,
      useValue: {
        find: () => Promise.resolve([]),
      },
    },
    {
      token: IWorkspaceService,
      useClass: MockWorkspaceService,
    },
    {
      token: IEditorDocumentModelContentRegistry,
      useValue: {
        registerEditorDocumentModelContentProvider() {},
        getProvider() {},
        getContentForUri() {},
      },
    },
    {
      token: IEditorDocumentModelService,
      useValue: {
        createModelReference() {},
        getAllModels() {
          return [];
        },
      },
    },
    {
      token: IThemeService,
      useClass: WorkbenchThemeService,
    },
    {
      token: IFileServiceClient,
      useClass: MockFileServiceClient,
    },
    {
      token: MonacoSnippetSuggestProvider,
      useClass: MonacoSnippetSuggestProvider,
    },
    {
      token: WorkbenchEditorService,
      useClass: MockWorkbenchEditorService,
    },
    {
      token: IIconService,
      useClass: IconService,
    },
    {
      token: StorageProvider,
      useFactory: () => (storageId) => injector.get(DefaultStorageProvider).get(storageId),
    },
    {
      token: PreferenceProvider,
      useClass: MockPreferenceProvider,
    },
    {
      token: WSChannelHandler,
      useValue: {
        clientId: 'mock_id' + Math.random(),
        openChannel() {
          return new WSChannel(new SimpleConnection(), { id: 'mock_wschannel' });
        },
      },
    },
    {
      token: ExtensionNodeServiceServerPath,
      useClass: MockExtNodeClientService,
    },
    {
      token: ISchemaStore,
      useClass: SchemaStore,
    },
    {
      token: IJSONSchemaRegistry,
      useClass: SchemaRegistry,
    },
    {
      token: IRequireInterceptorService,
      useClass: RequireInterceptorService,
    },
    {
      token: IWorkspaceFileService,
      useClass: WorkspaceFileService,
    },
    {
      token: WalkthroughsService,
      useClass: WalkthroughsService,
    },
    {
      token: IThemeData,
      useClass: ThemeData,
    },
    {
      token: IThemeStore,
      useClass: ThemeStore,
    },
    BrowserRequireInterceptorContribution,
  );

  injector.overrideProviders(
    {
      token: ICryptoService,
      useValue: mockService({}),
    },
    {
      token: ICredentialsService,
      useValue: mockService({
        onDidChangePassword: new Emitter().event,
      }),
    },
    {
      token: VSCodeContributesServiceToken,
      useClass: VSCodeContributesService,
    },
    {
      token: SumiContributionsServiceToken,
      useClass: SumiContributionsService,
    },
  );

  createContributionProvider(injector, StorageResolverContribution);
  createContributionProvider(injector, MainLayoutContribution);
  createContributionProvider(injector, RequireInterceptorContribution);

  return injector;
}
