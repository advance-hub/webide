import {
  ExtensionHostControlRuntimeBinding,
  ExtensionHostControlRuntimePort,
  ExtensionNodeServiceServerPath,
} from '../../src/common';

import type { IExtensionHostControl } from '../../src/common';

type ExpectedControlMethods = 'createProcess' | 'disposeClientExtProcess' | 'pid';
type ExactControlSubset = keyof IExtensionHostControl extends ExpectedControlMethods
  ? ExpectedControlMethods extends keyof IExtensionHostControl
    ? true
    : false
  : false;

describe('ExtensionHostControlRuntimePort', () => {
  it('declares only the existing session control subset', () => {
    expect.hasAssertions();
    const hasExactControlSubset: ExactControlSubset = true;

    expect(hasExactControlSubset).toBe(true);
    expect(ExtensionHostControlRuntimePort).toEqual({
      id: 'opensumi.extensions.host-control',
      version: 1,
      scope: 'session',
    });
    expect(ExtensionHostControlRuntimeBinding).toEqual({
      port: ExtensionHostControlRuntimePort,
      servicePath: ExtensionNodeServiceServerPath,
    });
  });
});
