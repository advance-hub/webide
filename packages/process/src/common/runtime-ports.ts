import { defineRuntimePort } from '@opensumi/ide-core-common';

import type { IProcessFactory } from './index';

/**
 * Application-owned Node process factory contract. This describes the existing
 * in-process DI path; it is not a cross-runtime RPC service.
 */
export const ProcessFactoryRuntimePort = defineRuntimePort<IProcessFactory>({
  id: 'opensumi.process.factory',
  version: 1,
  scope: 'application',
});
