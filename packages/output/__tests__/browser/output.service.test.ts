import { Injectable } from '@opensumi/di';
import { PreferenceService } from '@opensumi/ide-core-browser';
import { HashCalculateServiceImpl, IHashCalculateService } from '@opensumi/ide-core-common/hash';
import { createBrowserInjector } from '@opensumi/ide-dev-tool/browser';
import { MockWalkThroughSnippetSchemeDocumentProvider } from '@opensumi/ide-dev-tool/mocks/file-scheme-document';
import { MockedMonacoService } from '@opensumi/ide-dev-tool/mocks/monaco/service';
import { MockWorkspaceService } from '@opensumi/ide-dev-tool/mocks/workspace-service';
import { IDocPersistentCacheProvider } from '@opensumi/ide-editor';
import {
  EmptyDocCacheImpl,
  IEditorDocumentModelContentRegistry,
  IEditorDocumentModelService,
} from '@opensumi/ide-editor/browser';
import { EditorDocumentModelContentRegistryImpl, EditorDocumentModelServiceImpl } from '@opensumi/ide-editor/documents';
import { IMainLayoutService } from '@opensumi/ide-main-layout';
import { MonacoService } from '@opensumi/ide-monaco';
import { IWorkspaceService } from '@opensumi/ide-workspace';

import { OutputPreferences } from '../../src/browser/output-preference';
import { OutputService } from '../../src/browser/output.service';

@Injectable()
class MockMainLayoutService {
  getTabbarHandler() {
    return {
      isVisible: false,
      activate() {},
    };
  }
}

const preferences: Map<string, any> = new Map();

const mockedPreferenceService: any = {
  get: (k) => preferences.get(k),
  set: (k, v) => {
    preferences.set(k, v);
  },
  onPreferenceChanged: (listener) =>
    //
    ({
      dispose: () => {},
    }),
};

describe('Output.service.ts', () => {
  // let mockPreferenceVal = false;
  let outputService: OutputService;

  const injector = createBrowserInjector([]);
  injector.overrideProviders(
    ...[
      {
        token: IMainLayoutService,
        useClass: MockMainLayoutService,
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
        token: OutputService,
        useClass: OutputService,
      },
      {
        token: IWorkspaceService,
        useClass: MockWorkspaceService,
      },
      {
        token: IEditorDocumentModelService,
        useClass: EditorDocumentModelServiceImpl,
      },
      {
        token: OutputPreferences,
        useValue: {
          'output.logWhenNoPanel': true,
        },
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
        token: IDocPersistentCacheProvider,
        useClass: EmptyDocCacheImpl,
      },
    ],
  );

  beforeAll(async () => {
    const documentRegistry = injector.get<IEditorDocumentModelContentRegistry>(IEditorDocumentModelContentRegistry);
    documentRegistry.registerEditorDocumentModelContentProvider(
      injector.get(MockWalkThroughSnippetSchemeDocumentProvider),
    );
    injector.get(MonacoService);
    outputService = injector.get(OutputService);
  });

  test('getChannel', () => {
    const output = outputService.getChannel('1');
    expect(output?.name).toEqual('1');
    outputService.deleteChannel('1');
  });

  test('deleteChannel', () => {
    const origLength = outputService.getChannels.get().length;
    outputService.getChannel('1');
    outputService.deleteChannel('1');
    expect(outputService.getChannels.get().length).toEqual(origLength);
  });

  test('getChannels', () => {
    const origLength = outputService.getChannels.get().length;
    outputService.getChannel('1');
    outputService.deleteChannel('1');
    expect(outputService.getChannels.get().length).toEqual(origLength);
  });
});
