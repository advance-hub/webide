import { VALIDATE_TYPE as ComponentValidation } from '@opensumi/ide-components';
import {
  FileWatcherFailureEvent,
  FileWatcherOverflowEvent,
  FilesChangeEvent,
} from '@opensumi/ide-core-common/file-events';
import * as QuickInput from '@opensumi/ide-core-common/quick-open';
import { RecentStorage } from '@opensumi/ide-core-common/recent-files';
import { VALIDATE_TYPE } from '@opensumi/ide-core-common/validation';
import * as PublicQuickInput from '@opensumi/ide-quick-open';

import { RecentStorage as LegacyRecentStorage } from '../src/common/common.storage';
import * as BrowserEvents from '../src/fs';
import * as BrowserQuickInput from '../src/quick-open';

describe('shared quick input contracts', () => {
  it('keeps the old and new entrypoints bound to the same services and items', () => {
    expect.hasAssertions();
    for (const name of Object.keys(QuickInput)) {
      expect(BrowserQuickInput[name]).toBe(QuickInput[name]);
      expect(PublicQuickInput[name]).toBe(QuickInput[name]);
    }
    expect(LegacyRecentStorage).toBe(RecentStorage);
  });

  it('preserves widget validation and file event identities for existing consumers', () => {
    expect.hasAssertions();
    expect(ComponentValidation).toBe(VALIDATE_TYPE);
    expect(BrowserEvents.FilesChangeEvent).toBe(FilesChangeEvent);
    expect(BrowserEvents.FileWatcherOverflowEvent).toBe(FileWatcherOverflowEvent);
    expect(BrowserEvents.FileWatcherFailureEvent).toBe(FileWatcherFailureEvent);
  });
});
