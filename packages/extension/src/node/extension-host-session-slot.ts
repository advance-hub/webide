import type { IExtensionNodeClientService } from '../common';
import type { ExtensionHostRuntimeHandle } from './extension-host-runtime';
import type { WSServerChannel } from '@opensumi/ide-connection';

export type ExtensionHostSessionSlotPhase = 'accepting' | 'draining' | 'drained';

export interface ExtensionHostSessionCreationToken {
  readonly revision: number;
  readonly sequence: number;
}

export interface ExtensionHostSessionMainThreadToken {
  readonly channel: WSServerChannel;
  readonly epoch: number;
  readonly disconnectEpochAtOpen: number;
}

export interface ExtensionHostSessionDisconnectToken {
  readonly epoch: number;
}

export interface ExtensionHostSessionDisconnectLease {
  readonly token: ExtensionHostSessionDisconnectToken;
  readonly timer: NodeJS.Timeout;
  readonly runtime: ExtensionHostRuntimeHandle | undefined;
}

interface CreationOperation {
  readonly token: ExtensionHostSessionCreationToken;
  readonly promise: Promise<void>;
  readonly replacingRuntime: ExtensionHostRuntimeHandle | undefined;
  publicationRevision: number;
}

interface MainThreadRegistration {
  readonly token: ExtensionHostSessionMainThreadToken;
}

interface ElectronPathOperation {
  readonly revision: number;
  readonly promise: Promise<string>;
}

function createSessionError(name: string, message: string): Error {
  const error = new Error(message);
  error.name = name;
  return error;
}

function createOperation<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return {
    promise,
    start(task: () => T | PromiseLike<T>): void {
      try {
        resolve(task());
      } catch (error) {
        reject(error);
      }
    },
  };
}

/**
 * Owns state whose lifetime is one logical Extension Host session.
 *
 * Generation resources remain on ExtensionHostRuntimeHandle. Browser facades
 * and Main Thread channels are borrowed connection-owned references: this slot
 * fences replacement and release, but never disposes their physical transport.
 */
export class ExtensionHostSessionSlot {
  private _phase: ExtensionHostSessionSlotPhase = 'accepting';
  private _revision = 0;
  private nextCreationSequence = 1;
  private nextMainThreadEpoch = 1;
  private disconnectEpoch = 0;
  private electronPathRevision = 0;

  private _currentRuntime: ExtensionHostRuntimeHandle | undefined;
  private _creation: CreationOperation | undefined;
  private readonly readinessPromises = new WeakMap<ExtensionHostRuntimeHandle, Promise<boolean>>();
  private readonly pendingReadiness = new Set<Promise<boolean>>();
  private readonly retirementPromises = new WeakMap<ExtensionHostRuntimeHandle, Promise<void>>();
  private readonly pendingRetirements = new Set<Promise<void>>();
  private _facade: IExtensionNodeClientService | undefined;
  private mainThread: MainThreadRegistration | undefined;
  private _disconnected = false;
  private _disconnectToken: ExtensionHostSessionDisconnectToken | undefined;
  private _disconnectLease: ExtensionHostSessionDisconnectLease | undefined;
  private electronPath: ElectronPathOperation | undefined;

  constructor(readonly clientId: string) {
    if (!clientId.trim()) {
      throw createSessionError('ExtensionHostSessionIdentityError', 'Extension Host session client id is invalid');
    }
  }

  get phase(): ExtensionHostSessionSlotPhase {
    return this._phase;
  }

  get revision(): number {
    return this._revision;
  }

  get currentRuntime(): ExtensionHostRuntimeHandle | undefined {
    return this._currentRuntime;
  }

  get creationPromise(): Promise<void> | undefined {
    return this._creation?.promise;
  }

  get facade(): IExtensionNodeClientService | undefined {
    return this._facade;
  }

  get mainThreadChannel(): WSServerChannel | undefined {
    return this.mainThread?.token.channel;
  }

  get mainThreadToken(): ExtensionHostSessionMainThreadToken | undefined {
    return this.mainThread?.token;
  }

  get disconnected(): boolean {
    return this._disconnected;
  }

  get disconnectLease(): ExtensionHostSessionDisconnectLease | undefined {
    return this._disconnectLease;
  }

  get hasPendingReadiness(): boolean {
    return this.pendingReadiness.size > 0;
  }

  get hasPendingRetirement(): boolean {
    return this.pendingRetirements.size > 0;
  }

