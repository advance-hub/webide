import { Autowired, Injectable } from '@opensumi/di';
import { AI_CHAT_VIEW_ID } from '@opensumi/ide-ai-native';
import {
  ClientAppContribution,
  ComponentContribution,
  ComponentRegistry,
  IStatusBarService,
  StatusBarAlignment,
  StatusBarEntryAccessor,
  getIcon,
} from '@opensumi/ide-core-browser';
import { IQuickInputService } from '@opensumi/ide-core-browser/quick-open';
import { CommandContribution, CommandRegistry, CommandService, Domain, Emitter } from '@opensumi/ide-core-common';
import { IMainLayoutService } from '@opensumi/ide-main-layout';
import { IMessageService } from '@opensumi/ide-overlay';
import { ITerminalApiService } from '@opensumi/ide-terminal-next';

import { CloudDevView } from './cloud-dev.view';

export const CLOUD_DEV_CONTAINER_ID = 'cloud-dev';

export interface CloudDevContext {
  id: string;
  projectName: string;
  branch: string;
  targetBranch: string;
  baselineSha: string;
  publishedSha: string;
  isOwner: boolean;
  canPublish: boolean;
  applicationStatus: 'preparing' | 'notConfigured' | 'stopped' | 'error' | 'ready';
  previewReady: boolean;
  mergeRequestUrl: string;
  workbenchUrl: string;
  resourcesUrl: string;
  editorConnections?: { mysql: boolean; redis: boolean; additionalDatabases: number; error?: string };
}

const COMMANDS = {
  show: 'cloudDev.showWorkspace',
  workbench: 'cloudDev.openWorkbench',
  resources: 'cloudDev.openDevelopmentResources',
  preview: 'cloudDev.openPreview',
  ai: 'cloudDev.openAI',
  aiSettings: 'cloudDev.configureAI',
  publish: 'cloudDev.publish',
  mergeRequest: 'cloudDev.openMergeRequest',
};

@Injectable()
@Domain(ClientAppContribution, CommandContribution, ComponentContribution)
export class CloudDevContribution implements ClientAppContribution, CommandContribution, ComponentContribution {
  @Autowired(IStatusBarService)
  private readonly statusBar: IStatusBarService;

  @Autowired(IQuickInputService)
  private readonly quickInput: IQuickInputService;

  @Autowired(IMessageService)
  private readonly messages: IMessageService;

  @Autowired(IMainLayoutService)
  private readonly layout: IMainLayoutService;

  @Autowired(CommandService)
  private readonly commandService: CommandService;

  @Autowired(ITerminalApiService)
  private readonly terminalApi: ITerminalApiService;

  private context?: CloudDevContext;
  private entries: StatusBarEntryAccessor[] = [];
  private publishing = false;
  private loading = false;
  private error = '';
  private aiSettingsRequestId = 0;
  private readonly changeEmitter = new Emitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  get snapshot() {
    return {
      context: this.context,
      publishing: this.publishing,
      loading: this.loading,
      error: this.error,
      aiSettingsRequestId: this.aiSettingsRequestId,
    };
  }

  registerComponent(registry: ComponentRegistry): void {
    const declared = (window as unknown as { __OPENSUMI_WORKSPACE__?: { id?: string } }).__OPENSUMI_WORKSPACE__;
    if (!declared?.id) {
      return;
    }
    registry.register(CLOUD_DEV_CONTAINER_ID, [], {
      containerId: CLOUD_DEV_CONTAINER_ID,
      component: CloudDevView,
      iconClass: getIcon('cloud-server'),
      title: '云开发',
      priority: 7,
    });
  }

  registerCommands(commands: CommandRegistry): void {
    commands.registerCommand(
      { id: COMMANDS.show, label: '云开发：查看工作区' },
      { execute: () => this.layout.getTabbarHandler(CLOUD_DEV_CONTAINER_ID)?.activate() },
    );
    commands.registerCommand(
      { id: COMMANDS.workbench, label: '云开发：打开工作台' },
      { execute: () => this.openWorkbench() },
    );
    commands.registerCommand(
      { id: COMMANDS.resources, label: '云开发：打开开发资源' },
      { execute: () => this.openDevelopmentResources() },
    );
    commands.registerCommand(
      { id: COMMANDS.preview, label: '云开发：预览应用' },
      { execute: () => this.openPreview() },
    );
    commands.registerCommand({ id: COMMANDS.ai, label: '云开发：打开 OpenCode' }, { execute: () => this.openAI() });
    commands.registerCommand(
      { id: COMMANDS.aiSettings, label: '云开发：配置 AI' },
      { execute: () => this.openAISettings() },
    );
    commands.registerCommand(
      { id: COMMANDS.publish, label: '云开发：推送提交并创建 MR' },
      { execute: () => this.publish() },
    );
    commands.registerCommand(
      { id: COMMANDS.mergeRequest, label: '云开发：打开 MR' },
      { execute: () => this.openMergeRequest() },
    );
    commands.registerCommand(
      { id: 'cloudDev.refresh', label: '云开发：刷新工作区状态' },
      { execute: () => this.refresh() },
    );
  }

  onDidStart(): void {
    const declared = (window as unknown as { __OPENSUMI_WORKSPACE__?: { id?: string } }).__OPENSUMI_WORKSPACE__;
    if (declared?.id) {
      void this.refresh();
    }
  }

  onStop(): void {
    this.entries.forEach((entry) => entry.dispose());
    this.entries = [];
    this.changeEmitter.dispose();
  }

