// Browser and node implementations remain available through their explicit subpaths.
// Keep runtime exports explicit so additions to the common module do not silently widen this API.
export {
  RemoteOpenerBrowserServiceToken,
  RemoteOpenerClientToken,
  RemoteOpenerConverterContribution,
  RemoteOpenerServicePath,
  RemoteOpenerServiceToken,
} from './common';
export type {
  IExternalFileArgs,
  IExternalUrlArgs,
  IRemoteHostConverter,
  IRemoteOpenerBrowserService,
  IRemoteOpenerClient,
  IRemoteOpenerService,
} from './common';
