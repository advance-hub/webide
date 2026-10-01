import { Autowired, Injectable } from '@opensumi/di';

import { OnEvent, WithEventBus } from './event-bus';
import { FilesChangeEvent } from './file-events';
import { IStorage, STORAGE_NAMESPACE, StorageProvider } from './storage';
import { FileChangeType } from './types/file-watch';

import type { IPosition } from './types/editor';

@Injectable()
export class RecentStorage {
  @Autowired(StorageProvider)
  private getStorage: StorageProvider;

  private recentStorage: IStorage;
  private recentGlobalStorage: IStorage;

  public async getScopeStorage() {
    this.recentStorage = this.recentStorage || (await this.getStorage(STORAGE_NAMESPACE.RECENT_DATA));
    return this.recentStorage;
  }

  public async getGlobalStorage() {
    this.recentGlobalStorage =
      this.recentGlobalStorage || (await this.getStorage(STORAGE_NAMESPACE.GLOBAL_RECENT_DATA));
    return this.recentGlobalStorage;
  }
}

const OPENED_FILE = 'OPENED_FILE';

const FILES_POSITION = 'OPENED_FILES_POSITION';

@Injectable()
export class RecentFilesManager extends WithEventBus {
  @Autowired(RecentStorage)
  private recentStorage: RecentStorage;

  async updateMostRecentlyOpenedFile(url: string, position: IPosition) {
    const recentStorage = await this.recentStorage.getScopeStorage();
    const openedFilesPosition = recentStorage.get<{ [prop: string]: string }>(FILES_POSITION) || {};
    openedFilesPosition[url] = `#${position.lineNumber},${position.column}`;
    recentStorage.set(FILES_POSITION, openedFilesPosition);
  }

  async setMostRecentlyOpenedFile(uriString: string, isDelete?: boolean) {
    const recentStorage = await this.recentStorage.getScopeStorage();

    let fileList = await this.getMostRecentlyOpenedFiles();
    const existIdx = fileList.findIndex((file) => file === uriString);
    if (existIdx > -1) {
      fileList.splice(existIdx, 1);
    }
    if (!isDelete) {
      fileList.unshift(uriString);
    }

    // 仅存储50个最近文件
    if (fileList.length > 50) {
      fileList = fileList.slice(0, 50);
    }
    recentStorage.set(OPENED_FILE, fileList);
  }

  async getMostRecentlyOpenedFiles(includingRange?: boolean) {
    const recentStorage = await this.recentStorage.getScopeStorage();
    const fileList: string[] = recentStorage.get<string[]>(OPENED_FILE) || [];
    const openedFilesPosition = recentStorage.get<{ [prop: string]: string }>(FILES_POSITION) || {};
    if (includingRange) {
      return fileList.map((url) => {
        if (openedFilesPosition[url]) {
          return url + openedFilesPosition[url];
        }
        return url;
      });
    }
    return fileList;
  }

  @OnEvent(FilesChangeEvent)
  protected handleFilesDelete(event: FilesChangeEvent) {
    event.payload.forEach((change) => {
      if (change.type === FileChangeType.DELETED) {
        if (change.uri) {
          this.setMostRecentlyOpenedFile(change.uri, true);
        }
      }
    });
  }
}
