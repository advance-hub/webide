import type { FileSystemProvider } from '@opensumi/ide-core-common';

export const IUserStorageService = Symbol('IUserStorageService');

export type IUserStorageService = FileSystemProvider;
