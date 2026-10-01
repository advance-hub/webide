import { CommonChannelPathHandler } from '@opensumi/ide-connection/server';
import { ExpressFileServerContribution } from '@opensumi/ide-express-file-server/node/contribution';
import { ExtensionNodeServiceImpl } from '@opensumi/ide-extension/node/service';
import { DiskFileSystemProvider } from '@opensumi/ide-file-service/node/disk-provider';
import { FileService } from '@opensumi/ide-file-service/node/files';

import type { IServerApp, ServerAppContribution } from '../lib/types';
import type { IAcpThread } from '@opensumi/ide-ai-native/node/acp-thread';
import type { WSChannel } from '@opensumi/ide-connection';
import type { LoadSessionRequest, LoadSessionResponse, NewSessionResponse } from '@opensumi/ide-core-common';
import type { IExtensionNodeClientService, IExtensionNodeService } from '@opensumi/ide-extension';
import type { IFileService } from '@opensumi/ide-file-service';
import type http from 'http';
import type https from 'https';

type AssertTrue<T extends true> = T;
type IsAny<T> = 0 extends 1 & T ? true : false;
type IsExactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;

// The long-standing server host and contribution hook remain implementable
// without adopting the built-in runtime lifecycle surface.
export const legacyServerApp: IServerApp = {
  use: () => undefined,
  start: async () => undefined,
};
export const legacyServerContribution: ServerAppContribution = {
  initialize: () => undefined,
  onStart: () => undefined,
  onStop: () => undefined,
};

export type ContributionAppRemainsServerApp = AssertTrue<
  IsExactly<Parameters<NonNullable<ServerAppContribution['initialize']>>[0], IServerApp>
>;
export type ServerStartRemainsHttpOrHttps = AssertTrue<
  IsExactly<Parameters<IServerApp['start']>[0], http.Server | https.Server>
>;
export type ExpressFileServerInitializeRemainsServerApp = AssertTrue<
  IsExactly<Parameters<ExpressFileServerContribution['initialize']>[0], IServerApp>
>;

// External file-service implementations historically dispose synchronously.
type LegacySynchronousFileService = Omit<IFileService, 'dispose'> & { dispose(): void };
export type LegacySynchronousFileServiceRemainsCompatible = AssertTrue<
  LegacySynchronousFileService extends IFileService ? true : false
>;
export type FileServiceDisposeRemainsExactlyVoid = AssertTrue<IsExactly<ReturnType<IFileService['dispose']>, void>>;
export declare class LegacyFileService extends FileService {
  override dispose(): void;
}
export type ConcreteFileServiceDisposeRemainsExactlyVoid = AssertTrue<
  IsExactly<ReturnType<FileService['dispose']>, void>
>;
export declare class LegacyDiskFileSystemProvider extends DiskFileSystemProvider {
  override unwatch(watcherId: number): void;
}
export type ConcreteDiskUnwatchRemainsExactlyVoid = AssertTrue<
  IsExactly<ReturnType<DiskFileSystemProvider['unwatch']>, void>
>;

// Existing subclasses may continue to expose the concrete legacy void method.
export declare class LegacyCommonChannelPathHandler extends CommonChannelPathHandler {
  override openChannel(path: string, channel: WSChannel, clientId: string): void;
}
export type CommonChannelOpenRemainsExactlyVoid = AssertTrue<
  IsExactly<ReturnType<CommonChannelPathHandler['openChannel']>, void>
>;

// The public service interface used an inferred any return, while the concrete
// implementation used an inferred void return. Both forms remain compatible.
type LegacyExtensionNodeService = Omit<IExtensionNodeService, 'setConnectionServiceClient'> & {
  setConnectionServiceClient(clientId: string, serviceClient: IExtensionNodeClientService): number;
};
export type LegacyExtensionNodeServiceRemainsCompatible = AssertTrue<
  LegacyExtensionNodeService extends IExtensionNodeService ? true : false
>;
export type ExtensionRegistrationReturnRemainsAny = AssertTrue<
  IsAny<ReturnType<IExtensionNodeService['setConnectionServiceClient']>>
>;
export declare class LegacyExtensionNodeServiceImpl extends ExtensionNodeServiceImpl {
  override setConnectionServiceClient(clientId: string, serviceClient: IExtensionNodeClientService): void;
}
export type ConcreteExtensionRegistrationRemainsExactlyVoid = AssertTrue<
  IsExactly<ReturnType<ExtensionNodeServiceImpl['setConnectionServiceClient']>, void>
>;

// External ACP thread factories do not need the new retirement hook, and their
// public load-or-create response remains the protocol union.
type LegacyAcpThread = Omit<IAcpThread, 'loadSessionOrNew' | 'retireSession'> & {
  loadSessionOrNew(params: LoadSessionRequest): Promise<NewSessionResponse | LoadSessionResponse>;
};
export type LegacyAcpThreadRemainsCompatible = AssertTrue<LegacyAcpThread extends IAcpThread ? true : false>;
export type AcpLoadSessionOrNewRemainsProtocolUnion = AssertTrue<
  IsExactly<ReturnType<IAcpThread['loadSessionOrNew']>, Promise<NewSessionResponse | LoadSessionResponse>>
>;
