import { Autowired, Injectable } from '@opensumi/di';
import { AINativeConfigService } from '@opensumi/ide-core-browser';
import { IDisposable } from '@opensumi/ide-core-common';

import { DefaultChatAgentToken } from '../../common';
import { ChatToolRender } from '../components/ChatToolRender';

import { AcpChatAgent } from './acp-chat-agent';
import { ChatProxyService } from './chat-proxy.service';
import { DefaultChatAgent } from './default-chat-agent';

@Injectable()
export class AcpChatProxyService extends ChatProxyService {
  @Autowired(AINativeConfigService)
  private readonly aiNativeConfigService: AINativeConfigService;

  @Autowired(DefaultChatAgentToken)
  private readonly defaultChatAgent: DefaultChatAgent;

  @Autowired(AcpChatAgent)
  private readonly acpChatAgent: AcpChatAgent;

  private agentDisposable: IDisposable | null = null;

  override registerDefaultAgent() {
    this.chatAgentViewService.registerChatComponent({
      id: 'toolCall',
      component: ChatToolRender,
      initialProps: {},
    });

    this.applicationService.getBackendOS().then(() => {
      const agentToRegister = this.aiNativeConfigService.capabilities.supportsAgentMode
        ? this.acpChatAgent
        : this.defaultChatAgent;

      const disposable = this.chatAgentService.registerAgent(agentToRegister);
      this.agentDisposable = disposable;
      this.addDispose(disposable);
      queueMicrotask(() => {
        this.chatAgentService.updateAgent(ChatProxyService.AGENT_ID, {});
      });
    });
  }

  registerFallbackAgent(): void {
    this.agentDisposable?.dispose();
    this.addDispose(this.chatAgentService.registerAgent(this.defaultChatAgent));
    queueMicrotask(() => {
      this.chatAgentService.updateAgent(ChatProxyService.AGENT_ID, {});
    });
  }
}