  isCurrentRuntime(runtime: ExtensionHostRuntimeHandle | undefined): runtime is ExtensionHostRuntimeHandle {
    return Boolean(runtime && this._currentRuntime === runtime);
  }

  runCreation(task: (token: ExtensionHostSessionCreationToken) => Promise<void> | void): Promise<void> {
    if (this._phase !== 'accepting') {
      return Promise.reject(
        createSessionError(
          'ExtensionHostSessionDrainingError',
          `Extension Host session ${this.clientId} is ${this._phase}`,
        ),
      );
    }
    if (this._creation) {
      return this._creation.promise;
    }

    const token = Object.freeze({
      revision: this._revision,
      sequence: this.nextCreationSequence++,
    });
    const deferred = createOperation<void>();
    const { promise } = deferred;
    const operation: CreationOperation = {
      token,
      promise,
      replacingRuntime: this._currentRuntime,
      publicationRevision: this._revision,
    };
    this._creation = operation;
    void promise.then(
      () => this.clearCreation(operation),
      () => this.clearCreation(operation),
    );
    deferred.start(() => task(token));
    return promise;
  }

  publishRuntime(token: ExtensionHostSessionCreationToken, runtime: ExtensionHostRuntimeHandle): boolean {
    if (
      this._phase !== 'accepting' ||
      this._creation?.token !== token ||
      this._creation.publicationRevision !== this._revision ||
      runtime.clientId !== this.clientId ||
      this._currentRuntime
    ) {
      return false;
    }
    this._currentRuntime = runtime;
    return true;
  }

  clearRuntime(runtime: ExtensionHostRuntimeHandle): boolean {
    if (this._currentRuntime !== runtime) {
      return false;
    }
    const admittedReplacement =
      this._creation?.replacingRuntime === runtime && this._creation.publicationRevision === this._revision;
    this._currentRuntime = undefined;
    this.invalidateRuntimePublication();
    // An admitted replacement may retire the generation it observed on entry.
    // Retiring a runtime published by that same creation still invalidates it.
    if (admittedReplacement) {
      this._creation!.publicationRevision = this._revision;
    }
    this.resetElectronMainThreadListenPath();
    return true;
  }

  invalidateRuntimePublication(): void {
    this._revision += 1;
  }

  runReadiness(
    runtime: ExtensionHostRuntimeHandle,
    task: (runtime: ExtensionHostRuntimeHandle) => Promise<boolean> | boolean,
  ): Promise<boolean> {
    if (runtime.clientId !== this.clientId) {
      return Promise.reject(this.createForeignRuntimeError(runtime));
    }
    const existing = this.readinessPromises.get(runtime);
    if (existing) {
      return existing;
    }
    if (this._phase !== 'accepting') {
      return Promise.reject(
        createSessionError(
          'ExtensionHostSessionDrainingError',
          `Extension Host session ${this.clientId} is ${this._phase}`,
        ),
      );
    }
    const deferred = createOperation<boolean>();
    const { promise } = deferred;
    this.readinessPromises.set(runtime, promise);
    this.pendingReadiness.add(promise);
    void promise.then(
      () => this.pendingReadiness.delete(promise),
      () => this.pendingReadiness.delete(promise),
    );
    deferred.start(() => task(runtime));
    return promise;
  }

  runRetirement(
    runtime: ExtensionHostRuntimeHandle,
    task: (runtime: ExtensionHostRuntimeHandle) => Promise<void> | void,
  ): Promise<void> {
    if (runtime.clientId !== this.clientId) {
      return Promise.reject(this.createForeignRuntimeError(runtime));
    }
    const existing = this.retirementPromises.get(runtime);
    if (existing) {
      return existing;
    }
    const deferred = createOperation<void>();
    const { promise } = deferred;
    this.retirementPromises.set(runtime, promise);
    this.pendingRetirements.add(promise);
    void promise.then(
      () => this.pendingRetirements.delete(promise),
      () => this.pendingRetirements.delete(promise),
    );
    deferred.start(() => task(runtime));
    return promise;
  }

  attachFacade(facade: IExtensionNodeClientService): boolean {
    if (this._phase !== 'accepting') {
      return false;
    }
    this._facade = facade;
    return true;
  }

  releaseFacade(facade: IExtensionNodeClientService): boolean {
    if (this._facade !== facade) {
      return false;
    }
    this._facade = undefined;
    return true;
  }

