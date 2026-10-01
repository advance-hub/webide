import { CommandService, IContextKeyService } from '@opensumi/ide-core-browser';
import { URI } from '@opensumi/ide-core-common';
import { createBrowserInjector } from '@opensumi/ide-dev-tool/browser';
import { MockInjector } from '@opensumi/ide-dev-tool/injector';
import { MockContextKeyService } from '@opensumi/ide-dev-tool/mocks/context-key';
import { IWorkspaceService } from '@opensumi/ide-workspace';

import { WorkspaceModule } from '../../src/browser';
import { WorkspaceVariableContribution } from '../../src/browser/workspace-variable-contribution';

describe('WorkspaceVariableContribution should be work', () => {
  let workspaceVariableContribution: WorkspaceVariableContribution;
  let injector: MockInjector;
  const mockWorkspaceService = {
    getWorkspaceRootUri: jest.fn(),
  };
  const mockCommandSetvice = {
    executeCommand: jest.fn(),
  };
  beforeEach(async () => {
    injector = createBrowserInjector([WorkspaceModule]);
    injector.overrideProviders({
      token: IContextKeyService,
      useClass: MockContextKeyService,
    });
    injector.overrideProviders({
      token: CommandService,
      useValue: mockCommandSetvice,
    });
    injector.overrideProviders({
      token: IWorkspaceService,
      useValue: mockWorkspaceService,
    });

    workspaceVariableContribution = injector.get(WorkspaceVariableContribution);
  });

  afterEach(async () => {
    await injector.disposeAll();
    mockWorkspaceService.getWorkspaceRootUri.mockReset();
  });

  it('registerVariables contribution point should be work', async () => {
    const variables = {
      registerVariable: jest.fn((variable) => {
        variable.resolve();
      }),
    };
    workspaceVariableContribution.registerVariables(variables as any);
    expect(variables.registerVariable).toHaveBeenCalledTimes(11);
  });

  it('getWorkspaceRootUri method should be work', async () => {
    const workspaceUri = new URI('file://userhome/');
    workspaceVariableContribution.getWorkspaceRootUri(workspaceUri);
    expect(mockWorkspaceService.getWorkspaceRootUri).toHaveBeenCalledWith(workspaceUri);
  });

  it('getResourceUri method should be work', async () => {
    await workspaceVariableContribution.getResourceUri();
    expect(mockCommandSetvice.executeCommand).toHaveBeenCalledWith('editor.getCurrentResource');
  });

  it('getWorkspaceRelativePath method should be work', async () => {
    const workspaceUri = new URI('file://userhome/');
    workspaceVariableContribution.getWorkspaceRelativePath(workspaceUri);
    expect(mockWorkspaceService.getWorkspaceRootUri).toHaveBeenCalledWith(workspaceUri);
  });
});
