import { createNodeInjector } from '@opensumi/ide-dev-tool/injector';
import { MockInjector } from '@opensumi/ide-dev-tool/injector';

import { AddonsModule } from '../../src/node';

describe('test for', () => {
  let injector: MockInjector;

  beforeEach(() => {
    injector = createNodeInjector([AddonsModule]);
  });

  it('empty module', () => {
    const ins = injector.get(AddonsModule);
    expect(ins.providers.length).toBe(2);
  });
});