  beginMainThreadConnection(channel: WSServerChannel): ExtensionHostSessionMainThreadToken | undefined {
    if (this._phase !== 'accepting') {
      return undefined;
    }
    const token = Object.freeze({
      channel,
      epoch: this.nextMainThreadEpoch++,
      disconnectEpochAtOpen: this.disconnectEpoch,
    });
    this.mainThread = { token };
    // Opening a channel proves startup may continue, but the prior disconnect
    // timer remains armed until the channel is bridged to the current runtime.
    this._disconnected = false;
    return token;
  }

  isCurrentMainThread(
    token: ExtensionHostSessionMainThreadToken | undefined,
  ): token is ExtensionHostSessionMainThreadToken {
    return Boolean(token && this.mainThread?.token === token);
  }

  commitMainThreadConnection(token: ExtensionHostSessionMainThreadToken): boolean {
    if (
      this._phase !== 'accepting' ||
      !this.isCurrentMainThread(token) ||
      token.disconnectEpochAtOpen !== this.disconnectEpoch
    ) {
      return false;
    }
    const disconnectLease = this._disconnectLease;
    if (disconnectLease?.token.epoch === token.disconnectEpochAtOpen) {
      this.cancelDisconnectLease(disconnectLease.token);
    }
    this._disconnectToken = undefined;
    return true;
  }

  releaseMainThreadConnection(token: ExtensionHostSessionMainThreadToken): boolean {
    if (!this.isCurrentMainThread(token)) {
      return false;
    }
    this.mainThread = undefined;
    return true;
  }

  markDisconnected(): ExtensionHostSessionDisconnectToken | undefined {
    if (this._phase !== 'accepting') {
      return undefined;
    }
    this.clearDisconnectLease();
    this._disconnected = true;
    const token = Object.freeze({ epoch: ++this.disconnectEpoch });
    this._disconnectToken = token;
    return token;
  }

  isCurrentDisconnect(
    token: ExtensionHostSessionDisconnectToken | undefined,
  ): token is ExtensionHostSessionDisconnectToken {
    return Boolean(token && this._disconnected && this._disconnectToken === token);
  }

  armDisconnectLease(
    token: ExtensionHostSessionDisconnectToken,
    timer: NodeJS.Timeout,
    runtime: ExtensionHostRuntimeHandle | undefined,
  ): boolean {
    if (this._phase !== 'accepting' || !this.isCurrentDisconnect(token)) {
      clearTimeout(timer);
      return false;
    }
    this.clearDisconnectLease();
    this._disconnectLease = { token, timer, runtime };
    return true;
  }

  cancelDisconnectLease(token: ExtensionHostSessionDisconnectToken): boolean {
    if (this._disconnectLease?.token !== token) {
      return false;
    }
    this.clearDisconnectLease();
    return true;
  }

  consumeDisconnectLease(
    token: ExtensionHostSessionDisconnectToken,
    timer: NodeJS.Timeout,
  ): ExtensionHostSessionDisconnectLease | undefined {
    const lease = this._disconnectLease;
    if (!lease || lease.token !== token || lease.timer !== timer) {
      return undefined;
    }
    this._disconnectLease = undefined;
    clearTimeout(lease.timer);
    return lease;
  }

  getElectronMainThreadListenPath(factory: () => Promise<string> | string): Promise<string> {
    if (this.electronPath) {
      return this.electronPath.promise;
    }
    if (this._phase !== 'accepting') {
      return Promise.reject(
        createSessionError(
          'ExtensionHostSessionDrainingError',
          `Extension Host session ${this.clientId} is ${this._phase}`,
        ),
      );
    }

    const revision = this.electronPathRevision;
    const promise = Promise.resolve()
      .then(factory)
      .then((listenPath) => {
        if (
          this._phase !== 'accepting' ||
          this.electronPath?.promise !== promise ||
          revision !== this.electronPathRevision
        ) {
          throw createSessionError(
            'StaleExtensionHostSessionOperationError',
            `Extension Host session ${this.clientId} Electron path operation is stale`,
          );
        }
        return listenPath;
      });
    this.electronPath = { revision, promise };
    void promise.catch(() => {
      if (this.electronPath?.promise === promise) {
        this.electronPath = undefined;
      }
    });
    return promise;
  }

  resetElectronMainThreadListenPath(): void {
    this.electronPathRevision += 1;
    this.electronPath = undefined;
  }

