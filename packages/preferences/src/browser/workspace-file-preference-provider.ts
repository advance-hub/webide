import { Autowired, Injectable } from '@opensumi/di';
import { PreferenceScope, URI } from '@opensumi/ide-core-browser';
import { IWorkspaceService } from '@opensumi/ide-workspace';
import { WorkspaceData } from '@opensumi/ide-workspace/data';

import { AbstractResourcePreferenceProvider } from './abstract-resource-preference-provider';

@Injectable()
export class WorkspaceFilePreferenceProviderOptions {
  workspaceUri: URI;
}

export const WorkspaceFilePreferenceProviderFactory = Symbol('WorkspaceFilePreferenceProviderFactory');
export type WorkspaceFilePreferenceProviderFactory = (
  options: WorkspaceFilePreferenceProviderOptions,
) => WorkspaceFilePreferenceProvider;

@Injectable()
export class WorkspaceFilePreferenceProvider extends AbstractResourcePreferenceProvider {
  @Autowired(IWorkspaceService)
  protected readonly workspaceService: IWorkspaceService;

  @Autowired(WorkspaceFilePreferenceProviderOptions)
  protected readonly options: WorkspaceFilePreferenceProviderOptions;

  protected getUri(): URI {
    return this.options.workspaceUri;
  }

  protected parse(content: string): any {
    const data = super.parse(content);
    if (WorkspaceData.is(data)) {
      return data.settings || {};
    }
    return {};
  }

  protected getPath(preferenceName: string): string[] {
    return ['settings', preferenceName];
  }

  protected getScope(): PreferenceScope {
    return PreferenceScope.Workspace;
  }

  getDomain(): string[] {
    return this.workspaceService.tryGetRoots().map((r) => r.uri);
  }
}
