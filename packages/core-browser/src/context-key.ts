import { IContextKeyService as ContextKeyServiceToken } from '@opensumi/ide-core-common/contextkeys';

import type { IContextKeyService as SharedContextKeyService } from '@opensumi/ide-core-common/contextkeys';
import type { ContextKeyService } from '@opensumi/monaco-editor-core/esm/vs/platform/contextkey/browser/contextKeyService';
import type { IContextKeyServiceTarget } from '@opensumi/monaco-editor-core/esm/vs/platform/contextkey/common/contextkey';

export { ContextKeyChangeEvent } from '@opensumi/ide-core-common/contextkeys';
export type { IContextKey, IContextKeyChangeEventPayload, IReadableSet } from '@opensumi/ide-core-common/contextkeys';

export const IContextKeyService: typeof ContextKeyServiceToken = ContextKeyServiceToken;

/** Browser integration also accepts an existing Monaco context scope. */
export interface IContextKeyService extends SharedContextKeyService {
  createScoped(target?: IContextKeyServiceTarget | ContextKeyService): IScopedContextKeyService;
}

export interface IScopedContextKeyService extends IContextKeyService {
  attachToDomNode(domNode: HTMLElement): void;
}
