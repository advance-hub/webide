import { SlotLocation } from '@opensumi/ide-core-browser';
import '@opensumi/ide-core-browser/styles/icon.less';
import { DESIGN_MENUBAR_CONTAINER_VIEW_ID, DESIGN_MENU_BAR_RIGHT } from '@opensumi/ide-design';
import { compileOpenSumiProductRuntimePlan, parseRuntimeTopologyHandshakePolicy } from '@opensumi/ide-startup';
import { CLOUD_DEV_CONTAINER_ID, CloudDevModule } from '@opensumi/ide-startup/browser/cloud-dev';
import { MENU_BAR_FEATURE_TIP } from '@opensumi/ide-startup/browser/menu-help';
import { CommonBrowserBindings, getDefaultClientAppOpts, renderApp } from '@opensumi/ide-startup/browser/render';
import { BaseSampleModule } from '@opensumi/ide-startup/examples/base';

import type { BrowserModule, ConstructorOf, IClientAppOpts } from '@opensumi/ide-core-browser';
import type { LoadedProductOption } from '@opensumi/ide-startup';

// 框架渲染器保持可复用，产品组装放在 client/ 目录。
// 后续移动渲染器时，无须调整服务端。

async function main() {
  const cloudWorkspace = (window as unknown as { __OPENSUMI_WORKSPACE__?: { id?: string } }).__OPENSUMI_WORKSPACE__;
  const productModules: ConstructorOf<BrowserModule>[] = [BaseSampleModule];
  if (cloudWorkspace?.id) {
    productModules.push(CloudDevModule);
  }
  const loadedProductOptions: LoadedProductOption<ConstructorOf<BrowserModule>>[] = [];
  const rightMenuModules = [MENU_BAR_FEATURE_TIP];
  const productOpts: Partial<IClientAppOpts> = {
    useCdnIcon: false,
    layoutViewSize: {
      menubarHeight: 32,
    },
    measure: {
      connection: {
        minimumReportThresholdTime: 400,
      },
    },
  };
  if (!process.env.IS_DEV) {
    const webSocketProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    productOpts.wsPath = `${webSocketProtocol}//${window.location.host}`;
    productOpts.staticServicePath = window.location.origin;
    if (process.env.EXTENSION_WORKER_HOST) {
      const workerHost = new URL(process.env.EXTENSION_WORKER_HOST);
      workerHost.protocol = window.location.protocol;
      workerHost.host = window.location.host;
      productOpts.extWorkerHost = workerHost.toString();
    }
  }

  if (cloudWorkspace?.id || process.env.ENABLE_AI === '1') {
    const [{ AI_CHAT_LOGO_AVATAR_ID }, { AILayout }, { AIBrowserBindings }] = await Promise.all([
      import('@opensumi/ide-ai-native'),
      import('@opensumi/ide-ai-native/layout'),
      import('@opensumi/ide-startup/browser/ai'),
    ]);
    if (!cloudWorkspace?.id) {
      const { AISampleModule } = await import('@opensumi/ide-startup/examples/ai');
      productModules.push(AISampleModule);
    }
    loadedProductOptions.push({ id: 'ai', bindings: AIBrowserBindings });
    rightMenuModules.push(AI_CHAT_LOGO_AVATAR_ID);
    productOpts.layoutComponent = AILayout;
    productOpts.AINativeConfig = cloudWorkspace?.id
      ? {
          capabilities: {
            supportsChatAssistant: true,
            supportsAgentMode: true,
            supportsMCP: false,
            supportsCustomLLMSettings: false,
            supportsMarkers: false,
            supportsInlineChat: false,
            supportsInlineCompletion: false,
            supportsCodeAction: false,
            supportsConflictResolve: false,
            supportsRenameSuggestions: false,
            supportsProblemFix: false,
            supportsTerminalDetection: false,
            supportsTerminalCommandSuggest: false,
          },
        }
      : {
          capabilities: {
            supportsMCP: true,
            supportsCustomLLMSettings: true,
          },
        };
  }

  if (process.env.ENABLE_NOTEBOOK === '1') {
    const { NotebookBrowserBindings } = await import('@opensumi/ide-startup/browser/notebook');
    loadedProductOptions.push({ id: 'notebook', bindings: NotebookBrowserBindings });
    productOpts.notebookServerHost = process.env.NOTEBOOK_SERVER_HOST || 'localhost:8888';
  }

  if (process.env.ENABLE_COLLABORATION === '1') {
    const { CollaborationBrowserBindings } = await import('@opensumi/ide-startup/browser/collaboration');
    loadedProductOptions.push({ id: 'collaboration', bindings: CollaborationBrowserBindings });
  }

  const runtimePlan = compileOpenSumiProductRuntimePlan({
    runtime: 'browser',
    commonBindings: CommonBrowserBindings,
    options: loadedProductOptions,
  });

  productOpts.layoutConfig = {
    [DESIGN_MENU_BAR_RIGHT]: {
      modules: rightMenuModules,
    },
    [SlotLocation.top]: {
      modules: [DESIGN_MENUBAR_CONTAINER_VIEW_ID],
    },
  };
  productOpts.collaborationOptions = {
    port: Number(process.env.COLLABORATION_PORT || 12_345),
  };

  const clientOpts = getDefaultClientAppOpts({
    modules: productModules,
    opts: productOpts,
    runtimePlan,
    runtimeTopologyPolicy: parseRuntimeTopologyHandshakePolicy(
      process.env.OPENSUMI_RUNTIME_TOPOLOGY_POLICY,
      'compatible',
    ),
  });
  const viewSlot = clientOpts.layoutConfig?.[SlotLocation.view];
  if (cloudWorkspace?.id && viewSlot) {
    viewSlot.modules.push(CLOUD_DEV_CONTAINER_ID);
  }
  clientOpts.defaultPreferences = {
    ...clientOpts.defaultPreferences,
    'application.supportsOpenFolder': true,
    'application.supportsOpenWorkspace': true,
    ...(cloudWorkspace?.id
      ? {
          'ai.native.agent.builtInsEnabled': false,
          'ai.native.agent.configs': {
            opencode: { command: 'opencode', args: ['acp'], streaming: true, description: 'OpenCode' },
          },
          'ai.native.agent.defaultType': 'opencode',
          'ai.native.webmcp.enabled': false,
        }
      : {}),
  };
  await renderApp(clientOpts);
}

void main();
