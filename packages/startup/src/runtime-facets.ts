import { ExtensionHostControlRuntimeBinding } from '@opensumi/ide-extension';
import { DiskFileServiceRuntimeBinding } from '@opensumi/ide-file-service';
import { ProcessFactoryRuntimePort } from '@opensumi/ide-process';

import { RuntimeFacetOptions } from './legacy-runtime-plan';
import {
  ExtensionFeature,
  FileSearchFeature,
  FileServiceFeature,
  ProcessFeature,
  SearchFeature,
} from './product-profile';

export const CommonBrowserFacetOptions: Readonly<Record<string, RuntimeFacetOptions>> = {
  [FileServiceFeature.id]: {
    consumes: [DiskFileServiceRuntimeBinding.port],
  },
  [ExtensionFeature.id]: {
    consumes: [ExtensionHostControlRuntimeBinding.port],
  },
};

export const CommonBrowserBoundaryRequirements = [
  {
    providerRuntime: 'node',
    port: DiskFileServiceRuntimeBinding.port,
  },
  {
    providerRuntime: 'node',
    port: ExtensionHostControlRuntimeBinding.port,
  },
] as const;

export const CommonNodeFacetOptions: Readonly<Record<string, RuntimeFacetOptions>> = {
  [FileServiceFeature.id]: {
    provides: [DiskFileServiceRuntimeBinding.port],
  },
  [ProcessFeature.id]: {
    provides: [ProcessFactoryRuntimePort],
  },
  [ExtensionFeature.id]: {
    provides: [ExtensionHostControlRuntimeBinding.port],
  },
  [FileSearchFeature.id]: {
    consumes: [ProcessFactoryRuntimePort],
  },
  [SearchFeature.id]: {
    consumes: [ProcessFactoryRuntimePort],
  },
};
