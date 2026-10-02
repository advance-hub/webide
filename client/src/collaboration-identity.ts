import { Injectable } from '@opensumi/di';
import { CollaborationModuleContribution } from '@opensumi/ide-collaboration';
import { BrowserModule } from '@opensumi/ide-core-browser';
import { Domain } from '@opensumi/ide-core-common';

@Domain(CollaborationModuleContribution)
class WorkspaceCollaborator implements CollaborationModuleContribution {
  readonly info = (window as unknown as { __OPENSUMI_WORKSPACE__: { user: { id: string; nickname: string } } })
    .__OPENSUMI_WORKSPACE__.user;
}

/** 账户来自服务端页面，光标昵称仍由协同模块按纯文本渲染。 */
@Injectable()
export class CollaborationIdentityModule extends BrowserModule {
  providers = [WorkspaceCollaborator];
}
