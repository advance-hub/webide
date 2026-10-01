import { IContextKeyService, QuickPickService } from '@opensumi/ide-core-browser';
import { IFileServiceClient } from '@opensumi/ide-core-common';
import { createBrowserInjector } from '@opensumi/ide-dev-tool/browser';
import { MockInjector } from '@opensumi/ide-dev-tool/injector';
import { MockFileServiceClient } from '@opensumi/ide-dev-tool/mocks/file-service-client';
import { MockContextKeyService } from '@opensumi/ide-dev-tool/mocks/monaco/context-keys';
import { WorkbenchEditorService } from '@opensumi/ide-editor/browser';
import { IWorkspaceService } from '@opensumi/ide-workspace';

import { DebugPreferences } from '../../src/browser/debug-preferences';

import { DebugProgressService } from './../../src/browser/debug-progress.service';
import { DebugSessionManager } from './../../src/browser/debug-session-manager';
import { DebugModelFactory } from './../../src/common/debug-model';
import { IDebugProgress } from './../../src/common/debug-progress';
import { IDebugServer } from './../../src/common/debug-service';
import { IDebugSessionManager } from './../../src/common/debug-session';

describe('DebugProgressService', () => {
  let debugProgressService: IDebugProgress;
  let injector: MockInjector;

  const debugSessionManager = {
    onDidChangeActiveDebugSession: jest.fn(),
  };

  beforeAll(() => {
    injector = createBrowserInjector(
      [],
      new MockInjector([
        {
          token: IContextKeyService,
          useClass: MockContextKeyService,
        },
        {
          token: IDebugProgress,
          useClass: DebugProgressService,
        },
        {
          token: IDebugSessionManager,
          useClass: DebugSessionManager,
        },
        {
          token: WorkbenchEditorService,
          useValue: {},
        },
        {
          token: DebugModelFactory,
          useValue: {},
        },
        {
          token: IFileServiceClient,
          useValue: MockFileServiceClient,
        },
        {
          token: IWorkspaceService,
          useValue: {},
        },
        {
          token: IDebugServer,
          useValue: {},
        },
        {
          token: QuickPickService,
          useValue: {},
        },
        {
          token: DebugPreferences,
          useValue: {},
        },
      ]),
    );
    debugProgressService = injector.get(IDebugProgress);
  });

  afterAll(async () => {
    await injector.disposeAll();
  });

  it('should have enough API', () => {
    expect(typeof debugProgressService.run).toBe('function');
    expect(typeof debugProgressService.onDebugServiceStateChange).toBe('function');
  });

  it('run should be ok.', () => {
    debugProgressService.run(debugSessionManager as any);

    expect(debugSessionManager.onDidChangeActiveDebugSession).toHaveBeenCalledTimes(1);
  });
});
