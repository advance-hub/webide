import { BasicEvent } from './event-bus/basic-event';

import type { FileChange, FileWatcherFailureParams, FileWatcherOverflowParams } from './types/file-watch';

export class FilesChangeEvent extends BasicEvent<FileChange[]> {}
export class FileWatcherOverflowEvent extends BasicEvent<FileWatcherOverflowParams> {}
export class FileWatcherFailureEvent extends BasicEvent<FileWatcherFailureParams> {}
