import path from 'path';

import isEqual from 'lodash/isEqual';

import {
  CorePreferences,
  IContextKeyService,
  MonacoOverrideServiceRegistry,
  RecentFilesManager,
  URI,
} from '@opensumi/ide-core-browser';
import {
  CommonServerPath,
  Deferred,
  Emitter,
  IApplicationService,
  IEventBus,
  OS,
  sleep,
} from '@opensumi/ide-core-common';
import { createBrowserInjector } from '@opensumi/ide-dev-tool/browser';
import { TestEditorDocumentProvider, TestResourceResolver } from '@opensumi/ide-dev-tool/mocks/editor-providers';
import { createMockPairRPCProtocol } from '@opensumi/ide-dev-tool/mocks/extension-rpc';
import { MockFileServiceClient } from '@opensumi/ide-dev-tool/mocks/file-service-client';
import { MockContextKeyService } from '@opensumi/ide-dev-tool/mocks/monaco/context-keys';
import { injectMockPreferences } from '@opensumi/ide-dev-tool/mocks/preference';
import { useMockStorage } from '@opensumi/ide-dev-tool/mocks/storage';
import { MockWorkspaceService } from '@opensumi/ide-dev-tool/mocks/workspace-service';
import {
  EditorCollectionService,
  IDocPersistentCacheProvider,
  ILanguageService,
  IResource,
  ResourceService,
  WorkbenchEditorService,
} from '@opensumi/ide-editor';
import {
  EditorModule,
  EditorPreferences,
  EmptyDocCacheImpl,
  IEditorDecorationCollectionService,
  IEditorDocumentModelContentRegistry,
  IEditorDocumentModelService,
  IEditorFeatureRegistry,
} from '@opensumi/ide-editor/browser';
import { EditorDocumentModelContentRegistryImpl, EditorDocumentModelServiceImpl } from '@opensumi/ide-editor/documents';
import {
  BaseFileSystemEditorDocumentProvider,
  FileSystemResourceProvider,
  ResourceServiceImpl,
} from '@opensumi/ide-editor/resources';
import {
  EditorCollectionServiceImpl,
  EditorComponentRegistryImpl,
  EditorDecorationCollectionService,
  EditorFeatureRegistryImpl,
  LanguageService,
} from '@opensumi/ide-editor/runtime';
import {
  EditorComponentRegistry,
  EditorGroupIndexChangedEvent,
  EditorSelectionChangeEvent,
  EditorVisibleChangeEvent,
} from '@opensumi/ide-editor/types';
import { EditorGroup, WorkbenchEditorServiceImpl } from '@opensumi/ide-editor/workbench';
import { IFileServiceClient } from '@opensumi/ide-file-service';
import { FileServiceContribution } from '@opensumi/ide-file-service/browser/contribution';
import { MonacoService } from '@opensumi/ide-monaco';
import * as monaco from '@opensumi/ide-monaco';
import MonacoServiceImpl, { MonacoOverrideServiceRegistryImpl } from '@opensumi/ide-monaco/runtime';
import { IDialogService } from '@opensumi/ide-overlay';
import { IWorkspaceService } from '@opensumi/ide-workspace';
import {
  ConfigurationTarget,
  IConfigurationChangeEvent,
  IConfigurationService,
} from '@opensumi/monaco-editor-core/esm/vs/platform/configuration/common/configuration';

import { ExtensionServiceImpl } from '../../src/browser/extension.service';
import { MainThreadExtensionDocumentData } from '../../src/browser/vscode/api/main.thread.doc';
import { MainThreadEditorService } from '../../src/browser/vscode/api/main.thread.editor';
import { ExtensionService } from '../../src/common';
import { ExtHostAPIIdentifier, MainThreadAPIIdentifier } from '../../src/common/vscode';
import * as TypeConverts from '../../src/common/vscode/converter';
import * as types from '../../src/common/vscode/ext-types';
import { ExtensionDocumentDataManagerImpl } from '../../src/hosted/api/vscode/doc';
import { ExtensionHostEditorService } from '../../src/hosted/api/vscode/editor/editor.host';

