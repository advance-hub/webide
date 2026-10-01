import { AILayout } from '@opensumi/ide-ai-native/layout';
import { compileOpenSumiProductRuntimePlan } from '@opensumi/ide-startup';
import { AIBrowserBindings } from '@opensumi/ide-startup/browser/ai';

import { SampleModule } from '../../sample-modules';
import { DefaultLayout } from '../layout';
import { CommonBrowserBindings, getDefaultClientAppOpts, renderApp } from '../render-app';

const queries = new URLSearchParams(window.location.search);
const preserveAINativeE2E = queries.get('persistAiNativeE2E') === 'true';
const aiNativeE2ESessionKey = 'opensumi.e2e.ai-native-enabled';
const userPreferenceDirE2ESessionKey = 'opensumi.e2e.user-preference-dir-name';
const enableAINativeE2E =
  queries.get('aiNative') === 'true' ||
  queries.has('webMcpProfile') ||
  window.sessionStorage.getItem(aiNativeE2ESessionKey) === 'true';
if (preserveAINativeE2E && enableAINativeE2E) {
  window.sessionStorage.setItem(aiNativeE2ESessionKey, 'true');
}
const panelLayout = queries.get('aiPanelLayout') === 'classic' ? 'classic' : 'agentic';
const userPreferenceDirName =
  queries.get('userPreferenceDirName') || window.sessionStorage.getItem(userPreferenceDirE2ESessionKey) || undefined;
if (preserveAINativeE2E && userPreferenceDirName) {
  window.sessionStorage.setItem(userPreferenceDirE2ESessionKey, userPreferenceDirName);
}
const runtimePlan = compileOpenSumiProductRuntimePlan({
  runtime: 'browser',
  commonBindings: CommonBrowserBindings,
  options: enableAINativeE2E ? [{ id: 'ai', bindings: AIBrowserBindings }] : [],
});

renderApp(
  getDefaultClientAppOpts({
    modules: [SampleModule],
    runtimePlan,
    opts: {
      ...(userPreferenceDirName ? { userPreferenceDirName } : {}),
      ...(enableAINativeE2E
        ? {
            AINativeConfig: {
              layout: {
                panelLayout,
              },
              capabilities: {
                supportsMCP: true,
                supportsCustomLLMSettings: true,
              },
            },
            layoutComponent: AILayout,
          }
        : {
            // do not use design and ai layout for general e2e testing
            designLayout: {
              useMenubarView: false,
              useMergeRightWithLeftPanel: false,
            },
            layoutComponent: DefaultLayout,
          }),
    },
  }),
);
