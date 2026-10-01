import { Disposable, IContextKeyService, QuickPickService } from '@opensumi/ide-core-browser';
import { DebugModelFactory, IDebugServer } from '@opensumi/ide-debug';
import { createBrowserInjector } from '@opensumi/ide-dev-tool/browser';
import { EditorCollectionService, WorkbenchEditorService } from '@opensumi/ide-editor';
import { IEditorDocumentModelService } from '@opensumi/ide-editor/browser';
import { IFileServiceClient } from '@opensumi/ide-file-service';
import { IWorkspaceService, IWorkspaceStorageService } from '@opensumi/ide-workspace';

import { BreakpointManager } from '../../../src/browser/breakpoint';
import { DebugConfigurationManager } from '../../../src/browser/debug-configuration-manager';
import { DebugPreferences } from '../../../src/browser/debug-preferences';
import { DebugModelManager } from '../../../src/browser/editor';

describe('Debug Model Manager', () => {
  const mockInjector = createBrowserInjector([]);
  let debugModelManager: DebugModelManager;

  const mockEditorCollectionService = {
    onCodeEditorCreate: jest.fn(() => Disposable.create(() => {})),
  };

  const mockBreakpointManager = {
    onDidChangeBreakpoints: jest.fn(() => Disposable.create(() => {})),
  };

  beforeAll(() => {
    mockInjector.overrideProviders({
      token: EditorCollectionService,
      useValue: mockEditorCollectionService,
    });

    mockInjector.overrideProviders({
      token: BreakpointManager,
      useValue: mockBreakpointManager,
    });

    mockInjector.overrideProviders({
      token: WorkbenchEditorService,
      useValue: {},
    });

    mockInjector.overrideProviders({
      token: DebugConfigurationManager,
      useValue: {},
    });

    mockInjector.overrideProviders({
      token: DebugModelFactory,
      useValue: {},
    });

    mockInjector.overrideProviders({
      token: IFileServiceClient,
      useValue: {},
    });

    mockInjector.overrideProviders({
      token: IWorkspaceStorageService,
      useValue: {},
    });

    mockInjector.overrideProviders({
      token: IWorkspaceService,
      useValue: {},
    });

    mockInjector.overrideProviders({
      token: IDebugServer,
      useValue: {},
    });

    mockInjector.overrideProviders({
      token: DebugPreferences,
      useValue: {},
    });

    mockInjector.overrideProviders({
      token: QuickPickService,
      useValue: {},
    });

    mockInjector.overrideProviders({
      token: IContextKeyService,
      useValue: {},
    });

    mockInjector.overrideProviders({
      token: IEditorDocumentModelService,
      useValue: {},
    });

    debugModelManager = mockInjector.get(DebugModelManager);
  });

  afterAll(() => {});

  it('debugModelManager should be init success', () => {
    debugModelManager.init();
    expect(mockEditorCollectionService.onCodeEditorCreate).toHaveBeenCalledTimes(1);
    expect(mockBreakpointManager.onDidChangeBreakpoints).toHaveBeenCalledTimes(1);
  });

  it('should have enough API', () => {
    expect(typeof debugModelManager.init).toBe('function');
    expect(typeof debugModelManager.dispose).toBe('function');
    expect(typeof debugModelManager.resolve).toBe('function');
    expect(typeof debugModelManager.handleMouseEvent).toBe('function');
  });
});
