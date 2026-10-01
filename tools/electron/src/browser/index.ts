const win = window as any;
win.Buffer = win.BufferBridge;
if (!(window as any).process) {
  (window as any).process = { browser: true, env: (window as any).env, listener: () => [] };
}

import '@opensumi/ide-i18n';
import { ClientAddonModule } from '@opensumi/ide-addons/browser';
import { CommentsModule } from '@opensumi/ide-comments/browser';
import { BrowserModule, ClientCommonModule, ConstructorOf } from '@opensumi/ide-core-browser';
import { DebugModule } from '@opensumi/ide-debug/browser';
import { DecorationModule } from '@opensumi/ide-decoration/browser';
import { EditorModule } from '@opensumi/ide-editor/browser';
import { ElectronBasicModule } from '@opensumi/ide-electron-basic/browser';
import { ExplorerModule } from '@opensumi/ide-explorer/browser';
import { ExtensionModule } from '@opensumi/ide-extension/browser';
import { OpenVsxExtensionManagerModule } from '@opensumi/ide-extension-manager/browser';
import { ExtensionStorageModule } from '@opensumi/ide-extension-storage/browser';
import { FileSchemeModule } from '@opensumi/ide-file-scheme/browser';
import { FileServiceClientModule } from '@opensumi/ide-file-service/browser';
import { FileTreeNextModule } from '@opensumi/ide-file-tree-next/browser';
import { KeymapsModule } from '@opensumi/ide-keymaps/browser';
import { LogModule } from '@opensumi/ide-logs/browser';
import { MainLayoutModule } from '@opensumi/ide-main-layout/browser';
import { MarkdownModule } from '@opensumi/ide-markdown';
import { MarkersModule } from '@opensumi/ide-markers/browser';
import { MenuBarModule } from '@opensumi/ide-menu-bar/browser';
import { MonacoModule } from '@opensumi/ide-monaco/browser';
import { MonacoEnhanceModule } from '@opensumi/ide-monaco-enhance/module';
import { OpenedEditorModule } from '@opensumi/ide-opened-editor/browser';
import { OutlineModule } from '@opensumi/ide-outline/browser';
import { OutputModule } from '@opensumi/ide-output/browser';
import { OverlayModule } from '@opensumi/ide-overlay/browser';
import { PreferencesModule } from '@opensumi/ide-preferences/browser';
import { QuickOpenModule } from '@opensumi/ide-quick-open/browser';
import { SCMModule } from '@opensumi/ide-scm/browser';
import { SearchModule } from '@opensumi/ide-search/browser';
import { StatusBarModule } from '@opensumi/ide-status-bar/browser';
import { StorageModule } from '@opensumi/ide-storage/browser';
import { TaskModule } from '@opensumi/ide-task/browser';
import { TerminalNextModule } from '@opensumi/ide-terminal-next/browser';
import { ThemeModule } from '@opensumi/ide-theme/browser';
import { ToolbarModule } from '@opensumi/ide-toolbar/browser';
import { VariableModule } from '@opensumi/ide-variable/browser';
import { WebviewModule } from '@opensumi/ide-webview';
import { WorkspaceModule } from '@opensumi/ide-workspace/browser';
import { WorkspaceEditModule } from '@opensumi/ide-workspace-edit/browser';

import { renderApp } from './app';
import { customLayoutConfig } from './layout';

export const CommonBrowserModules: ConstructorOf<BrowserModule>[] = [
  MainLayoutModule,
  OverlayModule,
  LogModule,
  ClientCommonModule,
  MenuBarModule,
  MonacoModule,
  StatusBarModule,
  EditorModule,
  ExplorerModule,
  FileTreeNextModule,
  FileServiceClientModule,
  SearchModule,
  FileSchemeModule,
  OutputModule,
  QuickOpenModule,
  MarkersModule,
  ThemeModule,
  WorkspaceModule,
  ExtensionStorageModule,
  StorageModule,
  OpenedEditorModule,
  OutlineModule,
  PreferencesModule,
  ToolbarModule,
  WebviewModule,
  MarkdownModule,
  WorkspaceEditModule,
  SCMModule,
  DecorationModule,
  DebugModule,
  VariableModule,
  KeymapsModule,
  TerminalNextModule,
  ExtensionModule,
  OpenVsxExtensionManagerModule,
  MonacoEnhanceModule,
  ClientAddonModule,
  CommentsModule,
  TaskModule,
];

renderApp({
  useExperimentalShadowDom: true,
  defaultPreferences: {
    'general.theme': 'opensumi-design-dark-theme',
    'general.icon': 'vscode-icons',
    'application.confirmExit': 'never',
    'editor.quickSuggestionsDelay': 100,
  },
  modules: [...CommonBrowserModules, ElectronBasicModule],
  layoutConfig: customLayoutConfig,
  devtools: true, // 开启 core-browser 对 OpenSumi DevTools 的支持，默认为关闭
});
