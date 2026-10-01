import { MockInjector } from '@opensumi/ide-dev-tool/injector';
import { IExtension } from '@opensumi/ide-extension';

import { AbstractExtInstanceManagementService } from '../../src/browser/types';
import { WalkthroughsService } from '../../src/browser/walkthroughs.service';

import { MOCK_EXTENSIONS, setupExtensionServiceInjector } from './extension-service/extension-service-mock-helper';

describe('walkthroughs api test', () => {
  let injector: MockInjector;
  let walkthroughsService: WalkthroughsService;
  let mockExtension: IExtension;
  let extInstanceManagementService: AbstractExtInstanceManagementService;

  beforeAll(() => {
    injector = setupExtensionServiceInjector();
    injector.addProviders({
      token: WalkthroughsService,
      useValue: WalkthroughsService,
    });

    walkthroughsService = injector.get(WalkthroughsService);
    extInstanceManagementService = injector.get(AbstractExtInstanceManagementService);
    mockExtension = MOCK_EXTENSIONS[0];
    // @ts-ignore
    extInstanceManagementService.getExtensionInstanceByExtId = () => mockExtension;
  });

  it('registerExtensionWalkthroughContributions should be worked', async () => {
    expect(walkthroughsService.registerExtensionWalkthroughContributions).toBeDefined();

    await walkthroughsService.registerExtensionWalkthroughContributions(
      mockExtension.id,
      mockExtension.contributes.walkthroughs![0],
    );

    expect(walkthroughsService.getWalkthroughs().length).toBe(1);
  });
});
