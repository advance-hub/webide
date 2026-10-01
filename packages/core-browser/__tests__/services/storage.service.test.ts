import { StorageService as SharedStorageService } from '@opensumi/ide-core-common/storage';
import { SlotLocation as SharedSlotLocation } from '@opensumi/ide-core-common/workbench';
import { createBrowserInjector } from '@opensumi/ide-dev-tool/browser';
import { MockInjector } from '@opensumi/ide-dev-tool/injector';

import { SlotLocation } from '../../src/react-providers/slot';
import { GlobalBrowserStorageService, StorageService } from '../../src/services';

describe('test for core-browser/src/services/storage-service.ts', () => {
  let injector: MockInjector;
  let browserStorageService: GlobalBrowserStorageService;
  beforeAll(() => {
    injector = createBrowserInjector([]);
    browserStorageService = injector.get<GlobalBrowserStorageService>(GlobalBrowserStorageService);
  });

  it('preserves shared storage tokens and slot identities through browser entrypoints', () => {
    expect(StorageService).toBe(SharedStorageService);
    expect(SlotLocation).toBe(SharedSlotLocation);
    injector.addProviders({ token: SharedStorageService, useValue: browserStorageService });
    expect(injector.get(StorageService)).toBe(browserStorageService);
  });

  it('GlobalBrowserStorageService', () => {
    const key = 'test-key';
    expect(browserStorageService.getData(key)).toBeUndefined();
    expect(browserStorageService.getData(key, 'default-val')).toBe('default-val');

    expect(browserStorageService.setData(key, '123')).toBeUndefined();
    expect(browserStorageService.getData(key)).toBe('123');

    // same action like removeData
    expect(browserStorageService.setData(key)).toBeUndefined();
    expect(browserStorageService.getData(key)).toBeUndefined();

    expect(browserStorageService.setData(key, '456')).toBeUndefined();
    expect(browserStorageService.getData(key)).toBe('456');

    // real delete method
    expect(browserStorageService.removeData(key)).toBeUndefined();
    expect(browserStorageService.getData(key)).toBeUndefined();
  });
});
