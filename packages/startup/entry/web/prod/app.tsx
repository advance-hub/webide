import { AI_CHAT_LOGO_AVATAR_ID } from '@opensumi/ide-ai-native';
import { AILayout } from '@opensumi/ide-ai-native/layout';
import { DESIGN_MENU_BAR_RIGHT } from '@opensumi/ide-design';
import { compileOpenSumiProductRuntimePlan } from '@opensumi/ide-startup';
import { AIBrowserBindings } from '@opensumi/ide-startup/browser/ai';

import { SampleModule } from '../../sample-modules';
import { CommonBrowserBindings, getDefaultClientAppOpts, renderApp } from '../render-app';

const hostname = window.location.hostname;
const port = window.location.port;
const runtimePlan = compileOpenSumiProductRuntimePlan({
  runtime: 'browser',
  commonBindings: CommonBrowserBindings,
  options: [{ id: 'ai', bindings: AIBrowserBindings }],
});

renderApp(
  getDefaultClientAppOpts({
    modules: [SampleModule],
    runtimePlan,
    runtimeTopologyPolicy: 'compatible',
    opts: {
      layoutComponent: AILayout,
      layoutConfig: {
        [DESIGN_MENU_BAR_RIGHT]: {
          modules: [AI_CHAT_LOGO_AVATAR_ID],
        },
      },
      webviewEndpoint: '/webview',
      extWorkerHost: '/worker-host.js',
      wsPath: window.location.protocol === 'https:' ? `wss://${hostname}:${port}` : `ws://${hostname}:${port}`,
    },
  }),
);
