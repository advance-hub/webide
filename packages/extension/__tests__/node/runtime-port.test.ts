import {
  ExtensionHostControlRuntimeBinding,
  ExtensionHostControlRuntimePort,
  IExtensionNodeClientService,
} from '../../src/common';
import { ExtensionModule } from '../../src/node';

describe('Extension Host Control Node runtime port adapter', () => {
  it('keeps the connection facade provider on the declared session control path', () => {
    expect.hasAssertions();
    const nodeBinding = new ExtensionModule().backServices.find(
      ({ servicePath }) => servicePath === ExtensionHostControlRuntimeBinding.servicePath,
    );

    expect(ExtensionHostControlRuntimeBinding.port).toBe(ExtensionHostControlRuntimePort);
    expect(nodeBinding).toEqual({
      servicePath: ExtensionHostControlRuntimeBinding.servicePath,
      token: IExtensionNodeClientService,
    });
  });
});
