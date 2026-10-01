import { FeatureDefinition, ProductProfile, defineFeature, defineProductProfile } from '@opensumi/ide-core-common';

export const browserFeature = (id: string, requires?: readonly FeatureDefinition[]): FeatureDefinition =>
  defineFeature({
    id,
    runtimes: ['browser'],
    requires,
  });

export const nodeFeature = (id: string, requires?: readonly FeatureDefinition[]): FeatureDefinition =>
  defineFeature({
    id,
    runtimes: ['node'],
    requires,
  });

export const sharedFeature = (id: string, requires?: readonly FeatureDefinition[]): FeatureDefinition =>
  defineFeature({
    id,
    runtimes: ['browser', 'node'],
    requires,
  });

export const MainLayoutFeature = browserFeature('opensumi.workbench.layout');
export const OverlayFeature = browserFeature('opensumi.workbench.overlay');
export const BrowserLogFeature = browserFeature('opensumi.platform.browser-log');
export const CoreFeature = sharedFeature('opensumi.platform.core');
export const NodeLogFeature = nodeFeature('opensumi.platform.node-log');
export const MenuBarFeature = browserFeature('opensumi.workbench.menu-bar');
export const MonacoFeature = browserFeature('opensumi.editor.monaco');
export const StatusBarFeature = browserFeature('opensumi.workbench.status-bar');
export const EditorFeature = browserFeature('opensumi.editor');
export const ExplorerFeature = browserFeature('opensumi.files.explorer');
export const FileTreeFeature = browserFeature('opensumi.files.tree');
export const FileServiceFeature = sharedFeature('opensumi.files.service', [CoreFeature]);
export const ProcessFeature = nodeFeature('opensumi.process', [CoreFeature]);
export const FileSearchFeature = nodeFeature('opensumi.files.search', [FileServiceFeature, ProcessFeature]);
export const SearchFeature = sharedFeature('opensumi.search', [FileServiceFeature, ProcessFeature]);
export const BrowserFileSchemeFeature = browserFeature('opensumi.files.browser-scheme');
export const OutputFeature = browserFeature('opensumi.output');
export const QuickOpenFeature = browserFeature('opensumi.quick-open');
export const MarkersFeature = browserFeature('opensumi.markers');
export const ThemeFeature = browserFeature('opensumi.theme');
export const WorkspaceFeature = browserFeature('opensumi.workspace');
export const ExtensionStorageFeature = browserFeature('opensumi.extensions.storage');
export const StorageFeature = browserFeature('opensumi.storage');
export const OpenedEditorFeature = browserFeature('opensumi.editor.opened');
export const OutlineFeature = browserFeature('opensumi.editor.outline');
export const PreferencesFeature = browserFeature('opensumi.preferences');
export const ToolbarFeature = browserFeature('opensumi.workbench.toolbar');
export const WebviewFeature = browserFeature('opensumi.webview');
export const MarkdownFeature = browserFeature('opensumi.markdown');
export const WorkspaceEditFeature = browserFeature('opensumi.workspace-edit');
export const SCMFeature = browserFeature('opensumi.scm');
export const DecorationFeature = browserFeature('opensumi.decoration');
export const DebugFeature = browserFeature('opensumi.debug');
export const VariableFeature = browserFeature('opensumi.variables');
export const KeymapsFeature = browserFeature('opensumi.keymaps');
export const TerminalFeature = sharedFeature('opensumi.terminal', [CoreFeature]);
export const ExtensionFeature = sharedFeature('opensumi.extensions', [CoreFeature]);
export const ExtensionManagerFeature = sharedFeature('opensumi.extensions.marketplace', [ExtensionFeature]);
export const NodeFileSchemeFeature = nodeFeature('opensumi.files.node-scheme');
export const MonacoEnhanceFeature = browserFeature('opensumi.editor.monaco-enhance');
export const AddonsFeature = sharedFeature('opensumi.addons');
export const CommentsFeature = browserFeature('opensumi.comments');
export const TaskFeature = browserFeature('opensumi.tasks');
export const TestingFeature = browserFeature('opensumi.testing', [TaskFeature]);
export const AIDesignFeature = browserFeature('opensumi.ai.design', [CoreFeature]);
export const AINativeFeature = sharedFeature('opensumi.ai.native', [CoreFeature]);
export const NotebookFeature = browserFeature('opensumi.notebook', [EditorFeature]);
export const CollaborationFeature = sharedFeature('opensumi.collaboration', [CoreFeature]);

export type OpenSumiProductOption = 'ai' | 'notebook' | 'collaboration';

/**
 * One product profile shared by Browser and Node. Runtime filtering preserves
 * the exact legacy order on both sides, including their intentional differences.
 */
export const OpenSumiDefaultProductProfile: ProductProfile = defineProductProfile({
  id: 'opensumi.default',
  features: [
    MainLayoutFeature,
    OverlayFeature,
    BrowserLogFeature,
    CoreFeature,
    NodeLogFeature,
    MenuBarFeature,
    MonacoFeature,
    StatusBarFeature,
    EditorFeature,
    ExplorerFeature,
    FileTreeFeature,
    FileServiceFeature,
    ProcessFeature,
    FileSearchFeature,
    SearchFeature,
    BrowserFileSchemeFeature,
    OutputFeature,
    QuickOpenFeature,
    MarkersFeature,
    ThemeFeature,
    WorkspaceFeature,
    ExtensionStorageFeature,
    StorageFeature,
    OpenedEditorFeature,
    OutlineFeature,
    PreferencesFeature,
    ToolbarFeature,
    WebviewFeature,
    MarkdownFeature,
    WorkspaceEditFeature,
    SCMFeature,
    DecorationFeature,
    DebugFeature,
    VariableFeature,
    KeymapsFeature,
    TerminalFeature,
    ExtensionFeature,
    ExtensionManagerFeature,
    NodeFileSchemeFeature,
    MonacoEnhanceFeature,
    AddonsFeature,
    CommentsFeature,
    TaskFeature,
    TestingFeature,
  ],
  optionalFeatures: {
    ai: [AIDesignFeature, AINativeFeature],
    notebook: [NotebookFeature],
    collaboration: [CollaborationFeature],
  },
});

// Compatibility views are derived from the profile; there is only one feature order.
export const CommonBrowserFeatures = OpenSumiDefaultProductProfile.features.filter((feature) =>
  feature.runtimes.includes('browser'),
);
export const CommonNodeFeatures = OpenSumiDefaultProductProfile.features.filter((feature) =>
  feature.runtimes.includes('node'),
);

function optionalFeatures(
  runtime: 'browser' | 'node',
): Readonly<Record<OpenSumiProductOption, readonly FeatureDefinition[]>> {
  return Object.fromEntries(
    Object.entries(OpenSumiDefaultProductProfile.optionalFeatures!).map(([id, features]) => [
      id,
      features.filter((feature) => feature.runtimes.includes(runtime)),
    ]),
  ) as unknown as Record<OpenSumiProductOption, readonly FeatureDefinition[]>;
}
export const OptionalBrowserFeatures = optionalFeatures('browser');
export const OptionalNodeFeatures = optionalFeatures('node');
