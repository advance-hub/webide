import { MonacoService } from '@opensumi/ide-core-browser';
import { IDocPersistentCacheProvider } from '@opensumi/ide-editor';
import {
  EditorCollectionService,
  EditorComponentRegistry,
  EmptyDocCacheImpl,
  IEditorDecorationCollectionService,
  IEditorDocumentModelContentRegistry,
  IEditorDocumentModelService,
  IEditorFeatureRegistry,
  ILanguageService,
  ResourceService,
  WorkbenchEditorService,
} from '@opensumi/ide-editor/browser';
import { EditorDocumentModelServiceImpl } from '@opensumi/ide-editor/documents';
import { EditorDocumentModelContentRegistryImpl } from '@opensumi/ide-editor/documents';
import { ResourceServiceImpl } from '@opensumi/ide-editor/resources';
import { EditorComponentRegistryImpl } from '@opensumi/ide-editor/runtime';
import { EditorCollectionServiceImpl } from '@opensumi/ide-editor/runtime';
import { EditorDecorationCollectionService } from '@opensumi/ide-editor/runtime';
import { EditorFeatureRegistryImpl } from '@opensumi/ide-editor/runtime';
import { LanguageService } from '@opensumi/ide-editor/runtime';
import { WorkbenchEditorServiceImpl } from '@opensumi/ide-editor/workbench';
import { IWorkspaceService } from '@opensumi/ide-workspace';

import { MockInjector } from './mock-injector';
import { TestEditorDocumentProvider } from './mocks/editor-providers';
import { MockedMonacoService } from './mocks/monaco/monaco.service.mock';
import { MockWorkspaceService } from './mocks/workspace-service';

export function addEditorProviders(injector: MockInjector) {
  injector.addProviders(
    {
      token: IDocPersistentCacheProvider,
      useClass: EmptyDocCacheImpl,
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
      token: EditorCollectionService,
      useClass: EditorCollectionServiceImpl,
    },
    {
      token: WorkbenchEditorService,
      useClass: WorkbenchEditorServiceImpl,
    },
    {
      token: ResourceService,
      useClass: ResourceServiceImpl,
    },
    {
      token: EditorComponentRegistry,
      useClass: EditorComponentRegistryImpl,
    },
    {
      token: IEditorDecorationCollectionService,
      useClass: EditorDecorationCollectionService,
    },
    {
      token: ILanguageService,
      useClass: LanguageService,
    },
    {
      token: MonacoService,
      useClass: MockedMonacoService,
    },
    {
      token: IWorkspaceService,
      useClass: MockWorkspaceService,
    },
    {
      token: IEditorFeatureRegistry,
      useClass: EditorFeatureRegistryImpl,
    },
  );
  const editorDocModelRegistry: IEditorDocumentModelContentRegistry = injector.get(IEditorDocumentModelContentRegistry);
  editorDocModelRegistry.registerEditorDocumentModelContentProvider(TestEditorDocumentProvider);
}
