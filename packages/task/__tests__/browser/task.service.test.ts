import { IJSONSchemaRegistry, ISchemaStore, PreferenceService, QuickOpenService } from '@opensumi/ide-core-browser';
import { FileUri, Uri } from '@opensumi/ide-core-common';
import { HashCalculateServiceImpl, IHashCalculateService } from '@opensumi/ide-core-common/hash';
import { createBrowserInjector } from '@opensumi/ide-dev-tool/browser';
import { MockWalkThroughSnippetSchemeDocumentProvider } from '@opensumi/ide-dev-tool/mocks/file-scheme-document';
import { MockedMonacoService } from '@opensumi/ide-dev-tool/mocks/monaco/service';
import { MockQuickOpenService } from '@opensumi/ide-dev-tool/mocks/quick-open';
import { MockWorkspaceService } from '@opensumi/ide-dev-tool/mocks/workspace-service';
import { IDocPersistentCacheProvider } from '@opensumi/ide-editor';
import {
  EmptyDocCacheImpl,
  IEditorDocumentModelContentRegistry,
  IEditorDocumentModelService,
} from '@opensumi/ide-editor/browser';
import { EditorDocumentModelContentRegistryImpl, EditorDocumentModelServiceImpl } from '@opensumi/ide-editor/documents';
import { IMainLayoutService } from '@opensumi/ide-main-layout';
import { LayoutService } from '@opensumi/ide-main-layout/layout';
import { MonacoService } from '@opensumi/ide-monaco';
import { SchemaRegistry, SchemaStore } from '@opensumi/ide-monaco/runtime';
import { OutputPreferences } from '@opensumi/ide-output/preferences';
import { IWorkspaceService } from '@opensumi/ide-workspace';

import { schema, taskSchemaUri } from '../../src/browser/task.schema';
import { TaskService } from '../../src/browser/task.service';
import { TerminalTaskSystem } from '../../src/browser/terminal-task-system';
import { ITaskProvider, ITaskService, ITaskSystem } from '../../src/common';

const path = require('path');

const preferences: Map<string, any> = new Map();

const mockedPreferenceService: any = {
  get: (k) => preferences.get(k),
  set: (k, v) => {
    preferences.set(k, v);
  },
  onPreferenceChanged: (listener) => ({
    dispose: () => {},
  }),
};

describe('TaskService Test Suite', () => {
  const injector = createBrowserInjector([]);
  let taskService: ITaskService;
  let workspace: MockWorkspaceService;
  injector.addProviders(
    ...[
      {
        token: QuickOpenService,
        useClass: MockQuickOpenService,
      },

      {
        token: PreferenceService,
        useValue: mockedPreferenceService,
      },
      {
        token: MonacoService,
        useClass: MockedMonacoService,
      },
      {
        token: IEditorDocumentModelContentRegistry,
        useClass: EditorDocumentModelContentRegistryImpl,
      },
      {
        token: IHashCalculateService,
        useClass: HashCalculateServiceImpl,
      },
      {
        token: IEditorDocumentModelService,
        useClass: EditorDocumentModelServiceImpl,
      },
      {
        token: ITaskService,
        useClass: TaskService,
      },
      {
        token: ITaskSystem,
        useClass: TerminalTaskSystem,
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
        token: IMainLayoutService,
        useClass: LayoutService,
      },
      {
        token: OutputPreferences,
        useValue: {
          'output.logWhenNoPanel': true,
        },
      },
      {
        token: IWorkspaceService,
        useClass: MockWorkspaceService,
      },
      {
        token: IDocPersistentCacheProvider,
        useClass: EmptyDocCacheImpl,
      },
    ],
  );

  beforeAll(async () => {
    injector.overrideProviders({
      token: PreferenceService,
      useValue: {
        onPreferenceChanged: jest.fn(() => ({ dispose: () => {} })),
        get: () => ({
          version: '2.0.0',
          tasks: [
            {
              type: 'shell',
              label: 'Echo Hello',
              command: 'echo',
              args: ["'hello'"],
              options: {
                cwd: '${workspaceFolder}',
              },
            },
          ],
        }),
      },
    });
    const documentRegistry = injector.get<IEditorDocumentModelContentRegistry>(IEditorDocumentModelContentRegistry);
    documentRegistry.registerEditorDocumentModelContentProvider(
      injector.get(MockWalkThroughSnippetSchemeDocumentProvider),
    );
    taskService = injector.get<ITaskService>(ITaskService);
    workspace = injector.get<MockWorkspaceService>(IWorkspaceService);
    const schemaRegistry: IJSONSchemaRegistry = injector.get(IJSONSchemaRegistry);

    schemaRegistry.registerSchema(taskSchemaUri, schema, ['tasks.json']);
    const rootPath = path.resolve(__dirname);
    const rootUri = FileUri.create(rootPath).toString();
    workspace.setWorkspace({
      uri: rootUri,
      isDirectory: true,
      lastModification: 0,
    });
  });
  it('registerTaskProider should be work', () => {
    const provider: ITaskProvider = {
      provideTasks: () => Promise.resolve({ tasks: [] }),
      resolveTask: (task) => Promise.resolve(undefined),
    };
    const disposable = taskService.registerTaskProvider(provider, 'test-suite-provider');
    expect(typeof disposable.dispose).toBe('function');
  });

  it('get all tasks should be work', async () => {
    const tasks = await taskService.tasks({ type: 'test-suite-provider' });
    expect(tasks.length).toBe(0);
  });

  it('getWorkspaceTask should be work', async () => {
    const task = await taskService.getTask(Uri.file(path.resolve(__dirname)), 'Echo Hello');
    expect(task).toBeDefined();
    expect(task?._label).toBe('Echo Hello');
  });

  it('runtask command should be work', (done) => {
    injector.mock(QuickOpenService, 'open', (model) => {
      done();
    });
    taskService.runTaskCommand();
  });
});
