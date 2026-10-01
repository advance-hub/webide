import { IEventBus, URI } from '@opensumi/ide-core-browser';
import { createBrowserInjector } from '@opensumi/ide-dev-tool/browser';
import { MockInjector } from '@opensumi/ide-dev-tool/injector';
import { TestEditorDocumentProvider } from '@opensumi/ide-dev-tool/mocks/editor-providers';
import { useMockStorage } from '@opensumi/ide-dev-tool/mocks/storage';
import { IDocPersistentCacheProvider } from '@opensumi/ide-editor';
import { StandaloneServices } from '@opensumi/ide-monaco/api/services';
import { ILanguageService } from '@opensumi/monaco-editor-core/esm/vs/editor/common/languages/language';

import {
  EditorDocumentModelCreationEvent,
  EmptyDocCacheImpl,
  IEditorDocumentModelContentRegistry,
  IEditorDocumentModelService,
} from '../../../src/browser';
import {
  EditorDocumentModelContentRegistryImpl,
  EditorDocumentModelServiceImpl,
} from '../../../src/browser/doc-model/main';

describe('EditorDocumentModelService', () => {
  let injector: MockInjector;

  beforeAll(() => {
    injector = createBrowserInjector([]);
    injector.addProviders(
      {
        token: IEditorDocumentModelService,
        useClass: EditorDocumentModelServiceImpl,
      },
      {
        token: IEditorDocumentModelContentRegistry,
        useClass: EditorDocumentModelContentRegistryImpl,
      },
      {
        token: IDocPersistentCacheProvider,
        useClass: EmptyDocCacheImpl,
      },
    );
    useMockStorage(injector);
    const editorDocModelRegistry: IEditorDocumentModelContentRegistry = injector.get(
      IEditorDocumentModelContentRegistry,
    );
    editorDocModelRegistry.registerEditorDocumentModelContentProvider(TestEditorDocumentProvider);
  });

  it('chooseEncoding', async () => {
    const languageService = StandaloneServices.get(ILanguageService);
    languageService.registerLanguage({
      id: 'javascript',
      aliases: ['JavaScript'],
      extensions: ['.js'],
    });
    const editorDocModelService: IEditorDocumentModelService = injector.get(IEditorDocumentModelService);

    const testCodeUri = new URI('test://testUri1.js');
    const testDoc1 = await editorDocModelService.createModelReference(testCodeUri);
    expect(testDoc1.instance.encoding).toBe('utf8');
    await editorDocModelService.changeModelOptions(testCodeUri, { encoding: 'gbk', languageId: 'javascript' });
    expect(testDoc1.instance.encoding).toBe('gbk');
    expect(testDoc1.instance.languageId).toBe('javascript');
  });

  it('create doc', async () => {
    const createFn = jest.fn();
    const disposer = injector.get<IEventBus>(IEventBus).on(EditorDocumentModelCreationEvent, createFn);

    const editorDocModelService: IEditorDocumentModelService = injector.get(IEditorDocumentModelService);

    const testCodeUri = new URI('test://testUri2');
    const testDoc2 = await editorDocModelService.createModelReference(testCodeUri);
    expect(createFn).toHaveBeenCalledTimes(1);

    disposer.dispose();
  });
});
