import os from 'os';
import paths from 'path';
import { Readable } from 'stream';

import * as fse from 'fs-extra';
import trash from 'trash';
import writeFileAtomic from 'write-file-atomic';

import { Autowired, Injectable, Optional } from '@opensumi/di';
import { RPCService } from '@opensumi/ide-connection';
import {
  DisposableCollection,
  Emitter,
  Event,
  FileUri,
  IConnectionScopeRetirement,
  IDisposable,
  IFileStatOptions,
  ILogService,
  ILogServiceManager,
  IReadFileStreamOptions,
  SupportLogNamespace,
  URI,
  Uri,
  UriComponents,
  isLinux,
  isUndefined,
  uuid,
} from '@opensumi/ide-core-node';

import {
  DidFilesChangedParams,
  FileAccess,
  FileChangeEvent,
  FileMoveOptions,
  FileStat,
  FileSystemError,
  FileSystemProviderCapabilities,
  FileType,
  FileWatcherFailureParams,
  FileWatcherOverflowParams,
  IDiskFileProvider,
  IWatcherProcessManager,
  RecursiveWatcherBackend,
  handleError,
  isErrnoException,
  notEmpty,
} from '../common/';

import { getFileType } from './hosted/shared/file-type';
import { WatcherProcessManagerToken } from './watcher-process-manager';

const UNSUPPORTED_NODE_MODULES_EXCLUDE = '**/node_modules/*/**';
const DEFAULT_NODE_MODULES_EXCLUDE = '**/node_modules/**';

export interface IRPCDiskFileSystemProvider {
  onDidFilesChanged(event: DidFilesChangedParams): void;
  onWatcherOverflow(event: FileWatcherOverflowParams): void;
  onWatcherFailed(event: FileWatcherFailureParams): void;
}

export interface IWatcher {
  id: number;
  options?: {
    excludes?: string[];
    recursive?: boolean;
  };
  disposable: IDisposable;
}

export type DirectoryEntry = [string, FileType];

@Injectable({ multiple: true })
export class DiskFileSystemProvider extends RPCService<IRPCDiskFileSystemProvider> implements IDiskFileProvider {
  private fileChangeEmitter = new Emitter<FileChangeEvent>();
  readonly onDidChangeFile: Event<FileChangeEvent> = this.fileChangeEmitter.event;

  private watcherOverflowEmitter = new Emitter<FileWatcherOverflowParams>();
  readonly onDidWatcherOverflow: Event<FileWatcherOverflowParams> = this.watcherOverflowEmitter.event;

  private watcherFailedEmitter = new Emitter<FileWatcherFailureParams>();
  readonly onDidWatcherFailed: Event<FileWatcherFailureParams> = this.watcherFailedEmitter.event;

  protected watcherServerDisposeCollection: DisposableCollection;

  protected watchFileExcludes: string[] = [];

  @Autowired(ILogServiceManager)
  private readonly loggerManager: ILogServiceManager;

  @Autowired(WatcherProcessManagerToken)
  private readonly watcherProcessManager: IWatcherProcessManager;

  private logger: ILogService;

  private ignoreNextChangesEvent: Set<string> = new Set();
  private pendingFileWrites = new Map<string, Promise<void>>();
  private readonly pendingMutations = new Set<Promise<unknown>>();
  private readonly pendingWatcherInitializations = new Set<Promise<void>>();
  private readonly pendingWatcherRegistrations = new Set<Promise<void>>();
  private readonly pendingWatcherDisposals = new Set<Promise<void>>();
  private disposing = false;
  private disposePromise?: Promise<void>;
  private connectionScopeRetirement?: IConnectionScopeRetirement;

  private recursive: boolean;