  beginDrain(): void {
    if (this._phase !== 'accepting') {
      return;
    }
    this._phase = 'draining';
    this.invalidateRuntimePublication();
    this.resetElectronMainThreadListenPath();
    this.clearDisconnectLease();
    this._disconnected = true;
    this.disconnectEpoch += 1;
    this._disconnectToken = undefined;
  }

  async whenCreationSettled(): Promise<void> {
    await this._creation?.promise.catch(() => undefined);
  }

  async whenReadinessSettled(): Promise<void> {
    await this.waitForPendingSet(this.pendingReadiness);
  }

  async whenRetirementsSettled(): Promise<void> {
    await this.waitForPendingSet(this.pendingRetirements);
  }

  finishDrain(): boolean {
    if (
      this._phase !== 'draining' ||
      this._currentRuntime ||
      this._creation ||
      this.pendingReadiness.size > 0 ||
      this.pendingRetirements.size > 0
    ) {
      return false;
    }
    this._facade = undefined;
    this.mainThread = undefined;
    this._disconnected = false;
    this._disconnectToken = undefined;
    this.clearDisconnectLease();
    this.resetElectronMainThreadListenPath();
    this._phase = 'drained';
    return true;
  }

  isCollectible(): boolean {
    return Boolean(
      !this._currentRuntime &&
      !this._creation &&
      this.pendingReadiness.size === 0 &&
      this.pendingRetirements.size === 0 &&
      !this._facade &&
      !this.mainThread &&
      !this._disconnectLease &&
      !this.electronPath,
    );
  }

  private clearCreation(operation: CreationOperation): void {
    if (this._creation === operation) {
      this._creation = undefined;
    }
  }

  private clearDisconnectLease(): void {
    const lease = this._disconnectLease;
    this._disconnectLease = undefined;
    if (lease) {
      clearTimeout(lease.timer);
    }
  }

  private createForeignRuntimeError(runtime: ExtensionHostRuntimeHandle): Error {
    return createSessionError(
      'ExtensionHostSessionIdentityError',
      `Extension Host runtime generation ${runtime.generation} does not belong to this session`,
    );
  }

  private async waitForPendingSet<T>(pending: Set<Promise<T>>): Promise<void> {
    while (pending.size > 0) {
      await Promise.allSettled(Array.from(pending));
    }
  }
}

export type ExtensionHostSessionSlotRegistryPhase = 'accepting' | 'draining' | 'drained';

/** Root-owned registry. It performs exact slot identity CAS during pruning. */
export class ExtensionHostSessionSlotRegistry {
  private readonly slots = new Map<string, ExtensionHostSessionSlot>();
  private _phase: ExtensionHostSessionSlotRegistryPhase = 'accepting';

  get phase(): ExtensionHostSessionSlotRegistryPhase {
    return this._phase;
  }

  get size(): number {
    return this.slots.size;
  }

  get(clientId: string): ExtensionHostSessionSlot | undefined {
    return this.slots.get(clientId);
  }

  getOrCreate(clientId: string): ExtensionHostSessionSlot {
    const existing = this.slots.get(clientId);
    if (existing) {
      return existing;
    }
    if (this._phase !== 'accepting') {
      throw createSessionError(
        'ExtensionHostSessionRegistryDrainingError',
        `Extension Host session registry is ${this._phase}`,
      );
    }
    const slot = new ExtensionHostSessionSlot(clientId);
    this.slots.set(clientId, slot);
    return slot;
  }

  values(): ExtensionHostSessionSlot[] {
    return Array.from(this.slots.values());
  }

  deleteIfCollectible(slot: ExtensionHostSessionSlot): boolean {
    if (this.slots.get(slot.clientId) !== slot || !slot.isCollectible()) {
      return false;
    }
    return this.slots.delete(slot.clientId);
  }

  beginDrain(): ExtensionHostSessionSlot[] {
    if (this._phase === 'accepting') {
      this._phase = 'draining';
      for (const slot of this.slots.values()) {
        slot.beginDrain();
      }
    }
    return this.values();
  }

  finishDrain(): boolean {
    if (this._phase !== 'draining') {
      return this._phase === 'drained';
    }
    for (const slot of this.values()) {
      if (!slot.finishDrain()) {
        return false;
      }
      this.deleteIfCollectible(slot);
    }
    if (this.slots.size > 0) {
      return false;
    }
    this._phase = 'drained';
    return true;
  }
}
