import { CommentsModule } from '@opensumi/ide-comments/browser';
import { BrowserModule, ClientCommonModule } from '@opensumi/ide-core-browser';
import { ConstructorOf } from '@opensumi/ide-core-common';
import { DecorationModule } from '@opensumi/ide-decoration/browser';
import { EditorModule } from '@opensumi/ide-editor/browser';
import { ExplorerModule } from '@opensumi/ide-explorer/browser';
import { ExtensionModule } from '@opensumi/ide-extension/browser';
import { ExtensionStorageModule } from '@opensumi/ide-extension-storage/browser';
import { FileServiceClientModule } from '@opensumi/ide-file-service/browser';
import { FileTreeNextModule } from '@opensumi/ide-file-tree-next/browser';
import { KeymapsModule } from '@opensumi/ide-keymaps/browser';
import { LogModule } from '@opensumi/ide-logs/browser';
import { MainLayoutModule } from '@opensumi/ide-main-layout/browser';
import { MenuBarModule } from '@opensumi/ide-menu-bar/browser';
import { MonacoModule } from '@opensumi/ide-monaco/browser';
import { OpenedEditorModule } from '@opensumi/ide-opened-editor/browser';
import { OutlineModule } from '@opensumi/ide-outline/browser';
import { OutputModule } from '@opensumi/ide-output/browser';
import { OverlayModule } from '@opensumi/ide-overlay/browser';
import { PreferencesModule } from '@opensumi/ide-preferences/browser';
import { QuickOpenModule } from '@opensumi/ide-quick-open/browser';
import { StatusBarModule } from '@opensumi/ide-status-bar/browser';
import { StorageModule } from '@opensumi/ide-storage/browser';
import { ThemeModule } from '@opensumi/ide-theme/browser';
import { WebviewModule } from '@opensumi/ide-webview/browser';
import { WorkspaceModule } from '@opensumi/ide-workspace/browser';
import { WorkspaceEditModule } from '@opensumi/ide-workspace-edit/browser';

import { BrowserFileSchemeModule } from './lite-module/overrides/browser-file-scheme';

export const CommonBrowserModules: ConstructorOf<BrowserModule>[] = [
  FileServiceClientModule,
  MainLayoutModule,
  OverlayModule,
  LogModule,
  ClientCommonModule,
  StatusBarModule,
  MenuBarModule,
  MonacoModule,
  ExplorerModule,
  EditorModule,
  QuickOpenModule,
  KeymapsModule,
  FileTreeNextModule,
  ThemeModule,
  WorkspaceModule,
  ExtensionStorageModule,
  StorageModule,
  PreferencesModule,
  OpenedEditorModule,
  DecorationModule,
  WorkspaceEditModule,
  CommentsModule,
  WebviewModule,
  OutputModule,
  BrowserFileSchemeModule,
  OutlineModule,
  ExtensionModule,
];
