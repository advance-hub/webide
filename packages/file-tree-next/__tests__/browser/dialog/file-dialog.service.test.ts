import { TreeNodeType } from '@opensumi/ide-components';
import { LabelService, URI } from '@opensumi/ide-core-browser';
import { createBrowserInjector } from '@opensumi/ide-dev-tool/browser';
import { MockInjector } from '@opensumi/ide-dev-tool/injector';
import { FileStat, IFileServiceClient } from '@opensumi/ide-file-service';
import { IWorkspaceService } from '@opensumi/ide-workspace';

import { FileTreeDialogService } from '../../../src/browser/dialog/file-dialog.service';
import { IFileTreeAPI } from '../../../src/common';
import { Directory, File } from '../../../src/common/file-tree-node.define';

class TempDirectory {}
class TempFile {}

describe('FileDialogService should be work', () => {
  let injector: MockInjector;
  let fileTreeDialogService: FileTreeDialogService;
  const rootUri = URI.file('/userhome');
  const newFileByName = (name) => {
    const file = {
      uri: rootUri.resolve(name),
      name,
      filestat: {
        uri: rootUri.resolve(name).toString(),
        isDirectory: false,
        lastModification: new Date().getTime(),
      },
      type: TreeNodeType.TreeNode,
    } as File;
    file.constructor = new TempFile().constructor;
    return file;
  };
  const newDirectoryByName = (name) => {
    const directory = {
      uri: rootUri.resolve(name),
      name,
      filestat: {
        uri: rootUri.resolve(name).toString(),
        isDirectory: true,
        lastModification: new Date().getTime(),
      },
      type: TreeNodeType.CompositeTreeNode,
    } as Directory;
    directory.constructor = new TempDirectory().constructor;
    return directory;
  };
  const mockFileTreeAPI = {
    resolveFileStat: jest.fn(),
    resolveChildren: jest.fn(),
  };
  beforeEach(async () => {
    injector = createBrowserInjector([]);

    injector.overrideProviders(
      {
        token: IFileTreeAPI,
        useValue: mockFileTreeAPI,
      },
      {
        token: IWorkspaceService,
        useValue: {
          roots: [
            {
              uri: rootUri.toString(),
              lastModification: new Date().getTime(),
              isDirectory: true,
            } as FileStat,
          ],
        },
      },
      {
        token: LabelService,
        useValue: {},
      },
    );
    mockFileTreeAPI.resolveFileStat.mockResolvedValue({
      uri: rootUri.toString(),
      lastModification: new Date().getTime(),
      isDirectory: true,
    } as FileStat);
    mockFileTreeAPI.resolveChildren.mockResolvedValue({
      children: [
        {
          ...newDirectoryByName('child'),
          ensureLoaded: jest.fn(),
        },
      ],
      filestat: {},
    });
    fileTreeDialogService = injector.get(FileTreeDialogService, [rootUri.toString()]);
    await fileTreeDialogService.whenReady;
  });

  afterEach(async () => {
    await injector.disposeAll();
    mockFileTreeAPI.resolveFileStat.mockReset();
    mockFileTreeAPI.resolveChildren.mockReset();
    mockFileTreeAPI.resolveFileStat.mockReset();
  });

  it('resolveChildren method should be work', async () => {
    const children = await fileTreeDialogService.resolveChildren();
    expect(mockFileTreeAPI.resolveChildren).toHaveBeenCalledTimes(1);
    expect(children.length > 0).toBeTruthy();
    await fileTreeDialogService.resolveChildren(children![0] as Directory);
    expect(mockFileTreeAPI.resolveChildren).toHaveBeenCalledTimes(2);
  });

  it('resolveRoot method should be work', async () => {
    await fileTreeDialogService.resolveRoot(rootUri.toString());
    expect(mockFileTreeAPI.resolveFileStat).toHaveBeenCalledTimes(2);
    expect(mockFileTreeAPI.resolveChildren).toHaveBeenCalledTimes(1);
  });

  it('getDirectoryList method should be work', async () => {
    await fileTreeDialogService.resolveRoot(rootUri.toString());
    const directory = fileTreeDialogService.getDirectoryList();
    expect(directory.length === 2).toBeTruthy();
  });

  it('rejects directories in file dialogs but accepts them in folder dialogs', async () => {
    expect.hasAssertions();
    const getFileStat = jest.fn(async (uri) => ({ uri, isDirectory: uri === 'file:///' }));
    injector.overrideProviders({ token: IFileServiceClient, useValue: { getFileStat } });
    await expect(fileTreeDialogService.resolveOpenSelection(['/'], { canSelectFolders: false })).rejects.toThrow(
      'Folders cannot be opened as files',
    );
    await expect(
      fileTreeDialogService.resolveOpenSelection(['/'], { canSelectFolders: true, canSelectFiles: false }),
    ).resolves.toEqual(['/']);
    await expect(
      fileTreeDialogService.resolveOpenSelection(['/app/package.json'], { canSelectFiles: true }),
    ).resolves.toEqual(['/app/package.json']);
  });

  it('validates typed paths against file filters', async () => {
    expect.hasAssertions();
    injector.overrideProviders({
      token: IFileServiceClient,
      useValue: { getFileStat: async (uri) => ({ uri, isDirectory: false }) },
    });
    await expect(
      fileTreeDialogService.resolveOpenSelection(['/app/readme.md'], { filters: { Workspace: ['code-workspace'] } }),
    ).rejects.toThrow('requested type');
  });

  it('sortComparator method should be work', () => {
    let res = fileTreeDialogService.sortComparator(newFileByName('a'), newDirectoryByName('a'));
    expect(res).toBe(1);
    res = fileTreeDialogService.sortComparator(newFileByName('a'), newFileByName('b'));
    expect(res).toBe(-1);
    res = fileTreeDialogService.sortComparator(newDirectoryByName('a'), newDirectoryByName('b'));
    expect(res).toBe(-1);
    res = fileTreeDialogService.sortComparator(newDirectoryByName('a'), newDirectoryByName('a'));
    expect(res).toBe(0);
    res = fileTreeDialogService.sortComparator(newFileByName('a'), newFileByName('a'));
    expect(res).toBe(0);
  });
});
