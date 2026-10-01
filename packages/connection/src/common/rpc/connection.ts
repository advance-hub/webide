import { getDebugLogger } from '@opensumi/ide-core-common';
import {
  CancellationToken,
  CancellationTokenSource,
  DisposableStore,
  IDisposable,
  canceled,
} from '@opensumi/ide-utils';
import { SumiReadableStream, isReadableStream, listenReadable } from '@opensumi/ide-utils/stream';

import { Capturer } from '../capturer';
import { BaseConnection, NetSocketConnection, WSWebSocketConnection } from '../connection';
import { METHOD_NOT_REGISTERED } from '../constants';
import { ILogger } from '../types';

import { MethodTimeoutError } from './errors';
import { IMessageIO, MessageIO, OperationType, RPCErrorMessage, RPCResponseMessage } from './message-io';
import {
  IResponseHeaders,
  TGenericNotificationHandler,
  TGenericRequestHandler,
  TNotificationNotFoundHandler,
  TRequestCallback,
  TRequestNotFoundHandler,
} from './types';

import type net from 'net';
import type { WebSocket } from 'ws';

const nullHeaders = {};

export interface ISumiConnectionOptions {
  timeout?: number;
  logger?: ILogger;
  /**
   * The name of the connection, used for debugging(and can see in opensumi-devtools).
   */
  name?: string;

  io?: IMessageIO;

  /** Queue new outbound work across a transient channel reconnect. */
  reconnectable?: boolean;
}

const chunkedResponseHeaders: IResponseHeaders = {
  chunked: true,
};

interface IInboundOperationState {
  requestId: number;
  acceptsOutput: boolean;
  tokenSource?: CancellationTokenSource;
  terminate?: () => void;
}

export class SumiConnection implements IDisposable {
  protected disposable = new DisposableStore();

  private _requestHandlers = new Map<string, TGenericRequestHandler<any>>();
  private _starRequestHandler: TRequestNotFoundHandler | undefined;
  private _notificationHandlers = new Map<string, TGenericNotificationHandler>();
  private _starNotificationHandler: TNotificationNotFoundHandler | undefined;

  private _requestId = 0;
  private _minimumLiveOutboundRequestId = 0;
  private _callbacks = new Map<number, TRequestCallback>();

  private readonly _reqTimeoutHandles = new Map<number, NodeJS.Timeout | number>();
  private readonly _cancellationTokenSources = new Map<
    number,
    { operation: object; tokenSource: CancellationTokenSource }
  >();
  private readonly _knownCanceledRequests = new Set<number>();

  private _acceptsInboundOperations = true;
  private _inboundDrainRequested = false;
  private _connectionClosed = false;
  private _terminallyClosed = false;
  private _disposed = false;
  private _connectionClosedError?: Error;
  private _socketCloseSubscription?: IDisposable;
  private readonly _activeInboundOperations = new Map<object, IInboundOperationState>();
  private readonly _inboundIdleWaiters = new Set<() => void>();

  protected activeRequestPool = new Map<number, SumiReadableStream<any>>();

  public io: IMessageIO;
  protected logger: ILogger;

  protected capturer: Capturer;

  constructor(
    protected socket: BaseConnection<Uint8Array>,
    protected options: ISumiConnectionOptions = {},
  ) {
    if (options.logger) {
      this.logger = options.logger;
    } else {
      this.logger = getDebugLogger();
    }

    this.io = options.io || new MessageIO();

    this.capturer = new Capturer(options.name || 'sumi');
    this.disposable.add(this.capturer);
  }

  sendNotification(method: string, ...args: any[]) {
    if (this._terminallyClosed || (this._connectionClosed && !this.options.reconnectable)) {
      return;
    }
    const requestId = this._requestId++;

    this.capturer.captureSendNotification(requestId, method, args);
    this.socket.send(this.io.Notification(requestId, method, nullHeaders, args));
  }

