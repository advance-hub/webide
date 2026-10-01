// Language-service adapters shared by the extension host and lightweight clients.
export { ExtHostDocumentData } from './api/vscode/doc/ext-data.host';
export type { Adapter } from './api/vscode/ext.host.language';
export { DefinitionAdapter } from './api/vscode/language/definition';
export { HoverAdapter } from './api/vscode/language/hover';
export { ReferenceAdapter } from './api/vscode/language/reference';
