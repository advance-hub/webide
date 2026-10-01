// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore Yjs packages publish ESM declarations for their CommonJS runtime.
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from 'y-protocols/awareness';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { Doc } from 'yjs';

import { Injector } from '@opensumi/di';
import { ICodeEditor } from '@opensumi/ide-monaco';

import { CursorWidget, CursorWidgetRegistry } from '../../src/browser/cursor-widget';

describe('collaboration presence widgets', () => {
  let registry: CursorWidgetRegistry;
  let awareness: Awareness;
  let doc: Doc;
  let peers: Awareness[];
  let visibleWidgets: Map<string, CursorWidget>;
  let disposeEditor: () => void;

  beforeEach(() => {
    doc = new Doc();
    awareness = new Awareness(doc);
    peers = [];
    visibleWidgets = new Map();
    const editor = {
      addContentWidget: (widget: CursorWidget) => visibleWidgets.set(widget.getId(), widget),
      removeContentWidget: (widget: CursorWidget) => visibleWidgets.delete(widget.getId()),
      onDidDispose: (listener: () => void) => {
        disposeEditor = listener;
        return { dispose() {} };
      },
    } as unknown as ICodeEditor;
    registry = new Injector().get(CursorWidgetRegistry, [editor, awareness]);
  });

  afterEach(() => {
    registry.destroy();
    awareness.destroy();
    doc.destroy();
    peers.forEach((peer) => {
      peer.destroy();
      peer.doc.destroy();
    });
  });

  function connect(nickname: string) {
    const peer = new Awareness(new Doc());
    peers.push(peer);
    peer.setLocalStateField('user-info', { id: 'same-user', nickname });
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peer, [peer.clientID]), 'remote');
    return peer;
  }

  it('keeps separate cursors for two connections with the same user and nickname', () => {
    expect.hasAssertions();
    const first = connect('Alice');
    const second = connect('Alice');

    expect(visibleWidgets.size).toBe(2);
    expect(registry.widgets.get(first.clientID)?.getId()).not.toBe(registry.widgets.get(second.clientID)?.getId());
  });

  it('removes a departed peer without removing the remaining peer', () => {
    expect.hasAssertions();
    const departing = connect('Alice');
    const remaining = connect('Bob');
    departing.setLocalState(null);
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(departing, [departing.clientID]), 'remote');

    expect(registry.widgets.has(departing.clientID)).toBe(false);
    expect(registry.widgets.has(remaining.clientID)).toBe(true);
    expect(visibleWidgets.size).toBe(1);
  });

  it('updates a nickname on an existing connection and renders it as plain text', () => {
    expect.hasAssertions();
    const peer = connect('Alice');
    const widget = registry.widgets.get(peer.clientID)!;
    peer.setLocalStateField('user-info', { id: 'same-user', nickname: '<img src=x onerror=alert(1)>' });
    applyAwarenessUpdate(awareness, encodeAwarenessUpdate(peer, [peer.clientID]), 'remote');

    expect(registry.widgets.get(peer.clientID)).toBe(widget);
    expect(widget.getDomNode().textContent).toBe('<img src=x onerror=alert(1)>');
    expect(widget.getDomNode().querySelector('img')).toBeNull();
  });

  it('reclaims every widget when the editor is disposed', () => {
    expect.hasAssertions();
    connect('Alice');
    connect('Bob');
    disposeEditor();

    expect(visibleWidgets.size).toBe(0);
    expect(registry.widgets.size).toBe(0);
  });
});
