import { WSChannel } from '@opensumi/ide-connection';
import { WSChannelHandler } from '@opensumi/ide-connection/browser';
import { SimpleConnection } from '@opensumi/ide-connection/drivers';
import { IContextKeyService, IFileServiceClient } from '@opensumi/ide-core-browser';
import { Disposable } from '@opensumi/ide-core-common';
import {
  DebugModelFactory,
  DebugSessionOptions,
  IDebugServer,
  IDebugSession,
  IDebugSessionManager,
} from '@opensumi/ide-debug';
import { createBrowserInjector } from '@opensumi/ide-dev-tool/browser';
import { WorkbenchEditorService } from '@opensumi/ide-editor';
import { IEditorDocumentModelService } from '@opensumi/ide-editor/browser';
import { IMainLayoutService } from '@opensumi/ide-main-layout';
import { LayoutService } from '@opensumi/ide-main-layout/layout';
import { OutputService } from '@opensumi/ide-output/service';
import { IMessageService } from '@opensumi/ide-overlay';
import { QuickPickService } from '@opensumi/ide-quick-open';
import { ITaskService } from '@opensumi/ide-task';
import { ITerminalApiService } from '@opensumi/ide-terminal-next';
import { IVariableResolverService } from '@opensumi/ide-variable';
import { IWorkspaceService } from '@opensumi/ide-workspace';

import { MockDebugSession } from '../../../../__mocks__/debug-session';
import { DebugPreferences } from '../../../../src/browser/debug-preferences';
import { DebugSession } from '../../../../src/browser/debug-session';
import { DebugSessionContributionRegistry } from '../../../../src/browser/debug-session-contribution';
import { DebugConsoleFilterService } from '../../../../src/browser/view/console/debug-console-filter.service';
import { DebugConsoleModelService } from '../../../../src/browser/view/console/debug-console-tree.model.service';

describe('Debug console component Test Suites', () => {
  const mockInjector = createBrowserInjector([]);
  let debugConsoleModelService: DebugConsoleModelService;
  let debugConsoleFilterService: DebugConsoleFilterService;
  let container;

  const createMockSession = (sessionId: string, options: Partial<DebugSessionOptions>): IDebugSession =>
    new MockDebugSession(sessionId, options);

  const mockCtxMenuRenderer = {
    show: jest.fn(),
    onDidChangeContext: jest.fn(() => Disposable.create(() => {})),
  } as any;
  const mockDebugSessionManager = {
    onDidDestroyDebugSession: jest.fn(() => Disposable.create(() => {})),
    onDidChangeActiveDebugSession: jest.fn(() => Disposable.create(() => {})),
    currentSession: undefined,
    updateCurrentSession: jest.fn((session: IDebugSession | undefined) => {}),
  } as any;

  beforeEach(() => {
    mockInjector.overrideProviders({
      token: WorkbenchEditorService,
      useValue: {},
    });
    mockInjector.overrideProviders({
      token: IMessageService,
      useValue: {},
    });
    mockInjector.overrideProviders({
      token: DebugPreferences,
      useValue: {},
    });
    mockInjector.overrideProviders({
      token: IFileServiceClient,
      useValue: {
        onFilesChanged: jest.fn(),
      },
    });
    mockInjector.overrideProviders({
      token: ITerminalApiService,
      useValue: {},
    });
    mockInjector.overrideProviders({
      token: OutputService,
      useValue: {},
    });
    mockInjector.overrideProviders({
      token: DebugModelFactory,
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
      token: QuickPickService,
      useValue: {},
    });
    mockInjector.overrideProviders({
      token: IEditorDocumentModelService,
      useValue: {},
    });
    mockInjector.overrideProviders({
      token: WSChannelHandler,
      useValue: {
        clientId: 'mock_id' + Math.random(),
        openChannel(id: string) {
          return new WSChannel(new SimpleConnection(), { id: 'mock_wschannel' + id });
        },
      },
    });
    mockInjector.overrideProviders({
      token: DebugSessionContributionRegistry,
      useValue: {},
    });
    mockInjector.overrideProviders({
      token: IVariableResolverService,
      useValue: {},
    });
    mockInjector.overrideProviders({
      token: ITaskService,
      useValue: {},
    });
    mockInjector.overrideProviders({
      token: IContextKeyService,
      useValue: mockCtxMenuRenderer,
    });
    mockInjector.overrideProviders({
      token: IDebugSessionManager,
      useValue: mockDebugSessionManager,
    });
    mockInjector.overrideProviders({
      token: IMainLayoutService,
      useClass: LayoutService,
    });

    debugConsoleModelService = mockInjector.get(DebugConsoleModelService);
    debugConsoleFilterService = mockInjector.get(DebugConsoleFilterService);
    container = document.createElement('div');
    container.setAttribute('id', 'debugConsole');
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.removeChild(container);
    container = null;
  });

  it('repl can be filter', async () => {
    const session = createMockSession('mock', {});
    mockDebugSessionManager.currentSession = session;
    await debugConsoleModelService.initTreeModel(session as DebugSession);
    const tree = debugConsoleModelService;
    const ensureVisible = jest.fn();
    debugConsoleModelService.handleTreeHandler({
      ensureVisible,
    } as any);

    await tree.execute('ABCD\n');
    await tree.execute('EFGH\n');
    await tree.execute('KTTQL\n');
    await tree.execute('KATATAQAL\n');
    await tree.execute('🐜\n');
    expect(ensureVisible).toHaveBeenCalledTimes(5);
    const filterString = 'KTTQL';
    debugConsoleFilterService.onDidValueChange((event) => {
      expect(event).toBe(filterString);
    });
    debugConsoleFilterService.setFilterText(filterString);
  });
});