  sendRequest(method: string, ...args: any[]) {
    if (this._terminallyClosed || (this._connectionClosed && !this.options.reconnectable)) {
      return Promise.reject(this.getConnectionClosedError());
    }
    return new Promise<any>((resolve, reject) => {
      const requestId = this._requestId++;

      this._callbacks.set(requestId, (headers, error, result) => {
        if (error) {
          this.traceRequestError(requestId, method, args, error);

          if (error === METHOD_NOT_REGISTERED) {
            // we should not treat `METHOD_NOT_REGISTERED` as an error.
            // it is a special case, it means the method is not registered on the other side.
            resolve(error);
            return;
          }

          reject(error);
          return;
        }

        this.capturer.captureSendRequestResult(requestId, method, result);

        resolve(result);
      });

      // Set timeout callback, -1 means no timeout configuration is set.
      if (this.options.timeout && this.options.timeout !== -1) {
        const timeoutHandle = setTimeout(() => {
          this._handleTimeout(method, requestId);
        }, this.options.timeout);
        this._reqTimeoutHandles.set(requestId, timeoutHandle);
      }

      const cancellationToken: CancellationToken | undefined =
        args.length && CancellationToken.isCancellationToken(args[args.length - 1]) ? args.pop() : undefined;
      if (cancellationToken && cancellationToken.isCancellationRequested) {
        this._callbacks.delete(requestId);
        const timeoutHandle = this._reqTimeoutHandles.get(requestId);
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
          this._reqTimeoutHandles.delete(requestId);
        }
        reject(canceled());
        return;
      }

      if (cancellationToken) {
        cancellationToken.onCancellationRequested(() => this.cancelRequest(requestId));
      }

      this.capturer.captureSendRequest(requestId, method, args);

      try {
        this.socket.send(
          this.io.Request(
            requestId,
            method,
            {
              cancelable: Boolean(cancellationToken) || undefined,
            },
            args,
          ),
        );
      } catch (error) {
        this._callbacks.delete(requestId);
        const timeoutHandle = this._reqTimeoutHandles.get(requestId);
        if (timeoutHandle !== undefined) {
          clearTimeout(timeoutHandle);
          this._reqTimeoutHandles.delete(requestId);
        }
        reject(error);
      }
    });
  }

  cancelRequest(requestId: number) {
    if (this._terminallyClosed || (this._connectionClosed && !this.options.reconnectable)) {
      return;
    }
    if (!this._callbacks.has(requestId) && !this.activeRequestPool.has(requestId)) {
      return;
    }
    this.socket.send(this.io.Cancel(requestId));
  }

  private _handleTimeout(method: string, requestId: number) {
    if (!this._callbacks.has(requestId) || !this._reqTimeoutHandles.has(requestId)) {
      return;
    }

    const callback = this._callbacks.get(requestId)!;
    this._callbacks.delete(requestId);
    this._reqTimeoutHandles.delete(requestId);
    callback(nullHeaders, new MethodTimeoutError(method));
  }

  onRequest<T = any>(method: string, handler: TGenericRequestHandler<T>): IDisposable {
    this._requestHandlers.set(method, handler);
    return {
      dispose: () => {
        this._requestHandlers.delete(method);
      },
    };
  }

  onRequestNotFound(handler: TRequestNotFoundHandler): IDisposable {
    this._starRequestHandler = handler;
    return {
      dispose: () => {
        this._starRequestHandler = undefined;
      },
    };
  }

  onNotification(method: string, handler: TGenericNotificationHandler): IDisposable {
    this._notificationHandlers.set(method, handler);
    return {
      dispose: () => {
        this._notificationHandlers.delete(method);
      },
    };
  }

  onNotificationNotFound(handler: TNotificationNotFoundHandler): IDisposable {
    this._starNotificationHandler = handler;
    return {
      dispose: () => {
        this._starNotificationHandler = undefined;
      },
    };
  }

  /**
   * Stop admitting new inbound requests and notifications. Operations that
   * were already admitted keep their existing completion and cancellation
   * semantics and can be awaited with {@link whenInboundIdle}.
   */
  beginInboundDrain(): void {
    this._inboundDrainRequested = true;
    this._acceptsInboundOperations = false;
  }

  /** Restore a transiently closed connection after its channel has reopened. */
  resumeAfterReconnect(): void {
    if (!this.options.reconnectable || this._disposed || this._inboundDrainRequested || !this._connectionClosed) {
      return;
    }
    this._connectionClosed = false;
    this._terminallyClosed = false;
    this._connectionClosedError = undefined;
    this._acceptsInboundOperations = true;
    this.listenForSocketClose();
  }

  /** Wait until every inbound operation admitted before draining has settled. */
  whenInboundIdle(): Promise<void> {
    if (this._activeInboundOperations.size === 0) {
      return Promise.resolve();
    }

    return new Promise<void>((resolve) => this._inboundIdleWaiters.add(resolve));
  }

  /**
   * Retire operations from a physical connection epoch that has already closed.
   *
   * Natural disconnect cleanup uses this after its bounded grace period. Only
   * operations whose output was fenced by {@link handleConnectionClosed} are
   * retired, so work admitted by a later reconnect epoch is never affected.
   * Late promise or stream settlement remains harmless because every completion
   * path first checks that its operation is still active.
   */
  retireDisconnectedInboundOperations(): void {
    for (const [operation, operationState] of Array.from(this._activeInboundOperations)) {
      if (!operationState.acceptsOutput) {
        this.completeInboundOperation(operation);
      }
    }
  }

  listen() {
    this.listenForSocketClose();
    this.disposable.add(
      this.socket.onMessage((data) => {
        const message = this.io.parse(data);

        const opType = message.kind;
        const requestId = message.requestId;

        switch (opType) {
          case OperationType.Error:
          case OperationType.Response: {
            // A response belongs to the physical connection epoch on which its
            // request was sent. While a reconnectable channel is closed there
            // is no live epoch, and responses retired by an earlier close must
            // not create orphaned streams or settle work in the next epoch.
            if (this._connectionClosed || requestId < this._minimumLiveOutboundRequestId) {
              break;
            }

            if (opType === OperationType.Error) {
              this.logger.warn(
                `[${message.requestId}] Error received from server method ${message.method}: ${message.error}`,
              );
            }

            const { headers, method } = message;
            const err = (message as RPCErrorMessage).error;
            const result = (message as RPCResponseMessage).result;

            if (this._reqTimeoutHandles.has(requestId)) {
              clearTimeout(this._reqTimeoutHandles.get(requestId));
              this._reqTimeoutHandles.delete(requestId);
            }

            const runCallback = (headers: IResponseHeaders, error?: any, result?: any) => {
              const callback = this._callbacks.get(requestId);
              if (!callback) {
                this.logger.error(`Cannot find callback for request ${requestId}: ${method}`);
                return;
              }

              this._callbacks.delete(requestId);

              callback(headers, error, result);
            };

            if (headers && headers.chunked) {
              let activeReq: SumiReadableStream<any>;
              if (this.activeRequestPool.has(requestId)) {
                activeReq = this.activeRequestPool.get(requestId)!;
              } else {
                // new stream request
                activeReq = new SumiReadableStream();
                this.activeRequestPool.set(requestId, activeReq);
                // resolve `activeReq` to caller
                runCallback(headers, undefined, activeReq);
              }

              if (result === null) {
                // when result is null, it means the stream is ended.
                activeReq.end();
                this.activeRequestPool.delete(requestId);
                break;
              }

              if (err) {
                activeReq.emitError(err);
                this.activeRequestPool.delete(requestId);
                break;
              }

              activeReq.emitData(result);
              break;
            }

            runCallback(headers, err, result);
            break;
          }
          case OperationType.Notification:
          // fall through
          case OperationType.Request: {
            const { method, headers, args } = message;

            const inboundOperation = this.beginInboundOperation(requestId);
            if (!inboundOperation) {
              if (opType === OperationType.Request && !this._connectionClosed) {
                this.trySendInboundMessage(
                  () => this.io.Error(requestId, method, nullHeaders, new Error('RPC connection is draining')),
                  requestId,
                  method,
                );
              }
              break;
            }

            if (headers.cancelable) {
              const tokenSource = new CancellationTokenSource();
              const operationState = this._activeInboundOperations.get(inboundOperation)!;
              operationState.tokenSource = tokenSource;
              this._cancellationTokenSources.set(requestId, { operation: inboundOperation, tokenSource });
              args.push(tokenSource.token);

              if (this._knownCanceledRequests.has(requestId)) {
                tokenSource.cancel();
                this._knownCanceledRequests.delete(requestId);
              }
            }

            switch (opType) {
              case OperationType.Request: {
                let promise: Promise<any>;

                try {
                  this.capturer.captureOnRequest(requestId, method, args);
                  let result: any;

                  const handler = this._requestHandlers.get(method);
                  if (handler) {
                    result = handler(...args);
                  } else if (this._starRequestHandler) {
                    result = this._starRequestHandler(method, args);
                  }

                  promise = Promise.resolve(result);
                } catch (err) {
                  promise = Promise.reject(err);
                }

                const completeRequest = () => this.completeInboundOperation(inboundOperation);
                const onError = (err: any) => {
                  if (!this.isInboundOperationActive(inboundOperation)) {
                    return;
                  }

                  if (this.canSendInboundOperation(inboundOperation)) {
                    try {
                      this.traceRequestError(requestId, method, args, err);
                    } catch (traceError) {
                      this.safeWarn(`Could not capture inbound RPC error ${requestId} for ${method}`, traceError);
                    }

                    this.trySendInboundMessage(
                      () => this.io.Error(requestId, method, nullHeaders, err),
                      requestId,
                      method,
                      inboundOperation,
                    );
                  }

                  completeRequest();
                };

                const onSuccess = (result: any) => {
                  if (!this.isInboundOperationActive(inboundOperation)) {
                    // A request may produce its stream only after the closed
                    // epoch's disconnect lease expired. It no longer owns an
                    // accounting entry, but the newly materialized resource
                    // still has to be terminated explicitly.
                    if (isReadableStream(result)) {
                      this.terminateInboundReadableStream(result, requestId, method);
                    }
                    return;
                  }

                  try {
                    this.capturer.captureOnRequestResult(requestId, method, result);
                  } catch (error) {
                    onError(error);
                    return;
                  }

                  if (isReadableStream(result)) {
                    let streamSettled = false;
                    const settleStream = (error?: unknown) => {
                      if (streamSettled) {
                        return;
                      }
                      streamSettled = true;
                      if (error) {
                        this.trySendInboundMessage(
                          () => this.io.Error(requestId, method, chunkedResponseHeaders, error),
                          requestId,
                          method,
                          inboundOperation,
                        );
                      } else {
                        this.trySendInboundMessage(
                          () => this.io.Response(requestId, method, chunkedResponseHeaders, null),
                          requestId,
                          method,
                          inboundOperation,
                        );
                      }
                      completeRequest();
                    };

                    try {
                      listenReadable(result, {
                        onData: (data) => {
                          this.trySendInboundMessage(
                            () => this.io.Response(requestId, method, chunkedResponseHeaders, data),
                            requestId,
                            method,
                            inboundOperation,
                          );
                        },
                        onEnd: () => settleStream(),
                        onError: (err) => settleStream(err),
                      });
                      result.on('close', () => {
                        const streamState = result as { readableEnded?: boolean };
                        settleStream(
                          streamState.readableEnded ? undefined : new Error('RPC readable stream closed before ending'),
                        );
                      });

                      this.setInboundCloseHandler(inboundOperation, () => {
                        const connectionClosedError = this.getConnectionClosedError();
                        this.terminateInboundReadableStream(result, requestId, method, connectionClosedError);
                      });

                      const streamState = result as { destroyed?: boolean; readableEnded?: boolean };
                      if (streamState.readableEnded) {
                        settleStream();
                      } else if (streamState.destroyed) {
                        settleStream(new Error('RPC readable stream closed before ending'));
                      }
                    } catch (error) {
                      onError(error);
                    }
                  } else {
                    if (!this.canSendInboundOperation(inboundOperation)) {
                      completeRequest();
                      return;
                    }

                    const sendError = this.trySendInboundMessage(
                      () => this.io.Response(requestId, method, nullHeaders, result),
                      requestId,
                      method,
                      inboundOperation,
                    );
                    if (sendError && this._acceptsInboundOperations) {
                      onError(sendError);
                    } else {
                      completeRequest();
                    }
                  }
                };

                void promise.then(onSuccess, onError);
                break;
              }
              case OperationType.Notification: {
                const handler = this._notificationHandlers.get(method);

                let result: void | Promise<void>;
                try {
                  this.capturer.captureOnNotification(requestId, method, args);
                  if (handler) {
                    result = handler(...args);
                  } else if (this._starNotificationHandler) {
                    result = this._starNotificationHandler(method, args);
                  } else {
                    result = undefined;
                  }
                } catch (error) {
                  this.completeInboundOperation(inboundOperation);
                  throw error;
                }

                Promise.resolve(result).then(
                  () => this.completeInboundOperation(inboundOperation),
                  (error) => {
                    this.safeWarn(`Inbound RPC notification ${requestId} for ${method} failed`, error);
                    this.completeInboundOperation(inboundOperation);
                  },
                );
                break;
              }
            }

            break;
          }
          case OperationType.Cancel: {
            const cancellation = this._cancellationTokenSources.get(requestId);
            if (cancellation) {
              cancellation.tokenSource.cancel();
            } else if (this._acceptsInboundOperations) {
              this._knownCanceledRequests.add(requestId);
            }
            break;
          }
          default: {
            break;
          }
        }
      }),
    );
  }

  dispose(): void {
    if (this._disposed) {
      return;
    }
    this._disposed = true;
    this.beginInboundDrain();
    this.handleConnectionClosed(this._connectionClosed);
    this._socketCloseSubscription?.dispose();
    this._socketCloseSubscription = undefined;
    this.disposable.dispose();
  }

  static forWSWebSocket(socket: WebSocket, options: ISumiConnectionOptions = {}) {
    return new SumiConnection(new WSWebSocketConnection(socket), options);
  }

  static forNetSocket(socket: net.Socket, options: ISumiConnectionOptions = {}) {
    return new SumiConnection(new NetSocketConnection(socket), options);
  }

  private traceRequestError(requestId: number, method: string, args: any[], error: any) {
    this.capturer.captureSendRequestFail(requestId, method, error);
  }

  private beginInboundOperation(requestId: number): object | undefined {
    if (!this._acceptsInboundOperations) {
      return undefined;
    }

    const operation = {};
    this._activeInboundOperations.set(operation, {
      acceptsOutput: true,
      requestId,
    });
    return operation;
  }

  private completeInboundOperation(operation: object): void {
    const operationState = this._activeInboundOperations.get(operation);
    if (!operationState) {
      return;
    }

    this._activeInboundOperations.delete(operation);
    const cancellation = this._cancellationTokenSources.get(operationState.requestId);
    if (cancellation?.operation === operation) {
      this._cancellationTokenSources.delete(operationState.requestId);
    }
    operationState.tokenSource?.dispose();

    if (this._activeInboundOperations.size > 0) {
      return;
    }

    this.resolveInboundIdleWaiters();
  }

  private resolveInboundIdleWaiters(): void {
    const waiters = Array.from(this._inboundIdleWaiters);
    this._inboundIdleWaiters.clear();
    for (const resolve of waiters) {
      resolve();
    }
  }

  private isInboundOperationActive(operation: object): boolean {
    return this._activeInboundOperations.has(operation);
  }

  private canSendInboundOperation(operation: object): boolean {
    return this._activeInboundOperations.get(operation)?.acceptsOutput === true && !this._connectionClosed;
  }

  private handleConnectionClosed(force = false): void {
    if (this._connectionClosed && !force) {
      return;
    }
    this._connectionClosed = true;
    this._acceptsInboundOperations = false;
    this._minimumLiveOutboundRequestId = this._requestId;
    const transientClose = this.options.reconnectable && !force && !this._disposed && !this._inboundDrainRequested;
    this._terminallyClosed = !transientClose;

    const connectionClosedError = this.getConnectionClosedError();

    // Snapshot and clear the old outbound epoch before invoking user code.
    // Rejection/error handlers are allowed to enqueue fresh work while a
    // reconnectable channel is closed, and that new work belongs to the next
    // epoch rather than this cleanup pass.
    const callbacks = Array.from(this._callbacks.entries());
    this._callbacks.clear();
    for (const timeoutHandle of this._reqTimeoutHandles.values()) {
      clearTimeout(timeoutHandle);
    }
    this._reqTimeoutHandles.clear();

    const outboundStreams = Array.from(this.activeRequestPool.entries());
    this.activeRequestPool.clear();

    const inboundTokenSources: CancellationTokenSource[] = [];
    const inboundTerminators: Array<() => void> = [];
    for (const [operation, operationState] of this._activeInboundOperations) {
      if (!operationState.acceptsOutput) {
        continue;
      }

      operationState.acceptsOutput = false;
      if (operationState.tokenSource) {
        inboundTokenSources.push(operationState.tokenSource);
        const cancellation = this._cancellationTokenSources.get(operationState.requestId);
        if (cancellation?.operation === operation) {
          this._cancellationTokenSources.delete(operationState.requestId);
        }
        operationState.tokenSource = undefined;
      }
      if (operationState.terminate) {
        inboundTerminators.push(operationState.terminate);
        operationState.terminate = undefined;
      }
    }
    this._knownCanceledRequests.clear();

    for (const tokenSource of inboundTokenSources) {
      try {
        tokenSource.dispose(true);
      } catch (error) {
        this.safeWarn('Could not cancel an inbound RPC request after the connection closed', error);
      }
    }

    for (const terminate of inboundTerminators) {
      try {
        terminate();
      } catch (error) {
        this.safeWarn('Could not terminate an inbound RPC stream after the connection closed', error);
      }
    }

    for (const [requestId, callback] of callbacks) {
      try {
        callback(nullHeaders, connectionClosedError);
      } catch (error) {
        this.safeWarn(`Could not reject outbound RPC request ${requestId} after the connection closed`, error);
      }
    }

    for (const [requestId, stream] of outboundStreams) {
      try {
        stream.emitError(connectionClosedError);
      } catch (error) {
        this.safeWarn(`Could not terminate outbound RPC stream ${requestId} after the connection closed`, error);
      }
    }
  }

  private listenForSocketClose(): void {
    if (this._disposed) {
      return;
    }
    this._socketCloseSubscription?.dispose();
    this._socketCloseSubscription = undefined;
    let didClose = false;
    const subscriptionRef: { current?: IDisposable } = {};
    const subscription = this.socket.onceClose(() => {
      didClose = true;
      subscriptionRef.current?.dispose();
      if (this._socketCloseSubscription === subscriptionRef.current) {
        this._socketCloseSubscription = undefined;
      }
      this.handleConnectionClosed();
    });
    subscriptionRef.current = subscription;
    if (didClose) {
      subscription.dispose();
    } else {
      this._socketCloseSubscription = subscription;
    }
  }

  private getConnectionClosedError(): Error {
    if (!this._connectionClosedError) {
      this._connectionClosedError = new Error('RPC connection closed');
      this._connectionClosedError.name = 'ConnectionClosedError';
    }
    return this._connectionClosedError;
  }

  private setInboundCloseHandler(operation: object, terminate: () => void): void {
    const operationState = this._activeInboundOperations.get(operation);
    if (!operationState) {
      return;
    }
    operationState.terminate = terminate;
    if (!operationState.acceptsOutput) {
      terminate();
    }
  }

  private terminateInboundReadableStream(stream: unknown, requestId: number, method: string, error?: Error): void {
    try {
      const closeableStream = stream as {
        abort?: () => void;
        destroy?: (error?: Error) => void;
      };
      if (typeof closeableStream.abort === 'function') {
        closeableStream.abort();
      } else if (typeof closeableStream.destroy === 'function') {
        closeableStream.destroy(error);
      }
    } catch (streamError) {
      this.safeWarn(`Could not close inbound RPC stream ${requestId} for ${method}`, streamError);
    }
  }

  private trySendInboundMessage(
    createMessage: () => Uint8Array,
    requestId: number,
    method: string,
    operation?: object,
  ): unknown | undefined {
    if ((operation && !this.canSendInboundOperation(operation)) || this._connectionClosed) {
      return this.getConnectionClosedError();
    }

    try {
      this.socket.send(createMessage());
      return undefined;
    } catch (error) {
      this.safeWarn(`Could not send inbound RPC response ${requestId} for ${method}`, error);
      return error;
    }
  }

  private safeWarn(message: string, error: unknown): void {
    try {
      this.logger.warn(message, error);
    } catch {
      // Logging must not keep an inbound operation active during teardown.
    }
  }

  toJSON() {
    throw new Error(
      "You're trying to serialize a SumiConnection instance, which is not allowed.\nPlease check your code, and remove the rpc proxy reference.",
    );
  }
}
