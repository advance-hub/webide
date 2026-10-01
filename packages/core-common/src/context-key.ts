import { BasicEvent } from './event-bus/basic-event';

import type { ContextKeyValue, IContextKey } from './raw-context-key';
import type { Event } from '@opensumi/ide-utils';
import type {
  ContextKeyExpr,
  IContextKeyServiceTarget,
  IContextKeyService as IMonacoContextKeyService,
} from '@opensumi/monaco-editor-core/esm/vs/platform/contextkey/common/contextkey';

export const IContextKeyService = Symbol('IContextKeyService');

export interface IContextKeyService {
  onDidChangeContext: Event<ContextKeyChangeEvent>;

  bufferChangeEvents(callback: () => void): void;

  getValue<T>(key: string): T | undefined;
  createKey<T extends ContextKeyValue = any>(key: string, defaultValue: T | undefined): IContextKey<T>;
  match(expression: string | ContextKeyExpr | undefined, context?: HTMLElement | null): boolean;
  getKeysInWhen(when: string | ContextKeyExpr | undefined): string[];
  getContextKeyValue<T>(key: string): T | undefined;
  contextKeyService: IMonacoContextKeyService;

  /** Create a child context, optionally attached to a DOM target. */
  createScoped(target?: IContextKeyServiceTarget): IScopedContextKeyService;

  parse(when: string | undefined): ContextKeyExpr | undefined;
  dispose(): void;
}

export interface IScopedContextKeyService extends IContextKeyService {
  attachToDomNode(domNode: HTMLElement): void;
}

export interface IContextKeyChangeEventPayload {
  affectsSome(keys: IReadableSet<string>): boolean;
}

export interface IReadableSet<T> {
  has(value: T): boolean;
}

export class ContextKeyChangeEvent extends BasicEvent<IContextKeyChangeEventPayload> {}