  private async request<T>(path: string, payload?: unknown): Promise<T> {
    const response = await fetch(`/__workbench/${path}`, {
      method: payload === undefined ? 'GET' : 'POST',
      headers: payload === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: payload === undefined ? undefined : JSON.stringify(payload),
      credentials: 'same-origin',
    });
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || '云开发操作失败，请重试');
    }
    return data as T;
  }

  async refresh(): Promise<void> {
    this.loading = true;
    this.error = '';
    this.changeEmitter.fire();
    try {
      this.context = await this.request<CloudDevContext>('context');
      this.renderEntries();
    } catch (error) {
      this.context = undefined;
      this.error = (error as Error).message;
      this.renderEntries();
    } finally {
      this.loading = false;
      this.changeEmitter.fire();
    }
  }

  private renderEntries(): void {
    this.entries.forEach((entry) => entry.dispose());
    this.entries = [];
    const context = this.context;
    if (!context) {
      return;
    }
    this.entries.push(
      this.statusBar.addElement('cloud-dev-workspace', {
        text: `${context.projectName} · ${context.branch}`,
        tooltip: '查看云开发工作区',
        ariaLabel: `工作区 ${context.projectName}，分支 ${context.branch}，查看云开发状态`,
        alignment: StatusBarAlignment.LEFT,
        priority: 70,
        command: COMMANDS.show,
      }),
    );
  }

  private openURL(raw: string): void {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      throw new Error('目标地址无效');
    }
    window.open(url.href, '_blank', 'noopener,noreferrer');
  }

  openWorkbench(): void {
    if (this.context) {
      this.openURL(this.context.workbenchUrl);
    }
  }

  openDevelopmentResources(): void {
    if (this.context?.resourcesUrl) {
      this.openURL(this.context.resourcesUrl);
    }
  }

  async openDataTool(tool: 'mysql' | 'redis', add = false): Promise<void> {
    const command =
      tool === 'mysql'
        ? add
          ? 'sqltools.openAddConnectionScreen'
          : 'workbench.view.extension.sqltoolsActivityBarContainer'
        : add
          ? 'redis-live.addConnection'
          : 'workbench.view.extension.redis-state-explorer';
    try {
      await this.commandService.executeCommand(command);
    } catch {
      await this.messages.warning('数据插件尚未就绪，请稍后重试或在开发资源中检查配置。');
    }
  }

  async openAI(): Promise<void> {
    this.layout.toggleSlot(AI_CHAT_VIEW_ID, true, 360);
  }

  openAISettings(): void {
    this.aiSettingsRequestId += 1;
    this.layout.getTabbarHandler(CLOUD_DEV_CONTAINER_ID)?.activate();
    this.changeEmitter.fire();
  }

  async connectAI(): Promise<void> {
    try {
      const terminal = await this.terminalApi.createTerminal({ name: 'OpenCode 登录', cwd: '/workspace/project' });
      terminal.show(false);
      this.terminalApi.sendText(terminal.id, 'opencode auth login');
    } catch (error) {
      await this.messages.error(`无法打开登录终端：${(error as Error).message}`);
    }
  }

  openMergeRequest(): void {
    if (this.context?.mergeRequestUrl) {
      this.openURL(this.context.mergeRequestUrl);
    }
  }

  async openPreview(): Promise<void> {
    if (!this.context?.previewReady) {
      await this.messages.warning('应用尚未就绪，请检查项目启动日志。');
      return;
    }
    const tab = window.open('about:blank', '_blank');
    if (!tab) {
      await this.messages.error('浏览器拦截了预览标签页，请允许弹出窗口后重试。');
      return;
    }
    tab.opener = null;
    tab.document.body.textContent = '正在连接应用预览…';
    try {
      const result = await this.request<{ url: string }>('preview', {});
      const url = new URL(result.url);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error('预览地址无效');
      }
      tab.location.replace(url.href);
    } catch (error) {
      tab.close();
      await this.messages.error((error as Error).message);
      await this.refresh();
    }
  }

  async publish(): Promise<void> {
    const context = this.context;
    if (!context?.canPublish || this.publishing) {
      return;
    }
    const targetBranch = await this.quickInput.open({
      title: '目标分支',
      prompt: `将 ${context.branch} 合并到哪个已有分支？`,
      value: context.targetBranch,
      validateInput: (value) =>
        !value.trim() || value.trim() === context.branch ? '请选择不同于开发分支的目标分支' : undefined,
    });
    if (!targetBranch) {
      return;
    }
    const title = await this.quickInput.open({
      title: 'MR 标题',
      value: `${context.branch} → ${targetBranch.trim()}`,
      validateInput: (value) => (!value.trim() ? '请输入 MR 标题' : undefined),
    });
    if (!title) {
      return;
    }
    this.publishing = true;
    this.changeEmitter.fire();
    try {
      const result = await this.request<{ sha: string; mergeRequestUrl: string }>('publish', {
        targetBranch: targetBranch.trim(),
        title: title.trim(),
      });
      await this.refresh();
      const action = await this.messages.info(`已推送 ${result.sha.slice(0, 8)} 并创建 MR。`, ['打开 MR']);
      if (action === '打开 MR') {
        this.openURL(result.mergeRequestUrl);
      }
    } catch (error) {
      await this.messages.error((error as Error).message);
    } finally {
      this.publishing = false;
      this.changeEmitter.fire();
    }
  }
}
