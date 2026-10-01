import { Injector } from '@opensumi/di';
import {
  ContextKeyChangeEvent as BrowserContextChange,
  IContextKeyService as BrowserContextKeyService,
} from '@opensumi/ide-core-browser';
import { ContextKeyChangeEvent, IContextKeyService, RawContextKey } from '@opensumi/ide-core-common/contextkeys';
import { Event } from '@opensumi/monaco-editor-core/esm/vs/base/common/event';
import { IConfigurationService } from '@opensumi/monaco-editor-core/esm/vs/platform/configuration/common/configuration';

import { MonacoContextKeyService } from '../../src/browser/monaco.context-key.service';

describe('shared context keys with the Monaco browser adapter', () => {
  let injector: Injector;
  let service: MonacoContextKeyService;

  beforeEach(() => {
    injector = new Injector([
      { token: IContextKeyService, useClass: MonacoContextKeyService },
      { token: IConfigurationService, useValue: { onDidChangeConfiguration: Event.None, getValue: () => undefined } },
    ]);
    service = injector.get(IContextKeyService);
  });

  afterEach(async () => {
    await injector.disposeAll();
  });

  it('preserves tokens, events, key inheritance and DOM scope attachment', () => {
    expect.hasAssertions();
    expect(BrowserContextKeyService).toBe(IContextKeyService);
    expect(BrowserContextChange).toBe(ContextKeyChangeEvent);
    expect(injector.get(BrowserContextKeyService)).toBe(service);
    const shared: IContextKeyService = service;
    const enabled = new RawContextKey('shared.enabled', false).bind(shared);
    const first = document.createElement('div');
    const second = document.createElement('div');
    const scoped = shared.createScoped(first);
    const local = scoped.createKey('shared.local', false);
    const events: ContextKeyChangeEvent[] = [];
    const subscription = scoped.onDidChangeContext((event) => events.push(event));
    enabled.set(true);
    local.set(true);
    expect(scoped.match('shared.enabled && shared.local')).toBe(true);
    expect(service.match('shared.local', first)).toBe(true);
    expect(service.getValue('shared.local')).toBeUndefined();
    expect(
      events.some(
        (event) => event instanceof ContextKeyChangeEvent && event.payload.affectsSome(new Set(['shared.local'])),
      ),
    ).toBe(true);
    const contextId = first.getAttribute('data-keybinding-context');
    expect(contextId).not.toBeNull();
    scoped.attachToDomNode(second);
    expect(first.hasAttribute('data-keybinding-context')).toBe(false);
    expect(second.getAttribute('data-keybinding-context')).toBe(contextId);
    expect(service.match('shared.local', second)).toBe(true);
    local.reset();
    expect(scoped.match('shared.local')).toBe(false);
    subscription.dispose();
    scoped.dispose();
    expect(second.hasAttribute('data-keybinding-context')).toBe(false);
  });

  it('retains the Browser overload for wrapping an existing Monaco context', () => {
    expect.hasAssertions();
    const borrowed = service.createScoped(service.contextKeyService);
    expect(borrowed.contextKeyService).toBe(service.contextKeyService);
    borrowed.createKey('editor.borrowed', true);
    expect(service.getValue('editor.borrowed')).toBe(true);
    expect(borrowed.match('editor.borrowed')).toBe(true);
    borrowed.dispose();
  });
});
