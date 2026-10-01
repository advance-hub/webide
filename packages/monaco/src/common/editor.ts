export {
  EndOfLinePreference,
  TrackedRangeStickiness,
  FindMatch,
  EndOfLineSequence,
  OverviewRulerLane,
  TextModelResolvedOptions,
} from '@opensumi/monaco-editor-core/esm/vs/editor/common/model';
export type {
  IAttachedView,
  ICursorStateComputer,
  IIdentifiedSingleEditOperation,
  IModelDecoration,
  IModelDecorationOptions,
  IModelDecorationOverviewRulerOptions,
  InjectedTextOptions,
  IModelDecorationsChangeAccessor,
  IModelDecorationMinimapOptions,
  IModelDeltaDecoration,
  ITextModelUpdateOptions,
  ITextModel,
  ITextBuffer,
  ITextSnapshot,
} from '@opensumi/monaco-editor-core/esm/vs/editor/common/model';
export type { IWordAtPosition } from '@opensumi/monaco-editor-core/esm/vs/editor/common/core/wordHelper';
export * from '@opensumi/monaco-editor-core/esm/vs/editor/common/cursorEvents';
export { DetailedLineRangeMapping } from '@opensumi/monaco-editor-core/esm/vs/editor/common/diff/rangeMapping';
export * from '@opensumi/monaco-editor-core/esm/vs/editor/common/config/editorOptions';
export type { ITokenThemeRule } from '@opensumi/monaco-editor-core/esm/vs/editor/common/languages/supports/tokenization';
export type {
  IPartialEditorMouseEvent,
  IEditorMouseEvent,
  IActiveCodeEditor,
  IEditorAriaOptions,
  ICodeEditor,
  IPasteEvent,
  IContentWidget,
  IViewZoneChangeAccessor,
  IOverlayWidget,
  IMouseTarget,
  IGlyphMarginWidget,
  IContentWidgetPosition,
  IViewZone,
} from '@opensumi/monaco-editor-core/esm/vs/editor/browser/editorBrowser';
export * from '@opensumi/monaco-editor-core/esm/vs/editor/common/textModelEvents';
export type {
  IStandaloneDiffEditor,
  IStandaloneCodeEditor,
  IStandaloneEditorConstructionOptions,
  IStandaloneDiffEditorConstructionOptions,
  IActionDescriptor,
} from '@opensumi/monaco-editor-core/esm/vs/editor/standalone/browser/standaloneCodeEditor';
export { ScrollType } from '@opensumi/monaco-editor-core/esm/vs/editor/common/editorCommon';
export type {
  IDiffEditorModel,
  IDiffEditorViewModel,
  IEditorAction,
  IEditorDecorationsCollection,
  IDiffEditorViewState,
  ICommand,
  IScrollEvent,
  IModelChangedEvent,
  ICodeEditorViewState,
  IContentSizeChangedEvent,
  IDecorationOptions,
} from '@opensumi/monaco-editor-core/esm/vs/editor/common/editorCommon';
export type { IDimension } from '@opensumi/monaco-editor-core/esm/vs/editor/common/core/dimension';
export type {
  IChange,
  ILineChange,
} from '@opensumi/monaco-editor-core/esm/vs/editor/common/diff/legacyLinesDiffComputer';
export { IContextKeyService } from '@opensumi/monaco-editor-core/esm/vs/platform/contextkey/common/contextkey';
export type {
  ContextKeyValue,
  IContextKey,
} from '@opensumi/monaco-editor-core/esm/vs/platform/contextkey/common/contextkey';
export { CommandsRegistry } from '@opensumi/monaco-editor-core/esm/vs/platform/commands/common/commands';
export type { ICommandHandler } from '@opensumi/monaco-editor-core/esm/vs/platform/commands/common/commands';
export { Scrollable, ScrollbarVisibility } from '@opensumi/monaco-editor-core/esm/vs/base/common/scrollable';
export type { INewScrollPosition } from '@opensumi/monaco-editor-core/esm/vs/base/common/scrollable';
export type { IEditorWhitespace, IViewModel } from '@opensumi/monaco-editor-core/esm/vs/editor/common/viewModel';
export { IMarkerData } from '@opensumi/monaco-editor-core/esm/vs/platform/markers/common/markers';
export type { IMarker, IRelatedInformation } from '@opensumi/monaco-editor-core/esm/vs/platform/markers/common/markers';

export { KeyMod } from '@opensumi/monaco-editor-core/esm/vs/editor/common/services/editorBaseApi';
