import { Deferred, Emitter, URI } from '@opensumi/ide-core-common';
import { createBrowserInjector } from '@opensumi/ide-dev-tool/browser';
import { MockInjector } from '@opensumi/ide-dev-tool/injector';
import { WorkbenchEditorService } from '@opensumi/ide-editor';

import { MainThreadEditorTabsService } from '../../src/browser/vscode/api/main.thread.editor-tabs';
import { TabModelOperationKind } from '../../src/common/vscode/editor-tabs';

describe('MainThreadEditorTabsService', () => {
  it('publishes pinned state in initial, update, and move DTOs', async () => {
    const tabChanged = new Emitter<void>();
    const tabOperation = new Emitter<any>();
    const bodyChanged = new Emitter<void>();
    const resource = { uri: new URI('test://pin/extension'), name: 'extension.ts' } as any;
    const secondResource = { uri: new URI('test://pin/second'), name: 'second.ts' } as any;
    let pinned = true;
    const group = {
      groupId: 1,
      index: 0,
      resources: [resource, secondResource],
      currentResource: resource,
      previewURI: null,
      isPinned: jest.fn((uri: URI) => uri.isEqual(resource.uri) && pinned),
      getLastOpenType: jest.fn(() => ({ type: 'code' })),
      resourceService: { getResourceDecoration: jest.fn(() => ({ dirty: false })) },
      editorComponentRegistry: {},
      onDidEditorGroupTabOperation: tabOperation.event,
      onDidEditorGroupTabChanged: tabChanged.event,
      onDidEditorGroupBodyChanged: bodyChanged.event,
      addDispose: jest.fn(),
      closeAll: jest.fn(async () => true),
    } as any;
    const groupsChanged = new Emitter<void>();
    const activeChanged = new Emitter<void>();
    const contributionsReady = new Deferred<void>();
    const editorService = {
      editorGroups: [group],
      sortedEditorGroups: [group],
      currentEditorGroup: group,
      onDidEditorGroupsChanged: groupsChanged.event,
      onActiveResourceChange: activeChanged.event,
      contributionsReady,
    } as any;
    const proxy = {
      $acceptEditorTabModel: jest.fn(),
      $acceptTabOperation: jest.fn(),
      $acceptTabGroupUpdate: jest.fn(),
    };
    const injector = createBrowserInjector(
      [],
      new MockInjector([{ token: WorkbenchEditorService, useValue: editorService }]),
    );
    const service = injector.get(MainThreadEditorTabsService, [{ getProxy: () => proxy } as any]);
    contributionsReady.resolve();
    await Promise.resolve();

    const initialTabs = proxy.$acceptEditorTabModel.mock.calls.at(-1)[0][0].tabs;
    expect(initialTabs.map((tab) => tab.label)).toEqual(['extension.ts', 'second.ts']);
    expect(initialTabs.map((tab) => tab.isPinned)).toEqual([true, false]);

    pinned = false;
    tabChanged.fire();
    expect(proxy.$acceptTabOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: TabModelOperationKind.TAB_UPDATE,
        tabDto: expect.objectContaining({ isPinned: false }),
      }),
    );

    pinned = true;
    group.resources.splice(0, 1);
    group.resources.splice(1, 0, resource);
    tabOperation.fire({ type: 'move', resource, oldIndex: 0, index: 1 });
    expect(group.resources.map((item) => item.name)).toEqual(['second.ts', 'extension.ts']);
    expect(proxy.$acceptTabOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: TabModelOperationKind.TAB_MOVE,
        index: 1,
        oldIndex: 0,
        tabDto: expect.objectContaining({ isPinned: true }),
      }),
    );

    await expect(service.$closeGroup([group.groupId])).resolves.toBe(true);
    expect(group.closeAll).toHaveBeenCalledWith({ closePinned: true });

    // Preview rendering can emit multiple body/tab changes before TAB_OPEN.
    const preview = { uri: new URI('test://pin/preview'), name: 'preview.ts' } as any;
    group.resources.push(preview);
    bodyChanged.fire();
    group.currentResource = preview;
    tabChanged.fire();
    const previewId = '1~test://pin/preview';
    expect(proxy.$acceptTabOperation.mock.calls.filter(([operation]) => operation.tabDto.id === previewId)).toEqual([]);
    tabOperation.fire({ type: 'open', resource: preview, index: 2 });
    expect(proxy.$acceptTabOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: TabModelOperationKind.TAB_OPEN,
        tabDto: expect.objectContaining({ id: previewId }),
      }),
    );
    group.previewURI = preview.uri;
    bodyChanged.fire();
    expect(proxy.$acceptTabOperation).toHaveBeenLastCalledWith(
      expect.objectContaining({
        kind: TabModelOperationKind.TAB_UPDATE,
        tabDto: expect.objectContaining({ id: previewId }),
      }),
    );

    service.dispose();
    await injector.disposeAll();
  });
});
