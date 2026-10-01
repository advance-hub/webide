import { ICommonServer } from '@opensumi/ide-core-common';
import { ServerCommonModule } from '@opensumi/ide-core-node';
import { createNodeInjector } from '@opensumi/ide-dev-tool/injector';
import { MockInjector } from '@opensumi/ide-dev-tool/injector';

import { CommonServer } from '../../src/common-module/common.server';

describe('NodeLogger', () => {
  let server: CommonServer;
  let injector: MockInjector;

  beforeAll(() => {
    injector = createNodeInjector([ServerCommonModule]);
    server = injector.get(ICommonServer);
  });

  afterAll(async () => {
    await injector.disposeAll();
  });

  test('getBackendOS', async () => {
    expect(typeof (await server.getBackendOS())).toBe('number');
  });
});
