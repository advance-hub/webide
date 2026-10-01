import { AI_CHAT_LOGO_AVATAR_ID } from '@opensumi/ide-ai-native';
import { AILayout } from '@opensumi/ide-ai-native/layout';
import { SlotLocation } from '@opensumi/ide-core-browser';
import { DESIGN_MENUBAR_CONTAINER_VIEW_ID, DESIGN_MENU_BAR_RIGHT } from '@opensumi/ide-design';
import { compileOpenSumiProductRuntimePlan } from '@opensumi/ide-startup';
import { AIBrowserBindings } from '@opensumi/ide-startup/browser/ai';
import { MENU_BAR_FEATURE_TIP } from '@opensumi/ide-startup/browser/menu-help';
import { NotebookBrowserBindings } from '@opensumi/ide-startup/browser/notebook';

import { SampleModule } from '../sample-modules';

import { CommonBrowserBindings, getDefaultClientAppOpts, renderApp } from './render-app';

const runtimePlan = compileOpenSumiProductRuntimePlan({
  runtime: 'browser',
  commonBindings: CommonBrowserBindings,
  options: [
    { id: 'ai', bindings: AIBrowserBindings },
    { id: 'notebook', bindings: NotebookBrowserBindings },
  ],
});

renderApp(
  getDefaultClientAppOpts({
    modules: [SampleModule],
    runtimePlan,
    runtimeTopologyPolicy: 'compatible',
    opts: {
      layoutViewSize: {
        menubarHeight: 32,
      },
      layoutConfig: {
        [DESIGN_MENU_BAR_RIGHT]: {
          modules: [MENU_BAR_FEATURE_TIP, AI_CHAT_LOGO_AVATAR_ID],
        },
        [SlotLocation.top]: {
          modules: [DESIGN_MENUBAR_CONTAINER_VIEW_ID],
        },
      },
      measure: {
        connection: {
          minimumReportThresholdTime: 400,
        },
      },
      AINativeConfig: {
        capabilities: {
          supportsMCP: true,
          supportsCustomLLMSettings: true,
        },
      },
      layoutComponent: AILayout,
      notebookServerHost: 'localhost:8888',
    },
  }),
);
