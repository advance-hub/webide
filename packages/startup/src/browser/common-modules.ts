import { ClientAddonModule } from '@opensumi/ide-addons/browser';
import { CommentsModule } from '@opensumi/ide-comments/browser';
import { BrowserModule, ClientCommonModule, ConstructorOf } from '@opensumi/ide-core-browser';
import { DebugModule } from '@opensumi/ide-debug/browser';
import { DecorationModule } from '@opensumi/ide-decoration/browser';
import { EditorModule } from '@opensumi/ide-editor/browser';
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
import { TestingModule } from '@opensumi/ide-testing/browser';
import { ThemeModule } from '@opensumi/ide-theme/browser';
import { ToolbarModule } from '@opensumi/ide-toolbar/browser';
import { VariableModule } from '@opensumi/ide-variable/browser';
import { WebviewModule } from '@opensumi/ide-webview';
import { WorkspaceModule } from '@opensumi/ide-workspace/browser';
import { WorkspaceEditModule } from '@opensumi/ide-workspace-edit/browser';

import {
  AddonsFeature,
  BrowserFileSchemeFeature,
  BrowserLogFeature,
  CommentsFeature,
  CoreFeature,
  DebugFeature,
  DecorationFeature,
  EditorFeature,
  ExplorerFeature,
  ExtensionFeature,
  ExtensionManagerFeature,
  ExtensionStorageFeature,
  FileServiceFeature,
  FileTreeFeature,
  KeymapsFeature,
  MainLayoutFeature,
  MarkdownFeature,
  MarkersFeature,
  MenuBarFeature,
  MonacoEnhanceFeature,
  MonacoFeature,
  OpenedEditorFeature,
  OutlineFeature,
  OutputFeature,
  OverlayFeature,
  PreferencesFeature,
  QuickOpenFeature,
  SCMFeature,
  SearchFeature,
  StatusBarFeature,
  StorageFeature,
  TaskFeature,
  TerminalFeature,
  TestingFeature,
  ThemeFeature,
  ToolbarFeature,
  VariableFeature,
  WebviewFeature,
  WorkspaceEditFeature,
  WorkspaceFeature,
} from '../product-profile';
import { ProductModuleBinding, compileOpenSumiProductRuntimePlan } from '../product-runtime-plan';

export const CommonBrowserBindings: readonly ProductModuleBinding<ConstructorOf<BrowserModule>>[] = [
  { feature: MainLayoutFeature, module: MainLayoutModule },
  { feature: OverlayFeature, module: OverlayModule },
  { feature: BrowserLogFeature, module: LogModule },
  { feature: CoreFeature, module: ClientCommonModule },
  { feature: MenuBarFeature, module: MenuBarModule },
  { feature: MonacoFeature, module: MonacoModule },
  { feature: StatusBarFeature, module: StatusBarModule },
  { feature: EditorFeature, module: EditorModule },
  { feature: ExplorerFeature, module: ExplorerModule },
  { feature: FileTreeFeature, module: FileTreeNextModule },
  { feature: FileServiceFeature, module: FileServiceClientModule },
  { feature: SearchFeature, module: SearchModule },
  { feature: BrowserFileSchemeFeature, module: FileSchemeModule },
  { feature: OutputFeature, module: OutputModule },
  { feature: QuickOpenFeature, module: QuickOpenModule },
  { feature: MarkersFeature, module: MarkersModule },
  { feature: ThemeFeature, module: ThemeModule },
  { feature: WorkspaceFeature, module: WorkspaceModule },
  { feature: ExtensionStorageFeature, module: ExtensionStorageModule },
  { feature: StorageFeature, module: StorageModule },
  { feature: OpenedEditorFeature, module: OpenedEditorModule },
  { feature: OutlineFeature, module: OutlineModule },
  { feature: PreferencesFeature, module: PreferencesModule },
  { feature: ToolbarFeature, module: ToolbarModule },
  { feature: WebviewFeature, module: WebviewModule },
  { feature: MarkdownFeature, module: MarkdownModule },
  { feature: WorkspaceEditFeature, module: WorkspaceEditModule },
  { feature: SCMFeature, module: SCMModule },
  { feature: DecorationFeature, module: DecorationModule },
  { feature: DebugFeature, module: DebugModule },
  { feature: VariableFeature, module: VariableModule },
  { feature: KeymapsFeature, module: KeymapsModule },
  { feature: TerminalFeature, module: TerminalNextModule },
  { feature: ExtensionFeature, module: ExtensionModule },
  { feature: ExtensionManagerFeature, module: OpenVsxExtensionManagerModule },
  { feature: MonacoEnhanceFeature, module: MonacoEnhanceModule },
  { feature: AddonsFeature, module: ClientAddonModule },
  { feature: CommentsFeature, module: CommentsModule },
  { feature: TaskFeature, module: TaskModule },
  { feature: TestingFeature, module: TestingModule },
];

export const CommonBrowserRuntimePlan = compileOpenSumiProductRuntimePlan({
  runtime: 'browser',
  commonBindings: CommonBrowserBindings,
});

/** Compatibility module view, derived from the same bound plan used by the product. */
export const CommonBrowserModules: ConstructorOf<BrowserModule>[] = CommonBrowserRuntimePlan.entries.map(
  (entry) => entry.module,
);
