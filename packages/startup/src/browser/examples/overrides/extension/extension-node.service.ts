import { NodeExtProcessService } from '@opensumi/ide-extension/browser/node-host';

export class OverrideExtensionNodeService extends NodeExtProcessService {
  override getSpawnOptions() {
    return {
      env: {
        VSCODE_NLS: JSON.stringify({
          locale: 'zh-CN',
        }),
        CF_RUNTIME: 'codefuse-ide',
      },
    };
  }
}
