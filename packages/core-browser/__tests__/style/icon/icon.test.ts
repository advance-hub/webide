import { getIcon as componentIcon, updateIconMap as componentUpdate } from '@opensumi/ide-components';
import * as IconNames from '@opensumi/ide-core-common/icon-names';

import * as BrowserIcons from '../../../src/style/icon/icon';

const { getExternalIcon } = BrowserIcons;

describe('packages/core-browser/src/style/icon/icon.ts', () => {
  it('should get correct icon class', () => {
    expect.hasAssertions();
    expect(getExternalIcon('sync')).toBe('codicon codicon-sync');
    expect(getExternalIcon('smiley-outline')).toBe('octicon octicon-smiley-outline');
    expect(getExternalIcon('smiley-outline', 'codicon', false)).toBe('codicon codicon-smiley-outline');
    expect(getExternalIcon('sync', 'octicon')).toBe('octicon octicon-sync');
    expect(BrowserIcons.getSymbolIcon(0)).toBe('codicon codicon-symbol-file');
  });

  it('keeps formatting functions and the custom icon registry shared across old entrypoints', () => {
    expect.hasAssertions();
    for (const name of Object.keys(IconNames)) {
      expect(BrowserIcons[name]).toBe(IconNames[name]);
    }
    expect(BrowserIcons.getIcon).toBe(componentIcon);
    expect(BrowserIcons.updateIconMap).toBe(componentUpdate);
    BrowserIcons.updateIconMap('contract-icon ', { 'shared-icon-contract': 'test' });
    expect(componentIcon('shared-icon-contract')).toBe('contract-icon test');
  });
});
