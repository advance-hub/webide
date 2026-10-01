/* eslint-disable import-x/order */

// eslint-disable-next-line no-console
console.time('Render');

import '@opensumi/ide-core-browser/styles/index.less';
import './styles.less';

import { LOCALE_TYPES } from '@opensumi/ide-core-common/const';
import { setLocale } from '@opensumi/ide-monaco/localization';

const defaultLanguage = LOCALE_TYPES.EN_US;

// 请注意，集成方在这里需要自己传一个正确的 locale 进去
// 如果不传则默认会根据 PreferenceScope 的优先级从 LocalStorage 取值
setLocale(defaultLanguage);

import '@opensumi/ide-i18n';

import { Injector } from '@opensumi/di';
import { BrowserModule, IClientAppOpts, SlotLocation, registerLocalStorageProvider } from '@opensumi/ide-core-browser';
import { ClientApp } from '@opensumi/ide-core-browser/bootstrap';
import {
  CommandService,
  ConstructorOf,
  GeneralSettingsId,
  URI,
  findFirstTruthy,
  toRuntimePlanContract,
  uuid,
} from '@opensumi/ide-core-common';
import { ExpressFileServerModule } from '@opensumi/ide-express-file-server/browser';
import { defaultConfig } from '@opensumi/ide-main-layout/defaults';
import { RemoteOpenerModule } from '@opensumi/ide-remote-opener/browser';

import { CommonBrowserModules } from '../common-modules';
import {
  RuntimeTopologyHandshakeError,
  composeLegacyEntrypointModules,
  createRuntimeTopologyClientPreflight,
} from '../../index';

import { renderRuntimeTopologyFatal } from './runtime-topology-fatal';

import type {
  OpenSumiProductRuntimePlan,
  RuntimeTopologyClientPreflight,
  RuntimeTopologyHandshakePolicy,
} from '../../index';

export { CommonBrowserModules };
export { CommonBrowserBindings } from '../common-modules';

const CLIENT_ID = 'W_' + uuid();

const queries = new URLSearchParams(window.location.search);

/** Workspace declared by a server that serves exactly one workspace. */
export interface DeclaredWorkspace {
  id?: string;
  workspaceDir: string;
}

export function getDeclaredWorkspace(): DeclaredWorkspace | undefined {
  const declared = (window as unknown as { __OPENSUMI_WORKSPACE__?: Partial<DeclaredWorkspace> })
    .__OPENSUMI_WORKSPACE__;
  if (!declared || typeof declared.workspaceDir !== 'string' || !declared.workspaceDir) {
    return undefined;
  }
  return { id: typeof declared.id === 'string' ? declared.id : undefined, workspaceDir: declared.workspaceDir };
}

