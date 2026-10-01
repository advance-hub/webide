import { defineRuntimePort } from '@opensumi/ide-core-common';

import { ExtensionNodeServiceServerPath } from './extension';

import type { IExtensionNodeClientService } from './extension';

/**
 * Session-owned Extension Host control requests carried by the existing
 * connection RPC facade. Lifecycle callbacks, the Main Thread data plane, and
 * the remaining legacy extension service methods are deliberately excluded.
 */
export type IExtensionHostControl = Pick<
  IExtensionNodeClientService,
  'createProcess' | 'disposeClientExtProcess' | 'pid'
>;

export const ExtensionHostControlRuntimePort = defineRuntimePort<IExtensionHostControl>({
  id: 'opensumi.extensions.host-control',
  version: 1,
  scope: 'session',
});

/** Keeps the declared control Port attached to the existing duplex RPC path. */
export const ExtensionHostControlRuntimeBinding = {
  port: ExtensionHostControlRuntimePort,
  servicePath: ExtensionNodeServiceServerPath,
} as const;