const { rpcProtocolExt, rpcProtocolMain } = createMockPairRPCProtocol();

const preferences: Map<string, any> = new Map();
const emitter = new Emitter<IConfigurationChangeEvent>();

const mockConfigurationService: any = {
  onDidChangeConfiguration: emitter.event,
  getValue: (k) => preferences.get(k),
  setValue: (k, v) => {
    emitter.fire({
      source: ConfigurationTarget.USER,
      affectedKeys: new Set(k),
      change: {
        keys: [k],
        overrides: [],
      },
      affectsConfiguration: (() => {}) as any,
    });
    preferences.set(k, v);
  },
};

describe('MainThreadEditor Test Suites', () => {
  let injector;
  let extEditor: ExtensionHostEditorService;
  let workbenchEditorService: WorkbenchEditorService;
  let eventBus: IEventBus;
  let editorGroup: EditorGroup;

  const disposables: types.OutputChannel[] = [];
  beforeAll(async () => {
    injector = createBrowserInjector([EditorModule]);
    injector.addProviders(
      ...[
        FileServiceContribution,
        {
          token: WorkbenchEditorService,
          useClass: WorkbenchEditorServiceImpl,
        },
        {
          token: IEditorDecorationCollectionService,
          useClass: EditorDecorationCollectionService,
        },
        {
          token: ResourceService,
          useClass: ResourceServiceImpl,
        },
        {
          token: IConfigurationService,
          useValue: mockConfigurationService,
        },
        {
          token: EditorCollectionService,
          useClass: EditorCollectionServiceImpl,
        },
        {
          token: ExtensionService,
          useClass: ExtensionServiceImpl,
        },
        {
          token: IEditorDocumentModelContentRegistry,
          useClass: EditorDocumentModelContentRegistryImpl,
        },
        {
          token: IEditorDocumentModelService,
          useClass: EditorDocumentModelServiceImpl,
        },
        {
          token: IEditorFeatureRegistry,
          useClass: EditorFeatureRegistryImpl,
        },
        {
          token: ILanguageService,
          useClass: LanguageService,
        },
        {
          token: MonacoService,
          useClass: MonacoServiceImpl,
        },
        {
          token: IDocPersistentCacheProvider,
          useClass: EmptyDocCacheImpl,
        },
        {
          token: IWorkspaceService,
          useClass: MockWorkspaceService,
        },
        {
          token: EditorComponentRegistry,
          useClass: EditorComponentRegistryImpl,
        },
        {
          token: BaseFileSystemEditorDocumentProvider,
          useClass: BaseFileSystemEditorDocumentProvider,
        },
        {
          token: IFileServiceClient,
          useClass: MockFileServiceClient,
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
          token: MonacoOverrideServiceRegistry,
          useClass: MonacoOverrideServiceRegistryImpl,
        },
        {
          token: CommonServerPath,
          useValue: {
            getBackendOS: () => Promise.resolve(OS.type()),
          },
        },
      ],
    );
    useMockStorage(injector);
    injectMockPreferences(injector);

    injector.overrideProviders({
      token: CorePreferences,
      useValue: {
        'files.encoding': 'utf8',
        'files.eol': 'auto',
      },
    });
    injector.overrideProviders({
      token: EditorPreferences,
      useValue: {
        'editor.previewMode': true,
      },
    });
    injector.overrideProviders({
      token: RecentFilesManager,
      useValue: {
        setMostRecentlyOpenedFile: () => undefined,
        updateMostRecentlyOpenedFile: () => undefined,
      },
    });
    workbenchEditorService = injector.get(WorkbenchEditorService);
    const extHostDocs = rpcProtocolExt.set(
      ExtHostAPIIdentifier.ExtHostDocuments,
      new ExtensionDocumentDataManagerImpl(rpcProtocolExt),
    );
    extEditor = new ExtensionHostEditorService(rpcProtocolExt, extHostDocs);
    rpcProtocolExt.set(ExtHostAPIIdentifier.ExtHostEditors, extEditor);
    const MainThreadExtensionDocumentDataAPI = injector.get(MainThreadExtensionDocumentData, [rpcProtocolMain]);
    rpcProtocolMain.set(
      MainThreadAPIIdentifier.MainThreadEditors,
      injector.get(MainThreadEditorService, [rpcProtocolMain, MainThreadExtensionDocumentDataAPI]),
    );
    const modelContentRegistry: IEditorDocumentModelContentRegistry = injector.get(IEditorDocumentModelContentRegistry);
    modelContentRegistry.registerEditorDocumentModelContentProvider(TestEditorDocumentProvider);
    const componentRegistry: EditorComponentRegistry = injector.get(EditorComponentRegistry);
    modelContentRegistry.registerEditorDocumentModelContentProvider(injector.get(BaseFileSystemEditorDocumentProvider));
    componentRegistry.registerEditorComponentResolver('file', TestResourceResolver);
    const resourceService: ResourceService = injector.get(ResourceService);
    resourceService.registerResourceProvider(injector.get(FileSystemResourceProvider));
    const extensionService: ExtensionService = injector.get(ExtensionService);
    const globalContextKeyService: IContextKeyService = injector.get(IContextKeyService);
    const editorContextKeyService = globalContextKeyService.createScoped();
    workbenchEditorService.setEditorContextKeyService(editorContextKeyService);
    (workbenchEditorService as WorkbenchEditorServiceImpl).prepareContextKeyService();
    extensionService.eagerExtensionsActivated.resolve();
    eventBus = injector.get(IEventBus);
    (workbenchEditorService as any).contributionsReady.resolve();

    // IApplicationService 不知道从哪里引入的，没法 overrideProvider 一个 mock 的实现..
    await injector.get(IApplicationService).initializeData();

    await workbenchEditorService.initialize();
    editorGroup = workbenchEditorService.currentEditorGroup as EditorGroup;
    await editorGroup.createEditor(document.createElement('div'));
    await editorGroup.open(URI.file(path.join(__dirname, 'main.thread.output.test.ts')));
  });

  afterAll(() => {
    for (const disposable of disposables) {
      disposable.dispose();
    }
  });

  it('should be able to get activeTextEditor and receive texteditor changed event', async () => {
    const deferred = new Deferred<void>();
    const disposer = extEditor.onDidChangeActiveTextEditor((e) => {
      try {
        expect(e).toBeDefined();
        expect(extEditor.activeEditor?.textEditor).toBeDefined();
        expect(extEditor.activeEditor?.textEditor.document.fileName).toBe(
          path.join(__dirname, 'main.thread.output.test1.ts'),
        );
        deferred.resolve();
      } catch (error) {
        deferred.reject(error);
      } finally {
        disposer.dispose();
      }
    });

    await editorGroup.open(URI.file(path.join(__dirname, 'main.thread.output.test1.ts')));
    await deferred.promise;
  });

  it('should be able to get visibleTextEditors', async () => {
    const visibleTextEditors = extEditor.visibleEditors;
    expect(visibleTextEditors.length).toBe(1);
  });

  it('should receive Selectionchanged event when editor selection is changed', async () => {
    const deferred = new Deferred<void>();
    const disposer = extEditor.onDidChangeTextEditorSelection((e) => {
      try {
        expect(e.selections.length).toBe(1);
        expect(e.selections[0]).toBeDefined();
        expect(isEqual(TypeConverts.Selection.from(e.selections[0]), selection)).toBeTruthy();
        deferred.resolve();
      } catch (error) {
        deferred.reject(error);
      } finally {
        disposer.dispose();
      }
    });
    const resource = workbenchEditorService.currentResource as IResource;
    const selection = {
      selectionStartLineNumber: 1,
      selectionStartColumn: 1,
      positionLineNumber: 3,
      positionColumn: 10,
    };
    eventBus.fire(
      new EditorSelectionChangeEvent({
        group: workbenchEditorService.currentEditorGroup,
        resource: (workbenchEditorService.currentResource as IResource) || resource,
        selections: [new monaco.Selection(1, 1, 3, 10)],
        source: 'test',
        editorUri: resource.uri,
      }),
    );

    await deferred.promise;
  });

  it(
    'should receive onDidChangeTextEditorVisibleRanges event when editor visible range has changed',
    async () => {
      const resource = workbenchEditorService.currentResource as IResource;

      const defered = new Deferred<void>();
      const disposer = extEditor.onDidChangeTextEditorVisibleRanges((e) => {
        // e.payload.uri 是 mock 的，这里用 textEditor.id 来判断
        if (!(e.textEditor as any).id.includes(resource.uri.toString())) {
          return;
        }

        const converted = e.visibleRanges.map((v) => TypeConverts.Range.from(v));
        if (
          converted.length !== 1 ||
          converted[0].startLineNumber !== 1 ||
          converted[0].startColumn !== 12 ||
          converted[0].endLineNumber !== 1 ||
          converted[0].endColumn !== 12
        ) {
          return;
        }

        disposer.dispose();
        expect(converted.length).toBe(1);
        expect(converted[0]).toEqual({
          startLineNumber: 1,
          startColumn: 12,
          endLineNumber: 1,
          endColumn: 12,
        });

        defered.resolve();
      });

      await sleep(3 * 1000);

      eventBus.fire(
        new EditorVisibleChangeEvent({
          group: workbenchEditorService.currentEditorGroup,
          resource,
          visibleRanges: [new monaco.Range(1, 12, 1, 12)],
          editorUri: resource.uri,
        }),
      );

      await defered.promise;
    },
    10 * 1000,
  );

  it.skip('should receive onDidChangeTextEditorViewColumn event when editor view column has changed', (done) => {
    extEditor.onDidChangeTextEditorViewColumn((e) => {
      expect(e.viewColumn).toBe(2);
      done();
    });
    eventBus.fire(new EditorGroupIndexChangedEvent({ group: workbenchEditorService.currentEditorGroup, index: 1 }));
  });

  it.skip('should receive TextEditorOptions changed event.', (done) => {
    const modelOptions: monaco.editor.ITextModelUpdateOptions = {
      tabSize: 8,
      indentSize: 8,
      insertSpaces: true,
    };
    extEditor.onDidChangeTextEditorOptions((e) => {
      expect(e.options).toBeDefined();
      done();
    });
    workbenchEditorService.currentEditor?.updateOptions({}, modelOptions);
  });

  it('should be able to insert snippet', async () => {
    const snippetString = new types.SnippetString(`
      import React from 'react';
    `);
    await extEditor.activeEditor?.textEditor.insertSnippet(snippetString);
  });

  it('should be able to edit document', async () => {
    await extEditor.activeEditor?.textEditor.edit((builder) => {
      builder.insert(new types.Position(1, 1), 'hello');
    });
    expect(extEditor.activeEditor?.textEditor.document.getText()).toBe(
      workbenchEditorService.currentEditor?.monacoEditor.getValue(),
    );
  });

  it('should receive undefined when close all editor', async () => {
    const visibleEditorsDeferred = new Deferred<void>();
    const activeEditorDeferred = new Deferred<void>();
    const visibleEditorsDisposer = extEditor.onDidChangeVisibleTextEditors((e) => {
      if (e.length === 0) {
        visibleEditorsDeferred.resolve();
      }
    });
    const activeEditorDisposer = extEditor.onDidChangeActiveTextEditor((e) => {
      try {
        expect(e).toBeUndefined();
        activeEditorDeferred.resolve();
      } catch (error) {
        activeEditorDeferred.reject(error);
      }
    });

    try {
      await workbenchEditorService.closeAll(undefined, true);
      await Promise.all([visibleEditorsDeferred.promise, activeEditorDeferred.promise]);
    } finally {
      visibleEditorsDisposer.dispose();
      activeEditorDisposer.dispose();
    }
  });
});