export async function renderApp(opts: IClientAppOpts) {
  // eslint-disable-next-line no-console
  console.time('Render');

  const defaultHost = process.env.HOST || window.location.hostname;
  const injector = new Injector();

  // A server that owns a single workspace declares it in the served document.
  // That declaration wins over the URL: in such a deployment the directory is a
  // deployment fact, and honouring ?workspaceDir= would let anyone repoint the
  // runtime. Standalone OpenSumi declares nothing, so the query parameter and
  // the hash keep working there.
  const declaredWorkspace = getDeclaredWorkspace();
  opts.workspaceDir = findFirstTruthy(
    () => declaredWorkspace?.workspaceDir,
    () => (declaredWorkspace ? undefined : queries.get('workspaceDir') || undefined),
    () => {
      if (declaredWorkspace || !process.env.SUPPORT_LOAD_WORKSPACE_BY_HASH) {
        return undefined;
      }
      const workspacePath = window.location.hash.slice(1);
      try {
        return decodeURIComponent(workspacePath);
      } catch {
        return workspacePath;
      }
    },
    opts.workspaceDir,
    process.env.WORKSPACE_DIR,
  );
  opts.extensionDevelopmentPath = findFirstTruthy(
    () => queries.get('extensionDevelopmentPath') || undefined,
    process.env.EXTENSION_DEVELOPMENT_PATH,
  );

  opts.injector = injector;
  opts.extensionDir = opts.extensionDir || process.env.EXTENSION_DIR;
  opts.wsPath = opts.wsPath || process.env.WS_PATH || `ws://${defaultHost}:8000`;

  opts.extWorkerHost = opts.extWorkerHost || process.env.EXTENSION_WORKER_HOST;

  opts.editorBackgroundImage =
    'https://img.alicdn.com/imgextra/i2/O1CN01dqjQei1tpbj9z9VPH_!!6000000005951-55-tps-87-78.svg';

  opts.clientId = CLIENT_ID;
  opts.didRendered = () => {
    // eslint-disable-next-line no-console
    console.timeEnd('Render');
  };
  registerLocalStorageProvider(GeneralSettingsId.Theme, opts.workspaceDir || '', 'sumi-dev');

  const app = new ClientApp(opts);
  const container = document.getElementById('main')!;
  const topologyPreflight = opts.runtimeTopologyPreflight as RuntimeTopologyClientPreflight | undefined;
  let topologyFailureCleanup: Promise<void> | undefined;
  const cleanupAfterTopologyFailure = () => {
    if (!topologyFailureCleanup) {
      topologyFailureCleanup = (async () => {
        try {
          await app.dispose();
        } catch (cleanupError) {
          // eslint-disable-next-line no-console
          console.error('Failed to dispose the OpenSumi client after a topology rejection', cleanupError);
        }
        try {
          await injector.disposeAll();
        } catch (cleanupError) {
          // eslint-disable-next-line no-console
          console.error('Failed to reclaim the OpenSumi client injector after a topology rejection', cleanupError);
        }
      })();
    }
    return topologyFailureCleanup;
  };

  if (topologyPreflight) {
    const previousFatalErrorHandler = topologyPreflight.onFatalError;
    topologyPreflight.onFatalError = (error) => {
      try {
        previousFatalErrorHandler?.(error);
      } catch (callbackError) {
        // eslint-disable-next-line no-console
        console.error('Runtime topology fatal-error callback failed', callbackError);
      }
      if (error instanceof RuntimeTopologyHandshakeError) {
        renderRuntimeTopologyFatal(container, error, topologyPreflight.getStatus());
        // The connection handler has already terminated the rejected reconnect.
        // Reclaim the remaining Browser runtime without delaying the fatal UI.
        void cleanupAfterTopologyFailure();
        // eslint-disable-next-line no-console
        console.error('OpenSumi runtime topology handshake failed after reconnect', error);
      }
    };
  }

  app.fireOnReload = () => {
    window.location.reload();
  };

  if (process.env.OPENSUMI_E2E_COMMANDS) {
    (window as any).__OPENSUMI_E2E__ = {
      executeCommand: (commandId: string, ...args: any[]) =>
        (app.injector.get(CommandService as any) as unknown as CommandService).executeCommand(commandId, ...args),
      readEditorDocument: async (uri: string) => {
        const { IEditorDocumentModelService } = await import('@opensumi/ide-editor/browser');
        const reference = app.injector.get(IEditorDocumentModelService).getModelReference(new URI(uri));
        try {
          return reference?.instance.getMonacoModel().getValue() ?? null;
        } finally {
          reference?.dispose();
        }
      },
      disposeAcpSessions: async () => {
        try {
          const { IChatInternalService } = await import('@opensumi/ide-ai-native');
          const aiChatService = app.injector.get<any>(IChatInternalService);
          const sessions = [...aiChatService.getSessions()];
          await Promise.allSettled(sessions.map((session) => aiChatService.clearSessionModel(session.sessionId)));
        } catch {
          // AI is an optional product feature and may not be registered in core-only E2E runs.
        }
      },
    };
  }

  try {
    await app.start(container, 'web');
  } catch (error) {
    if (error instanceof RuntimeTopologyHandshakeError) {
      await cleanupAfterTopologyFailure();
      renderRuntimeTopologyFatal(container, error, topologyPreflight?.getStatus());
      // Keep a searchable stack in developer tools while the user-facing page
      // contains only bounded, constructor-free diagnostics.
      // eslint-disable-next-line no-console
      console.error('OpenSumi runtime topology handshake failed', error);
      return;
    }
    throw error;
  }
}

export const getDefaultClientAppOpts = ({
  modules = [],
  opts = {},
  runtimePlan,
  runtimeTopologyPolicy = 'off',
}: {
  modules?: ConstructorOf<BrowserModule>[];
  opts?: Partial<IClientAppOpts>;
  runtimePlan?: OpenSumiProductRuntimePlan<ConstructorOf<BrowserModule>>;
  runtimeTopologyPolicy?: RuntimeTopologyHandshakePolicy;
}): IClientAppOpts => {
  const { layoutConfig, ...restOpt } = opts;
  const runtimeModules = runtimePlan
    ? composeLegacyEntrypointModules({
        runtimePlan,
        frameworkModules: CommonBrowserModules,
        beforeOptionalModules: [ExpressFileServerModule, RemoteOpenerModule, ...modules],
      })
    : [...CommonBrowserModules, ExpressFileServerModule, RemoteOpenerModule, ...modules];

  return {
    modules: runtimeModules,
    layoutConfig: {
      ...defaultConfig,
      [SlotLocation.top]: {
        modules: ['menubar', 'toolbar'],
      },
      [SlotLocation.action]: {
        modules: ['@opensumi/ide-toolbar-action'],
      },
      ...layoutConfig,
    },
    useCdnIcon: true,
    useExperimentalShadowDom: true,
    useBuiltinWebview: true,
    defaultPreferences: {
      'general.language': defaultLanguage,
      'general.theme': 'opensumi-design-dark-theme',
      'general.icon': 'vscode-icons',
      'general.productIconTheme': 'opensumi-icons',
      'application.confirmExit': 'never',
      'editor.quickSuggestionsDelay': 100,
      'editor.largeFile': 10 * 1024 * 1024,
      'editor.largeFileOptimizations': true,
    },
    defaultPanels: {
      [SlotLocation.panel]: '@opensumi/ide-terminal-next',
      [SlotLocation.extendView]: '',
    },
    // 当 `.sumi` 下不存在配置文件时，默认采用 `.vscode` 下的配置
    useVSCodeWorkspaceConfiguration: true,
    // 开启 core-browser 对 OpenSumi DevTools 的支持，默认为关闭
    devtools: true,
    designLayout: {
      useMenubarView: true,
      useMergeRightWithLeftPanel: true,
    },
    runtimeTopologyPreflight:
      runtimePlan && runtimeTopologyPolicy !== 'off'
        ? createRuntimeTopologyClientPreflight({
            runtimePlan: toRuntimePlanContract(runtimePlan),
            policy: runtimeTopologyPolicy,
          })
        : undefined,
    ...restOpt,
  };
};
