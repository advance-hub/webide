import type { FileSystemProvider, IDisposable } from '@opensumi/ide-core-common';

export {
  FilesChangeEvent,
  FileWatcherOverflowEvent,
  FileWatcherFailureEvent,
} from '@opensumi/ide-core-common/file-events';

export interface FsProviderContribution {
  registerProvider?(registry: {
    registerProvider(scheme: string, provider: FileSystemProvider): IDisposable;
  }): void | Promise<void>;
  onFileServiceReady?(): void | Promise<void>;
}

export const FsProviderContribution = Symbol('FsProviderContribution');