  constructor(@Optional() recursive = true) {
    super();
    this.logger = this.loggerManager.getLogger(SupportLogNamespace.Node);
    this.recursive = recursive;

    this.watcherProcessManager.setClient({
      onDidFilesChanged: (events: DidFilesChangedParams) => {
        if (this.connectionScopeRetirement?.retired) {
          return;
        }
        if (events.changes.length > 0) {
          const changes = events.changes.filter((c) => !this.ignoreNextChangesEvent.has(c.uri));
          this.fileChangeEmitter.fire(changes);
          if (Array.isArray(this.rpcClient)) {
            this.rpcClient.forEach((client) => {
              client.onDidFilesChanged({
                changes,
              });
            });
          }
        }
      },
      onWatcherOverflow: (event: FileWatcherOverflowParams) => {
        if (this.connectionScopeRetirement?.retired) {
          return;
        }
        this.watcherOverflowEmitter.fire(event);
        if (Array.isArray(this.rpcClient)) {
          this.rpcClient.forEach((client) => client.onWatcherOverflow?.(event));
        }
      },
      onWatcherFailed: (event: FileWatcherFailureParams) => {
        if (this.connectionScopeRetirement?.retired) {
          return;
        }
        this.watcherFailedEmitter.fire(event);
        if (Array.isArray(this.rpcClient)) {
          this.rpcClient.forEach((client) => client.onWatcherFailed?.(event));
        }
      },
    });
  }

  setConnectionScopeRetirement(retirement: IConnectionScopeRetirement): void {
    this.connectionScopeRetirement = retirement;
  }

  async initialize(clientId: string, backend?: RecursiveWatcherBackend): Promise<void> {
    if (this.disposing || this.connectionScopeRetirement?.retired) {
      throw new Error('DiskFileSystemProvider is disposing and cannot initialize the watcher process');
    }

    const initialization = this.watcherProcessManager.createProcess(clientId, backend);
    const initializationSettlement = initialization.then(
      () => undefined,
      () => undefined,
    );
    this.pendingWatcherInitializations.add(initializationSettlement);
    void initializationSettlement.then(() => this.pendingWatcherInitializations.delete(initializationSettlement));

    await initialization;
    if (this.disposing) {
      throw new Error('DiskFileSystemProvider was disposed while initializing the watcher process');
    }
  }

  get whenReady() {
    return this.watcherProcessManager.whenReady;
  }

  onDidChangeCapabilities: Event<void> = Event.None;

  protected _capabilities: FileSystemProviderCapabilities | undefined;
  get capabilities(): FileSystemProviderCapabilities {
    if (!this._capabilities) {
      this._capabilities =
        FileSystemProviderCapabilities.FileReadWrite |
        FileSystemProviderCapabilities.FileOpenReadWriteClose |
        FileSystemProviderCapabilities.FileReadStream |
        FileSystemProviderCapabilities.FileFolderCopy |
        FileSystemProviderCapabilities.FileWriteUnlock;

      if (isLinux) {
        this._capabilities |= FileSystemProviderCapabilities.PathCaseSensitive;
      }
    }

    return this._capabilities;
  }

  dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposing = true;
      this.disposePromise = this.doDispose();
    }
    return this.disposePromise;
  }

  private async doDispose(): Promise<void> {
    const mutations = Array.from(this.pendingMutations);
    const watcherDisposals = Array.from(this.pendingWatcherDisposals);
    const admittedWork = Promise.all([
      Promise.allSettled(mutations),
      Promise.allSettled(Array.from(this.pendingWatcherInitializations)),
      Promise.allSettled(Array.from(this.pendingWatcherRegistrations)),
    ]);
    const admittedSettlement = await this.waitWhileConnectionScopeOwned(admittedWork);
    if (admittedSettlement.owned) {
      this.reportMutationFailures(admittedSettlement.value[0]);
    } else {
      void admittedWork.then(([mutationResults]) => this.reportMutationFailures(mutationResults));
    }

    const cleanupWork = Promise.allSettled([
      ...watcherDisposals,
      Promise.resolve().then(() => this.watcherServerDisposeCollection?.dispose() as unknown as void | Promise<void>),
      Promise.resolve().then(() => this.watcherProcessManager.dispose()),
    ]);
    const cleanupSettlement = await this.waitWhileConnectionScopeOwned(cleanupWork);
    if (!cleanupSettlement.owned) {
      void cleanupWork.then((results) => this.reportRetiredCleanupFailures(results));
      return;
    }

    const errors = cleanupSettlement.value
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => result.reason);
    if (errors.length === 1) {
      throw errors[0];
    }
    if (errors.length > 1) {
      throw new AggregateError(errors, 'Disk file-system provider disposal failed');
    }
  }

  private async waitWhileConnectionScopeOwned<T>(
    work: Promise<T>,
  ): Promise<{ owned: true; value: T } | { owned: false }> {
    const retirement = this.connectionScopeRetirement;
    if (!retirement) {
      return { owned: true, value: await work };
    }
    return Promise.race([
      work.then((value) => ({ owned: true as const, value })),
      retirement.whenRetired.then(() => ({ owned: false as const })),
    ]);
  }

  private reportMutationFailures(results: PromiseSettledResult<unknown>[]): void {
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.warn('An admitted disk provider mutation failed while the provider was draining.', result.reason);
      }
    }
  }

  private reportRetiredCleanupFailures(results: PromiseSettledResult<unknown>[]): void {
    for (const result of results) {
      if (result.status === 'rejected') {
        this.logger.warn(
          'Retired disk provider cleanup failed after its connection scope was released.',
          result.reason,
        );
      }
    }
  }

  /**
   * @param {Uri} uri
   * @param {{ excludes: string[] }}
   * @memberof DiskFileSystemProvider
   */
  async watch(
    uri: UriComponents,
    options?: { excludes?: string[]; recursive?: boolean; pollingWatch?: boolean },
  ): Promise<number> {
    if (this.disposing || this.connectionScopeRetirement?.retired) {
      throw new Error('DiskFileSystemProvider is disposing and cannot accept new watchers');
    }

    const registration = this.registerWatcher(uri, options);
    const registrationSettlement = registration.then(
      () => undefined,
      () => undefined,
    );
    this.pendingWatcherRegistrations.add(registrationSettlement);
    void registrationSettlement.then(() => this.pendingWatcherRegistrations.delete(registrationSettlement));

    return registration;
  }

  private async registerWatcher(
    uri: UriComponents,
    options?: { excludes?: string[]; recursive?: boolean; pollingWatch?: boolean },
  ): Promise<number> {
    await this.whenReady;
    if (this.disposing) {
      throw new Error('DiskFileSystemProvider was disposed while registering a watcher');
    }

    const _uri = Uri.revive(uri);

    const id = await this.watcherProcessManager.watch(_uri, {
      excludes: options?.excludes ?? [],
      recursive: options?.recursive ?? this.recursive,
      pollingWatch: options?.pollingWatch,
    });

    if (this.disposing) {
      await this.watcherProcessManager.unWatch(id);
      throw new Error('DiskFileSystemProvider was disposed while registering a watcher');
    }

    return id;
  }

  unwatch(watcherId: number): void {
    // Preserve the concrete synchronous return type used by external subclasses.
    // FileService and connection-scope owners call unwatchAsync() when they need
    // to await the underlying watcher process cleanup.
    void this.unwatchAsync(watcherId).catch((error) => {
      this.logger.error('Disk watcher asynchronous disposal failed', error);
    });
  }

  /** @internal Awaitable owner hook; external compatibility remains unwatch(): void. */
  unwatchAsync(watcherId: number): Promise<void> {
    if (this.disposePromise) {
      // Global provider disposal owns every remaining watcher once it starts.
      return this.disposePromise;
    }

    const disposal = Promise.resolve(this.watcherProcessManager.unWatch(watcherId));
    this.pendingWatcherDisposals.add(disposal);
    disposal.then(
      () => this.pendingWatcherDisposals.delete(disposal),
      () => this.pendingWatcherDisposals.delete(disposal),
    );
    return disposal;
  }

  async stat(uri: UriComponents, options?: IFileStatOptions): Promise<FileStat> {
    const _uri = Uri.revive(uri);
    try {
      const stat = await this.doGetStat(_uri, 1, options);
      if (stat) {
        return stat;
      }
      throw FileSystemError.FileNotFound(uri.path);
    } catch (e) {
      if (!FileSystemError.FileNotFound.is(e)) {
        this.logger.error(e);
      }
      throw e;
    }
  }

  async readDirectory(uri: UriComponents): Promise<DirectoryEntry[]> {
    const _uri = Uri.revive(uri);
    const result: DirectoryEntry[] = [];
    try {
      const dirList = await fse.readdir(_uri.fsPath, { withFileTypes: true });
      dirList.forEach((entry) => {
        let type: FileType;
        if (entry.isDirectory()) {
          type = FileType.Directory;
        } else if (entry.isFile()) {
          type = FileType.File;
        } else if (entry.isSymbolicLink()) {
          // Preserve the historical statSync behavior: directory listings
          // report a symbolic link as the type of its target.
          const filePath = paths.join(_uri.fsPath, entry.name);
          // eslint-disable-next-line import-x/namespace
          type = this.getFileStatType(fse.statSync(filePath));
        } else {
          type = FileType.Unknown;
        }
        result.push([entry.name, type]);
      });
    } catch {
      // Keep the historical contract: callers receive the entries collected
      // before the first filesystem failure, or an empty directory result.
    }
    return result;
  }

  createDirectory(uri: UriComponents): Promise<FileStat> {
    return this.queueMutation(() => this.doCreateDirectory(uri));
  }

  private async doCreateDirectory(uri: UriComponents): Promise<FileStat> {
    const _uri = Uri.revive(uri);
    const stat = await this.doGetStat(_uri, 0);
    if (stat) {
      if (stat.isDirectory) {
        return stat;
      }
      throw FileSystemError.FileExists(uri.path, 'Error occurred while creating the directory: path is a file.');
    }
    await fse.ensureDir(FileUri.fsPath(new URI(_uri)));
    const newStat = await this.doGetStat(_uri, 1);
    if (newStat) {
      return newStat;
    }
    throw FileSystemError.Unavailable(uri.path, 'Error occurred while creating the directory.');
  }

  async readFile(uri: UriComponents, encoding = 'utf8'): Promise<Uint8Array> {
    const _uri = Uri.revive(uri);
    try {
      const buffer = await fse.readFile(FileUri.fsPath(new URI(_uri)));
      return buffer;
    } catch (error) {
      this.handleReadFileError(error, uri);
    }
  }

  async readFileStream(uri: UriComponents, opts: IReadFileStreamOptions): Promise<Readable> {
    const _uri = Uri.revive(uri);
    try {
      return fse.createReadStream(FileUri.fsPath(new URI(_uri)));
    } catch (error) {
      this.handleReadFileError(error, uri);
    }
  }

  protected handleReadFileError(error: Error, uri: UriComponents): never {
    if (isErrnoException(error)) {
      if (error.code === 'ENOENT') {
        throw FileSystemError.FileNotFound(uri.path, 'Error occurred while reading file');
      }

      if (error.code === 'EISDIR') {
        throw FileSystemError.FileIsADirectory(uri.path, 'Error occurred while reading file: path is a directory.');
      }

      if (error.code === 'EPERM') {
        throw FileSystemError.FileIsNoPermissions(uri.path, 'Error occurred while reading file: path is a directory.');
      }
    }

    throw error;
  }

  async writeFile(
    uri: UriComponents,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean; encoding?: string },
  ): Promise<void | FileStat> {
    return this.queueFileWrite(uri, () => this.doWriteFile(uri, content, options));
  }

  async writeFileWithStat(
    file: FileStat,
    content: Uint8Array,
    options?: { encoding?: string; expectedContent?: Uint8Array },
  ): Promise<FileStat> {
    const uri = URI.parse(file.uri).codeUri;
    return this.queueFileWrite(uri, async () => {
      const stat = await this.doGetStat(uri, 0);
      if (!stat) {
        throw FileSystemError.FileNotFound(file.uri, 'File not found.');
      }
      if (stat.isDirectory) {
        throw FileSystemError.FileIsADirectory(file.uri, 'Cannot set the content.');
      }
      const contentChanged =
        options?.expectedContent !== undefined &&
        !Buffer.from(await this.readFile(uri)).equals(Buffer.from(Uint8Array.from(options.expectedContent)));
      const statChanged = stat.lastModification !== file.lastModification || stat.size !== file.size;
      if (contentChanged || (options?.expectedContent === undefined && statChanged)) {
        throw FileSystemError.FileIsOutOfSync(file.uri);
      }

      await this.doWriteFile(uri, content, { create: false, overwrite: true, encoding: options?.encoding });
      const newStat = await this.doGetStat(uri, 0);
      if (!newStat) {
        throw FileSystemError.FileNotFound(file.uri, 'File not found.');
      }
      return newStat;
    });
  }

  private queueFileWrite<T>(uri: UriComponents, task: () => Promise<T>): Promise<T> {
    if (this.disposing || this.connectionScopeRetirement?.retired) {
      return Promise.reject(new Error('DiskFileSystemProvider is disposing and cannot accept new file mutations'));
    }

    const key = Uri.revive(uri).toString();
    const previous = this.pendingFileWrites.get(key) || Promise.resolve();
    const current = previous.then(() => {
      this.assertConnectionScopeOwnsMutation();
      return task();
    });
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.pendingFileWrites.set(key, settled);
    void settled.then(() => {
      if (this.pendingFileWrites.get(key) === settled) {
        this.pendingFileWrites.delete(key);
      }
    });
    return this.trackMutation(current);
  }

  private queueMutation<T>(task: () => Promise<T>): Promise<T> {
    if (this.disposing || this.connectionScopeRetirement?.retired) {
      return Promise.reject(new Error('DiskFileSystemProvider is disposing and cannot accept new file mutations'));
    }
    const mutation = Promise.resolve().then(() => {
      this.assertConnectionScopeOwnsMutation();
      return task();
    });
    return this.trackMutation(mutation);
  }

  private trackMutation<T>(mutation: Promise<T>): Promise<T> {
    const fencedMutation = mutation.then((value) => {
      this.assertConnectionScopeOwnsMutation();
      return value;
    });
    this.pendingMutations.add(fencedMutation);
    fencedMutation.then(
      () => this.pendingMutations.delete(fencedMutation),
      () => this.pendingMutations.delete(fencedMutation),
    );
    return fencedMutation;
  }

  private assertConnectionScopeOwnsMutation(): void {
    if (this.connectionScopeRetirement?.retired) {
      throw new Error('DiskFileSystemProvider connection scope retired before the file mutation completed');
    }
  }

  private async doWriteFile(
    uri: UriComponents,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean; encoding?: string },
  ): Promise<void | FileStat> {
    const _uri = Uri.revive(uri);
    const exists = await this.access(uri);

    if (exists && !options.overwrite) {
      throw FileSystemError.FileExists(_uri.toString());
    } else if (!exists && !options.create) {
      throw FileSystemError.FileNotFound(_uri.toString());
    }
    // fileServiceNode调用不会转换，前传通信会转换
    const buffer = content instanceof Buffer ? content : Buffer.from(Uint8Array.from(content));
    if (options.create) {
      return await this.createFile(uri, { content: buffer });
    }

    try {
      this.ignoreNextChangesEvent.add(_uri.toString());
      await writeFileAtomic(FileUri.fsPath(new URI(_uri)), buffer);
    } catch (e) {
      await fse.writeFile(FileUri.fsPath(new URI(_uri)), buffer);
      this.logger.warn('Error using writeFileAtomicSync, using fs instead.', e);
    } finally {
      this.ignoreNextChangesEvent.delete(_uri.toString());
    }
  }

  async access(uri: UriComponents, mode: number = FileAccess.Constants.F_OK): Promise<boolean> {
    try {
      await fse.access(FileUri.fsPath(URI.from(uri)), mode);
      return true;
    } catch {
      return false;
    }
  }

  delete(uri: UriComponents, options: { recursive?: boolean; moveToTrash?: boolean }): Promise<void> {
    return this.queueMutation(() => this.doDelete(uri, options));
  }

  private async doDelete(uri: UriComponents, options: { recursive?: boolean; moveToTrash?: boolean }): Promise<void> {
    const _uri = Uri.revive(uri);
    const stat = await this.doGetStat(_uri, 0);
    if (!stat) {
      throw FileSystemError.FileNotFound(uri.path);
    }
    if (!isUndefined(options.recursive)) {
      this.logger.warn('DiskFileSystemProvider not support options.recursive!');
    }

    if (options.moveToTrash) {
      return trash([FileUri.fsPath(new URI(_uri))]);
    } else {
      const filePath = FileUri.fsPath(new URI(_uri));
      const outputRootPath = paths.join(os.tmpdir(), uuid());
      try {
        await fse.rename(filePath, outputRootPath);
      } catch {
        await fse.remove(filePath);
        return;
      }
      await fse.remove(FileUri.fsPath(outputRootPath));
    }
  }

  rename(sourceUri: UriComponents, targetUri: UriComponents, options: { overwrite: boolean }): Promise<FileStat> {
    return this.queueMutation(() => this.doMove(sourceUri, targetUri, options));
  }

  copy(sourceUri: UriComponents, targetUri: UriComponents, options: { overwrite: boolean }): Promise<FileStat> {
    return this.queueMutation(() => this.doCopy(sourceUri, targetUri, options));
  }

  private async doCopy(
    sourceUri: UriComponents,
    targetUri: UriComponents,
    options: { overwrite: boolean },
  ): Promise<FileStat> {
    const _sourceUri = Uri.revive(sourceUri);
    const _targetUri = Uri.revive(targetUri);
    const [sourceStat, targetStat] = await Promise.all([this.doGetStat(_sourceUri, 0), this.doGetStat(_targetUri, 0)]);
    const { overwrite } = options;

    if (!sourceStat) {
      throw FileSystemError.FileNotFound(sourceUri.path);
    }

    if (targetStat) {
      if (!overwrite) {
        throw FileSystemError.FileExists(targetUri.path, "Did you set the 'overwrite' flag to true?");
      }

      await this.validateMoveCopy(_sourceUri, _targetUri);
    }

    await fse.copy(FileUri.fsPath(_sourceUri.toString()), FileUri.fsPath(_targetUri.toString()), {
      overwrite,
    });
    const newStat = await this.doGetStat(_targetUri, 1);
    if (newStat) {
      return newStat;
    }
    throw FileSystemError.FileNotFound(targetUri.path, `Error occurred while copying ${sourceUri} to ${targetUri}.`);
  }

  private async validateMoveCopy(sourceUri: Uri, targetUri: Uri) {
    if (sourceUri.toString() === targetUri.toString()) {
      throw FileSystemError.FileExists(targetUri.path, 'Cannot perform copy, source and destination are the same.');
    }

    if (await this.access(targetUri)) {
      // Special case: if the target is a parent of the source, we cannot delete
      // it as it would delete the source as well. In this case we have to throw
      if (FileUri.isEqualOrParent(targetUri, sourceUri)) {
        throw FileSystemError.FileExists(targetUri.path, 'Cannot perform copy, source is a parent of the destination.');
      }
    }
  }

  async getCurrentUserHome(): Promise<FileStat | undefined> {
    return this.stat(FileUri.create(os.homedir()).codeUri);
  }

  // 出于通信成本的考虑，排除文件的逻辑必须放在node层（fs provider层，不同的fs实现的exclude应该不一样）
  setWatchFileExcludes(excludes: string[]): Promise<void> {
    return this.queueMutation(async () => {
      const watchExcludes = excludes.map((exclude) =>
        exclude === UNSUPPORTED_NODE_MODULES_EXCLUDE ? DEFAULT_NODE_MODULES_EXCLUDE : exclude,
      );
      // 每次调用之后都需要重新初始化 WatcherServer，保证最新的规则生效
      this.logger.log('Set watcher exclude:', watchExcludes);
      await this.watcherProcessManager.setWatcherFileExcludes(watchExcludes);
      this.assertConnectionScopeOwnsMutation();
      this.watchFileExcludes = watchExcludes;
    });
  }

  getWatchFileExcludes() {
    return this.watchFileExcludes;
  }

  getWatchExcludes(excludes?: string[]): string[] {
    return Array.from(new Set(this.watchFileExcludes.concat(excludes || [])));
  }

  protected async createFile(uri: UriComponents, options: { content: Buffer }): Promise<FileStat> {
    const _uri = Uri.revive(uri);
    const parentUri = new URI(_uri).parent;
    const parentStat = await this.doGetStat(parentUri.codeUri, 0);
    if (!parentStat) {
      await fse.ensureDir(FileUri.fsPath(parentUri));
    }
    await fse.writeFile(FileUri.fsPath(_uri.toString()), options.content);
    const newStat = await this.doGetStat(_uri, 1);
    if (newStat) {
      return newStat;
    }
    throw FileSystemError.FileNotFound(uri.path, 'Error occurred while creating the file.');
  }

  /**
   * Return `true` if it's possible for this URI to have children.
   * It might not be possible to be certain because of permission problems or other filesystem errors.
   */
  protected async mayHaveChildren(uri: Uri): Promise<boolean> {
    /* If there's a problem reading the root directory. Assume it's not empty to avoid overwriting anything.  */
    try {
      const rootStat = await this.doGetStat(uri, 0);
      if (rootStat === undefined) {
        return true;
      }
      /* Not a directory.  */
      if (rootStat !== undefined && rootStat.isDirectory === false) {
        return false;
      }
    } catch (error) {
      return true;
    }

    /* If there's a problem with it's children then the directory must not be empty.  */
    try {
      const stat = await this.doGetStat(uri, 1);
      if (stat !== undefined && stat.children !== undefined) {
        return stat.children.length > 0;
      } else {
        return true;
      }
    } catch (error) {
      return true;
    }
  }

  protected async doMove(
    sourceUri: UriComponents,
    targetUri: UriComponents,
    options: FileMoveOptions,
  ): Promise<FileStat> {
    const _sourceUri = Uri.revive(sourceUri);
    const _targetUri = Uri.revive(targetUri);
    const [sourceStat, targetStat] = await Promise.all([this.doGetStat(_sourceUri, 1), this.doGetStat(_targetUri, 1)]);
    const isCapitalizedEqual = _sourceUri.toString().toLocaleUpperCase() === _targetUri.toString().toLocaleUpperCase();
    const { overwrite } = options;
    if (!sourceStat) {
      throw FileSystemError.FileNotFound(sourceUri.path);
    }
    if (targetStat && !overwrite) {
      throw FileSystemError.FileExists(targetUri.path, "Did you set the 'overwrite' flag to true?");
    }

    // Different types. Files <-> Directory.
    if (targetStat && sourceStat.isDirectory !== targetStat.isDirectory) {
      if (targetStat.isDirectory) {
        throw FileSystemError.FileIsADirectory(
          targetStat.uri,
          `Cannot move '${sourceStat.uri}' file to an existing location.`,
        );
      }
      throw FileSystemError.FileNotADirectory(
        targetStat.uri,
        `Cannot move '${sourceStat.uri}' directory to an existing location.`,
      );
    }
    const [sourceMightHaveChildren, targetMightHaveChildren] = await Promise.all([
      this.mayHaveChildren(_sourceUri),
      this.mayHaveChildren(_targetUri),
    ]);
    // Handling special Windows case when source and target resources are empty folders.
    // Source should be deleted and target should be touched.
    if (
      !isCapitalizedEqual &&
      overwrite &&
      targetStat &&
      targetStat.isDirectory &&
      sourceStat.isDirectory &&
      !sourceMightHaveChildren &&
      !targetMightHaveChildren
    ) {
      // 当移动路径跟目标路径均存在文件，同时排除大写路径不等时才进入该逻辑
      // 核心解决在 Mac 等默认大小写不敏感系统中的文件移动问题
      // The value should be a Unix timestamp in seconds.
      // For example, `Date.now()` returns milliseconds, so it should be divided by `1000` before passing it in.
      const now = Date.now() / 1000;
      await fse.utimes(FileUri.fsPath(_targetUri.toString()), now, now);
      await fse.rmdir(FileUri.fsPath(_sourceUri.toString()));
      const newStat = await this.doGetStat(_targetUri, 1);
      if (newStat) {
        return newStat;
      }
      throw FileSystemError.FileNotFound(
        targetUri.path,
        `Error occurred when moving resource from '${sourceUri.toString()}' to '${targetUri.toString()}'.`,
      );
    } else if (
      overwrite &&
      targetStat &&
      targetStat.isDirectory &&
      sourceStat.isDirectory &&
      !targetMightHaveChildren &&
      sourceMightHaveChildren
    ) {
      // Copy source to target, since target is empty. Then wipe the source content.
      const newStat = await this.doCopy(sourceUri, targetUri, { overwrite });
      await this.doDelete(sourceUri, { moveToTrash: false });
      return newStat;
    } else {
      await this.validateMoveCopy(_sourceUri, _targetUri);

      await fse.move(FileUri.fsPath(_sourceUri.toString()), FileUri.fsPath(_targetUri.toString()), { overwrite });
      const stat = await this.doGetStat(_targetUri, 1, {
        throwError: true,
      });

      if (stat) {
        return stat;
      } else {
        // never reached
        throw FileSystemError.FileNotFound(
          targetUri.path,
          `Error occurred when moving resource from '${sourceUri.toString()}' to '${targetUri.toString()}'.`,
        );
      }
    }
  }

  protected async doGetStat(uri: Uri, depth: number, options?: IFileStatOptions): Promise<FileStat | undefined> {
    try {
      const filePath = uri.fsPath;
      const lstat = await fse.lstat(filePath);

      if (lstat.isSymbolicLink()) {
        let realPath: string;
        try {
          realPath = await fse.realpath(FileUri.fsPath(new URI(uri)));
        } catch (e) {
          this.logger.warn('Cannot resolve symbolic link', uri.toString(), e);
          return undefined;
        }
        const stat = await fse.stat(filePath);
        const realURI = FileUri.create(realPath);
        const realStat = await fse.lstat(realPath);

        let realStatData: FileStat;
        if (stat.isDirectory()) {
          realStatData = await this.doCreateDirectoryStat(realURI.codeUri, realStat, depth);
        } else {
          realStatData = await this.doCreateFileStat(realURI.codeUri, realStat);
        }

        return {
          ...realStatData,
          realUri: realStatData.uri,
          type: FileType.SymbolicLink,
          isSymbolicLink: true,
          uri: uri.toString(),
        };
      } else {
        if (lstat.isDirectory()) {
          return await this.doCreateDirectoryStat(uri, lstat, depth);
        }
        const fileStat = await this.doCreateFileStat(uri, lstat);

        return fileStat;
      }
    } catch (error) {
      // A stat probe is also the implementation of exists/getFileStat. Missing
      // optional files (for example .sumi/settings.json) are normal control
      // flow and must not flood production error logs.
      if (isErrnoException(error) && error.code === 'ENOENT') {
        if (options?.throwError) {
          handleError(error);
        }
        return undefined;
      }

      this.logger.error('Error occurred when getting file stat', uri, error);
      if (options?.throwError) {
        handleError(error);
      }

      if (isErrnoException(error)) {
        if (error.code === 'ENOENT' || error.code === 'EACCES' || error.code === 'EBUSY' || error.code === 'EPERM') {
          return undefined;
        }
      }
      throw error;
    }
  }

  protected async doCreateFileStat(uri: Uri, stat: fse.Stats): Promise<FileStat> {
    return {
      uri: uri.toString(),
      lastModification: stat.mtime.getTime(),
      createTime: stat.ctime.getTime(),
      isSymbolicLink: stat.isSymbolicLink(),
      isDirectory: stat.isDirectory(),
      size: stat.size,
      type: this.getFileStatType(stat),
    };
  }

  protected getFileStatType(stat: fse.Stats) {
    if (stat.isDirectory()) {
      return FileType.Directory;
    }
    if (stat.isFile()) {
      return FileType.File;
    }
    if (stat.isSymbolicLink()) {
      return FileType.SymbolicLink;
    }
    return FileType.Unknown;
  }

  protected async doCreateDirectoryStat(uri: Uri, stat: fse.Stats, depth: number): Promise<FileStat> {
    const children = depth > 0 ? await this.doGetChildren(uri, depth) : [];
    return {
      uri: uri.toString(),
      lastModification: stat.mtime.getTime(),
      createTime: stat.ctime.getTime(),
      isDirectory: true,
      isSymbolicLink: stat.isSymbolicLink(),
      children,
      type: FileType.Directory,
    };
  }

  protected async doGetChildren(uri: Uri, depth: number): Promise<FileStat[]> {
    const _uri = new URI(uri);
    const files = await fse.readdir(FileUri.fsPath(_uri));
    const children = await Promise.all(
      files.map((fileName) => _uri.resolve(fileName)).map((childUri) => this.doGetStat(childUri.codeUri, depth - 1)),
    );
    return children.filter(notEmpty);
  }

  async getFileType(uri: string): Promise<string | undefined> {
    return await getFileType(uri);
  }
}
