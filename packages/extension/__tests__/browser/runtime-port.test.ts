import { ExtensionModule } from '../../src/browser';
import {
  ExtensionHostControlRuntimeBinding,
  ExtensionHostControlRuntimePort,
  ExtensionService,
} from '../../src/common';

describe('Extension Host Control Browser runtime port adapter', () => {
  it('keeps the duplex Browser RPC callback adapter on the declared control path', () => {
    expect.hasAssertions();
    const browserBinding = new ExtensionModule().backServices.find(
      ({ servicePath }) => servicePath === ExtensionHostControlRuntimeBinding.servicePath,
    );

    expect(ExtensionHostControlRuntimeBinding.port).toBe(ExtensionHostControlRuntimePort);
    expect(browserBinding).toEqual({
      servicePath: ExtensionHostControlRuntimeBinding.servicePath,
      clientToken: ExtensionService,
    });
  });
});
