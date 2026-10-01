import { Injectable } from '@opensumi/di';
import { AINativeCoreContribution, IChatFeatureRegistry } from '@opensumi/ide-ai-native/types';
import { Domain } from '@opensumi/ide-core-common';

@Injectable()
@Domain(AINativeCoreContribution)
export class CloudDevAIContribution implements AINativeCoreContribution {
  registerChatFeature(registry: IChatFeatureRegistry): void {
    registry.registerWelcome(
      'OpenCode 可在当前工作区阅读和修改代码。首次使用请在「云开发 → AI 设置」连接账号并选择模型，然后在这里描述开发任务。',
      [],
    );
  }
}
