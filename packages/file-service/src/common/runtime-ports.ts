import { defineRuntimePort } from '@opensumi/ide-core-common';

import { DiskFileServicePath } from './tokens';

import type { IDiskFileProvider } from './files';

/**
 * Connection-owned disk file RPC contract exposed by the Node file-service
 * facet and consumed by the Browser file-service facet.
 */
export const DiskFileServiceRuntimePort = defineRuntimePort<IDiskFileProvider>({
  id: 'opensumi.files.disk-service',
  version: 1,
  scope: 'connection',
});

/** Keeps the capability Port and the existing RPC adapter path in one mapping. */
export const DiskFileServiceRuntimeBinding = {
  port: DiskFileServiceRuntimePort,
  servicePath: DiskFileServicePath,
} as const;
