import type { ICodeEditor as IMonacoCodeEditor } from '@opensumi/ide-monaco';
export const DebugEditor = Symbol('DebugEditor');
export type DebugEditor = IMonacoCodeEditor;
