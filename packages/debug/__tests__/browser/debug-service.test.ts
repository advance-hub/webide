import { IDebugService } from '@opensumi/ide-debug';
import { createBrowserInjector } from '@opensumi/ide-dev-tool/browser';
import { MockInjector } from '@opensumi/ide-dev-tool/injector';

import { DebugService } from '../../src/browser/debug-service';

describe('DebugService', () => {
  let debugService: IDebugService;
  let injector: MockInjector;

  beforeAll(() => {
    injector = createBrowserInjector(
      [],
      new MockInjector([
        {
          token: IDebugService,
          useClass: DebugService,
        },
      ]),
    );
    debugService = injector.get(IDebugService);
  });

  afterAll(async () => {
    await injector.disposeAll();
  });

  it('registerDebugContributionPoints should emit change', (done) => {
    debugService.onDidDebugContributionPointChange(() => {
      done();
    });

    debugService.registerDebugContributionPoints('file://extensions/a', [
      {
        title: 'node',
      },
    ]);
  });

  it('unregisterDebugContributionPoints should remove registration', () => {
    expect(debugService.debugContributionPoints.size).toBe(1);

    debugService.unregisterDebugContributionPoints('file://extensions/a');

    expect(debugService.debugContributionPoints.size).toBe(0);
  });
});
