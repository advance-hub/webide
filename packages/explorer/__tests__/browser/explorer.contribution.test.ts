import { createBrowserInjector } from '@opensumi/ide-dev-tool/browser';
import { MockInjector } from '@opensumi/ide-dev-tool/injector';
import { ExplorerModule } from '@opensumi/ide-explorer';

import { ExplorerContribution } from '../../src/browser/explorer-contribution';

describe('Explorer contribution should be work', () => {
  let injector: MockInjector;

  beforeEach(() => {
    injector = createBrowserInjector([ExplorerModule]);
  });

  describe('01 #Init', () => {
    it('should contribution work', async () => {
      const register = jest.fn();
      const contribution = injector.get(ExplorerContribution);
      contribution.registerComponent({ register } as any);
      expect(register).toHaveBeenCalledTimes(1);
    });
  });
});
