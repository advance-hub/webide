import {
  FeatureGraphError,
  RuntimeTopologyContractError,
  compileRuntimeTopologyContract,
  digestRuntimePlanContract,
  digestRuntimeTopologyContract,
  normalizeRuntimePlanContract,
  uuid,
} from '@opensumi/ide-core-common';

import { OpenSumiDefaultProductProfile } from './product-profile';

import type { RuntimePlanContract, RuntimePlanDigestV1, RuntimeTopologyDigestV1 } from '@opensumi/ide-core-common';

export const RUNTIME_TOPOLOGY_HANDSHAKE_CHANNEL_PATH = 'RuntimeTopologyHandshake';
export const RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL = 'opensumi.runtime-topology';
export const RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL_VERSION = 1;
export const RUNTIME_TOPOLOGY_HANDSHAKE_MAX_PAYLOAD_BYTES = 64 * 1024;
export const RUNTIME_TOPOLOGY_HANDSHAKE_DEFAULT_TIMEOUT_MS = 5_000;

export type RuntimeTopologyHandshakePolicy = 'off' | 'compatible' | 'required';
export type RuntimeTopologyHandshakeState = 'off' | 'unseen' | 'pending' | 'accepted' | 'rejected' | 'unsupported';

export interface RuntimeTopologyHandshakeStatus {
  readonly policy: RuntimeTopologyHandshakePolicy;
  readonly protocolVersion: typeof RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL_VERSION;
  readonly localRuntime: 'browser' | 'node';
  readonly profileId: string;
  readonly enabledOptions: readonly string[];
  readonly localContractDigest: RuntimePlanDigestV1;
  /** Client current state; on the multi-connection server this is the last observed attempt/admission state. */
  readonly state: RuntimeTopologyHandshakeState;
  readonly attempts: number;
  readonly verifiedAdmissions: number;
  readonly unverifiedAdmissions: number;
  readonly rejectedAdmissions: number;
  readonly lastTopologyDigest?: RuntimeTopologyDigestV1;
  readonly lastAttemptAt?: string;
  readonly lastCorrelationId?: string;
  readonly lastRejectionCode?: string;
  readonly lastRejection?: string;
}

export interface RuntimeTopologyRPCAdmission {
  readonly accepted: boolean;
  readonly reason?:
    | 'runtime topology handshake required'
    | 'runtime topology handshake pending'
    | 'runtime topology handshake rejected';
}

export interface RuntimeTopologyServerHandshakeChannel {
  readonly connection: object;
  send(content: string): void;
  onMessage(listener: (content: string) => void): { dispose(): void };
}

export interface RuntimeTopologyHandshakeChannel {
  send(content: string): void;
  onMessage(listener: (content: string) => void): { dispose(): void };
}

export interface RuntimeTopologyServerHandshake {
  readonly channelPath: typeof RUNTIME_TOPOLOGY_HANDSHAKE_CHANNEL_PATH;
  readonly policy: RuntimeTopologyHandshakePolicy;
  handleChannel(channel: RuntimeTopologyServerHandshakeChannel): void;
  admitRPC(connection: object): RuntimeTopologyRPCAdmission;
  getStatus(): RuntimeTopologyHandshakeStatus;
}

export interface RuntimeTopologyClientPreflight {
  readonly channelPath: typeof RUNTIME_TOPOLOGY_HANDSHAKE_CHANNEL_PATH;
  onFatalError?(error: RuntimeTopologyHandshakeError): void;
  run(channel: RuntimeTopologyHandshakeChannel, open: () => Promise<void>, signal?: AbortSignal): Promise<void>;
  getStatus(): RuntimeTopologyHandshakeStatus;
}

interface ServerHelloV1 {
  readonly type: 'hello';
  readonly protocol: typeof RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL;
  readonly protocolVersion: typeof RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL_VERSION;
  readonly contractSchemaVersion: 1;
  readonly enforcement: Exclude<RuntimeTopologyHandshakePolicy, 'off'>;
  readonly nonce: string;
  readonly nodeContract: RuntimePlanContract;
  readonly nodeContractDigest: RuntimePlanDigestV1;
}

interface ClientValidateV1 {
  readonly type: 'validate';
  readonly protocol: typeof RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL;
  readonly protocolVersion: typeof RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL_VERSION;
  readonly contractSchemaVersion: 1;
  readonly nonce: string;
  readonly browserContract: RuntimePlanContract;
  readonly browserContractDigest: RuntimePlanDigestV1;
}

interface AcceptedResultV1 {
  readonly type: 'result';
  readonly protocol: typeof RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL;
  readonly protocolVersion: typeof RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL_VERSION;
  readonly nonce: string;
  readonly status: 'accepted';
  readonly browserContractDigest: RuntimePlanDigestV1;
  readonly nodeContractDigest: RuntimePlanDigestV1;
  readonly topologyDigest: RuntimeTopologyDigestV1;
}

interface RejectedResultV1 {
  readonly type: 'result';
  readonly protocol: typeof RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL;
  readonly protocolVersion: typeof RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL_VERSION;
  readonly nonce: string;
  readonly status: 'rejected';
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly retryable: false;
  };
}

type ServerResultV1 = AcceptedResultV1 | RejectedResultV1;

interface ServerConnectionState {
  state: 'pending' | 'accepted' | 'rejected';
  nonce: string;
  topologyDigest?: RuntimeTopologyDigestV1;
  rejection?: string;
  rejectionCode?: string;
}

export type RuntimeTopologyHandshakeErrorCode =
  | 'HANDSHAKE_INVALID_PAYLOAD'
  | 'HANDSHAKE_UNSUPPORTED_VERSION'
  | 'HANDSHAKE_UNSUPPORTED_SERVER'
  | 'HANDSHAKE_DOWNGRADE_DETECTED'
  | 'HANDSHAKE_DIGEST_MISMATCH'
  | 'HANDSHAKE_REJECTED'
  | 'HANDSHAKE_TIMEOUT';

export class RuntimeTopologyHandshakeError extends Error {
  readonly retryable = false;

  constructor(
    public readonly code: RuntimeTopologyHandshakeErrorCode | string,
    message: string,
    public readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'RuntimeTopologyHandshakeError';
  }
}

const digestPattern = /^v1:sha256:[a-f0-9]{64}$/;
const utf8Encoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const expected = new Set(keys);
  const actual = Object.keys(value);
  for (const key of actual) {
    if (!expected.has(key)) {
      throw new RuntimeTopologyHandshakeError('HANDSHAKE_INVALID_PAYLOAD', `${label} has unknown field ${key}`);
    }
  }
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      throw new RuntimeTopologyHandshakeError('HANDSHAKE_INVALID_PAYLOAD', `${label} is missing field ${key}`);
    }
  }
}

function assertProtocolEnvelope(value: Record<string, unknown>, expectedType: 'hello' | 'validate' | 'result'): void {
  if (value.type !== expectedType || value.protocol !== RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL) {
    throw new RuntimeTopologyHandshakeError(
      'HANDSHAKE_INVALID_PAYLOAD',
      `Expected ${RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL} ${expectedType} message`,
    );
  }
  if (value.protocolVersion !== RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL_VERSION) {
    throw new RuntimeTopologyHandshakeError(
      'HANDSHAKE_UNSUPPORTED_VERSION',
      `Unsupported runtime topology handshake version ${String(value.protocolVersion)}`,
    );
  }
}

function assertNonce(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(value)) {
    throw new RuntimeTopologyHandshakeError('HANDSHAKE_INVALID_PAYLOAD', `${label} has an invalid nonce`);
  }
}

function assertDigest(value: unknown, label: string): asserts value is RuntimePlanDigestV1 | RuntimeTopologyDigestV1 {
  if (typeof value !== 'string' || !digestPattern.test(value)) {
    throw new RuntimeTopologyHandshakeError('HANDSHAKE_INVALID_PAYLOAD', `${label} has an invalid digest`);
  }
}

function parsePayload(content: string): Record<string, unknown> {
  if (typeof content !== 'string') {
    throw new RuntimeTopologyHandshakeError('HANDSHAKE_INVALID_PAYLOAD', 'Handshake payload must be a string');
  }
  // Reject obviously oversized UTF-16 strings before allocating another
  // buffer for the exact UTF-8 byte count. The transport's global frame limit
  // remains a separate, broader RPC concern.
  if (content.length > RUNTIME_TOPOLOGY_HANDSHAKE_MAX_PAYLOAD_BYTES) {
    throw new RuntimeTopologyHandshakeError(
      'HANDSHAKE_INVALID_PAYLOAD',
      `Handshake payload exceeds ${RUNTIME_TOPOLOGY_HANDSHAKE_MAX_PAYLOAD_BYTES} bytes`,
    );
  }
  if (utf8Encoder.encode(content).byteLength > RUNTIME_TOPOLOGY_HANDSHAKE_MAX_PAYLOAD_BYTES) {
    throw new RuntimeTopologyHandshakeError(
      'HANDSHAKE_INVALID_PAYLOAD',
      `Handshake payload exceeds ${RUNTIME_TOPOLOGY_HANDSHAKE_MAX_PAYLOAD_BYTES} bytes`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw new RuntimeTopologyHandshakeError('HANDSHAKE_INVALID_PAYLOAD', 'Handshake payload is not valid JSON');
  }
  if (!isRecord(value)) {
    throw new RuntimeTopologyHandshakeError('HANDSHAKE_INVALID_PAYLOAD', 'Handshake payload must be an object');
  }
  return value;
}

function parseServerHello(content: string): ServerHelloV1 {
  const value = parsePayload(content);
  assertProtocolEnvelope(value, 'hello');
  assertExactKeys(
    value,
    [
      'type',
      'protocol',
      'protocolVersion',
      'contractSchemaVersion',
      'enforcement',
      'nonce',
      'nodeContract',
      'nodeContractDigest',
    ],
    'Runtime topology hello',
  );
  if (value.contractSchemaVersion !== 1) {
    throw new RuntimeTopologyHandshakeError(
      'HANDSHAKE_UNSUPPORTED_VERSION',
      `Unsupported runtime topology contract version ${String(value.contractSchemaVersion)}`,
    );
  }
  if (value.enforcement !== 'compatible' && value.enforcement !== 'required') {
    throw new RuntimeTopologyHandshakeError(
      'HANDSHAKE_INVALID_PAYLOAD',
      'Runtime topology hello has invalid enforcement',
    );
  }
  assertNonce(value.nonce, 'Runtime topology hello');
  assertDigest(value.nodeContractDigest, 'Runtime topology hello');
  const nodeContract = normalizeRuntimePlanContract(value.nodeContract);
  if (nodeContract.runtime !== 'node') {
    throw new RuntimeTopologyHandshakeError(
      'HANDSHAKE_INVALID_PAYLOAD',
      'Runtime topology hello must contain a Node contract',
    );
  }
  if (digestRuntimePlanContract(nodeContract) !== value.nodeContractDigest) {
    throw new RuntimeTopologyHandshakeError(
      'HANDSHAKE_DIGEST_MISMATCH',
      'Node runtime contract digest does not match its payload',
      value.nonce,
    );
  }
  return { ...value, nodeContract } as unknown as ServerHelloV1;
}

function parseClientValidate(content: string): ClientValidateV1 {
  const value = parsePayload(content);
  assertProtocolEnvelope(value, 'validate');
  assertExactKeys(
    value,
    [
      'type',
      'protocol',
      'protocolVersion',
      'contractSchemaVersion',
      'nonce',
      'browserContract',
      'browserContractDigest',
    ],
    'Runtime topology validation',
  );
  if (value.contractSchemaVersion !== 1) {
    throw new RuntimeTopologyHandshakeError(
      'HANDSHAKE_UNSUPPORTED_VERSION',
      `Unsupported runtime topology contract version ${String(value.contractSchemaVersion)}`,
    );
  }
  assertNonce(value.nonce, 'Runtime topology validation');
  assertDigest(value.browserContractDigest, 'Runtime topology validation');
  const browserContract = normalizeRuntimePlanContract(value.browserContract);
  if (browserContract.runtime !== 'browser') {
    throw new RuntimeTopologyHandshakeError(
      'HANDSHAKE_INVALID_PAYLOAD',
      'Runtime topology validation must contain a Browser contract',
      value.nonce,
    );
  }
  if (digestRuntimePlanContract(browserContract) !== value.browserContractDigest) {
    throw new RuntimeTopologyHandshakeError(
      'HANDSHAKE_DIGEST_MISMATCH',
      'Browser runtime contract digest does not match its payload',
      value.nonce,
    );
  }
  return { ...value, browserContract } as unknown as ClientValidateV1;
}

function parseServerResult(content: string): ServerResultV1 {
  const value = parsePayload(content);
  assertProtocolEnvelope(value, 'result');
  if (value.status === 'accepted') {
    assertExactKeys(
      value,
      [
        'type',
        'protocol',
        'protocolVersion',
        'nonce',
        'status',
        'browserContractDigest',
        'nodeContractDigest',
        'topologyDigest',
      ],
      'Runtime topology result',
    );
    assertNonce(value.nonce, 'Runtime topology result');
    assertDigest(value.browserContractDigest, 'Runtime topology result');
    assertDigest(value.nodeContractDigest, 'Runtime topology result');
    assertDigest(value.topologyDigest, 'Runtime topology result');
    return value as unknown as AcceptedResultV1;
  }
  if (value.status === 'rejected') {
    assertExactKeys(
      value,
      ['type', 'protocol', 'protocolVersion', 'nonce', 'status', 'error'],
      'Runtime topology result',
    );
    assertNonce(value.nonce, 'Runtime topology result');
    if (!isRecord(value.error)) {
      throw new RuntimeTopologyHandshakeError('HANDSHAKE_INVALID_PAYLOAD', 'Rejected result must contain an error');
    }
    assertExactKeys(value.error, ['code', 'message', 'retryable'], 'Runtime topology result error');
    if (
      typeof value.error.code !== 'string' ||
      !/^[A-Z0-9_:-]{1,128}$/.test(value.error.code) ||
      typeof value.error.message !== 'string' ||
      value.error.message.length > 1_024 ||
      value.error.retryable !== false
    ) {
      throw new RuntimeTopologyHandshakeError('HANDSHAKE_INVALID_PAYLOAD', 'Rejected result contains an invalid error');
    }
    return value as unknown as RejectedResultV1;
  }
  throw new RuntimeTopologyHandshakeError('HANDSHAKE_INVALID_PAYLOAD', 'Runtime topology result has invalid status');
}

function serializePayload(payload: ServerHelloV1 | ClientValidateV1 | ServerResultV1): string {
  const content = JSON.stringify(payload);
  if (utf8Encoder.encode(content).byteLength > RUNTIME_TOPOLOGY_HANDSHAKE_MAX_PAYLOAD_BYTES) {
    throw new RuntimeTopologyHandshakeError(
      'HANDSHAKE_INVALID_PAYLOAD',
      `Handshake payload exceeds ${RUNTIME_TOPOLOGY_HANDSHAKE_MAX_PAYLOAD_BYTES} bytes`,
    );
  }
  return content;
}

function asHandshakeError(error: unknown, correlationId?: string): RuntimeTopologyHandshakeError {
  if (error instanceof RuntimeTopologyHandshakeError) {
    return error.correlationId || !correlationId
      ? error
      : new RuntimeTopologyHandshakeError(error.code, error.message, correlationId);
  }
  if (error instanceof FeatureGraphError || error instanceof RuntimeTopologyContractError) {
    return new RuntimeTopologyHandshakeError(error.code, error.message, correlationId);
  }
  return new RuntimeTopologyHandshakeError(
    'HANDSHAKE_INVALID_PAYLOAD',
    error instanceof Error ? error.message : String(error),
    correlationId,
  );
}

interface HandshakeDeadline {
  dispose(): void;
  wait<T>(promise: Promise<T>): Promise<T>;
}

function createHandshakeDeadline(
  timeoutMs: number,
  getCorrelationId: () => string | undefined,
  signal?: AbortSignal,
): HandshakeDeadline {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new RuntimeTopologyHandshakeError(
          'HANDSHAKE_TIMEOUT',
          `Runtime topology handshake timed out after ${timeoutMs}ms`,
          getCorrelationId(),
        ),
      );
    }, timeoutMs);
    (timer as any).unref?.();
  });
  let abortListener: (() => void) | undefined;
  const abort = signal
    ? new Promise<never>((_resolve, reject) => {
        abortListener = () => reject(signal.reason ?? new Error('Runtime topology handshake aborted'));
        if (signal.aborted) {
          abortListener();
          return;
        }
        signal.addEventListener('abort', abortListener, { once: true });
      })
    : undefined;
  return {
    dispose: () => {
      if (timer) {
        clearTimeout(timer);
      }
      if (signal && abortListener) {
        signal.removeEventListener('abort', abortListener);
      }
    },
    wait: <T>(promise: Promise<T>) => Promise.race(abort ? [promise, timeout, abort] : [promise, timeout]),
  };
}

function createStatus(
  policy: RuntimeTopologyHandshakePolicy,
  localContract: RuntimePlanContract,
  localContractDigest: RuntimePlanDigestV1,
): RuntimeTopologyHandshakeStatus {
  return {
    policy,
    protocolVersion: RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL_VERSION,
    localRuntime: localContract.runtime as 'browser' | 'node',
    profileId: localContract.profileId,
    enabledOptions: [...localContract.enabledOptions],
    localContractDigest,
    state: policy === 'off' ? 'off' : 'unseen',
    attempts: 0,
    verifiedAdmissions: 0,
    unverifiedAdmissions: 0,
    rejectedAdmissions: 0,
  };
}

export function parseRuntimeTopologyHandshakePolicy(
  value: string | undefined,
  fallback: RuntimeTopologyHandshakePolicy,
): RuntimeTopologyHandshakePolicy {
  if (value === undefined || value === '') {
    return fallback;
  }
  if (value === 'off' || value === 'compatible' || value === 'required') {
    return value;
  }
  throw new Error(`Unknown runtime topology handshake policy ${JSON.stringify(value)}`);
}

export function createRuntimeTopologyServerHandshake(options: {
  readonly runtimePlan: RuntimePlanContract;
  readonly policy: RuntimeTopologyHandshakePolicy;
}): RuntimeTopologyServerHandshake {
  const nodeContract = normalizeRuntimePlanContract(options.runtimePlan);
  if (nodeContract.runtime !== 'node') {
    throw new TypeError(`Runtime topology server requires a Node plan, got ${nodeContract.runtime}`);
  }
  const nodeContractDigest = digestRuntimePlanContract(nodeContract);
  let status = createStatus(options.policy, nodeContract, nodeContractDigest);
  const connections = new WeakMap<object, ServerConnectionState>();

  const updateStatus = (patch: Partial<RuntimeTopologyHandshakeStatus>) => {
    status = { ...status, ...patch };
  };

  return {
    channelPath: RUNTIME_TOPOLOGY_HANDSHAKE_CHANNEL_PATH,
    policy: options.policy,
    handleChannel(channel) {
      if (options.policy === 'off') {
        return;
      }
      const existingState = connections.get(channel.connection);
      if (existingState) {
        const duplicateResult: RejectedResultV1 = {
          type: 'result',
          protocol: RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL,
          protocolVersion: RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL_VERSION,
          nonce: existingState.nonce,
          status: 'rejected',
          error: {
            code: 'HANDSHAKE_INVALID_PAYLOAD',
            message: 'Runtime topology handshake already started for this physical connection',
            retryable: false,
          },
        };
        channel.send(serializePayload(duplicateResult));
        return;
      }
      const nonce = uuid(32);
      const state: ServerConnectionState = { state: 'pending', nonce };
      connections.set(channel.connection, state);
      updateStatus({
        state: 'pending',
        attempts: status.attempts + 1,
        lastAttemptAt: new Date().toISOString(),
        lastCorrelationId: nonce,
      });
      const hello: ServerHelloV1 = {
        type: 'hello',
        protocol: RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL,
        protocolVersion: RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL_VERSION,
        contractSchemaVersion: 1,
        enforcement: options.policy,
        nonce,
        nodeContract,
        nodeContractDigest,
      };
      channel.send(serializePayload(hello));
      const validationListener = channel.onMessage((content) => {
        // One physical connection gets one contract validation and one
        // terminal result. This bounds compilation cost and prevents a later
        // frame from mutating an already admitted connection's state.
        validationListener.dispose();
        try {
          const validation = parseClientValidate(content);
          if (validation.nonce !== nonce) {
            throw new RuntimeTopologyHandshakeError(
              'HANDSHAKE_INVALID_PAYLOAD',
              'Runtime topology validation nonce does not match this connection epoch',
              nonce,
            );
          }
          const topology = compileRuntimeTopologyContract(OpenSumiDefaultProductProfile, [
            validation.browserContract,
            nodeContract,
          ]);
          const topologyDigest = digestRuntimeTopologyContract(topology);
          const result: AcceptedResultV1 = {
            type: 'result',
            protocol: RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL,
            protocolVersion: RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL_VERSION,
            nonce,
            status: 'accepted',
            browserContractDigest: validation.browserContractDigest,
            nodeContractDigest,
            topologyDigest,
          };
          state.state = 'accepted';
          state.topologyDigest = topologyDigest;
          updateStatus({
            state: 'accepted',
            lastTopologyDigest: topologyDigest,
            lastCorrelationId: nonce,
            lastRejection: undefined,
            lastRejectionCode: undefined,
          });
          channel.send(serializePayload(result));
        } catch (error) {
          const handshakeError = asHandshakeError(error, nonce);
          const result: RejectedResultV1 = {
            type: 'result',
            protocol: RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL,
            protocolVersion: RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL_VERSION,
            nonce,
            status: 'rejected',
            error: {
              code: handshakeError.code,
              message: handshakeError.message.slice(0, 1_024),
              retryable: false,
            },
          };
          state.state = 'rejected';
          state.rejection = handshakeError.message;
          state.rejectionCode = handshakeError.code;
          updateStatus({
            state: 'rejected',
            lastCorrelationId: nonce,
            lastRejection: handshakeError.message.slice(0, 1_024),
            lastRejectionCode: handshakeError.code,
          });
          channel.send(serializePayload(result));
        }
      });
    },
    admitRPC(connection) {
      const connectionState = connections.get(connection);
      if (options.policy === 'off') {
        updateStatus({ unverifiedAdmissions: status.unverifiedAdmissions + 1 });
        return { accepted: true };
      }
      if (options.policy === 'compatible' && connectionState === undefined) {
        updateStatus({
          state: 'unseen',
          unverifiedAdmissions: status.unverifiedAdmissions + 1,
          lastCorrelationId: undefined,
          lastRejection: undefined,
          lastRejectionCode: undefined,
        });
        return { accepted: true };
      }
      if (connectionState?.state === 'accepted') {
        updateStatus({
          state: 'accepted',
          verifiedAdmissions: status.verifiedAdmissions + 1,
          lastTopologyDigest: connectionState.topologyDigest,
          lastCorrelationId: connectionState.nonce,
          lastRejection: undefined,
          lastRejectionCode: undefined,
        });
        return { accepted: true };
      }
      const reason =
        connectionState?.state === 'pending'
          ? 'runtime topology handshake pending'
          : connectionState?.state === 'rejected'
            ? 'runtime topology handshake rejected'
            : 'runtime topology handshake required';
      updateStatus({
        state: connectionState?.state ?? 'unseen',
        rejectedAdmissions: status.rejectedAdmissions + 1,
        lastCorrelationId: connectionState?.nonce,
        lastRejection: connectionState?.rejection ?? reason,
        lastRejectionCode:
          connectionState?.state === 'pending'
            ? 'HANDSHAKE_PENDING'
            : connectionState?.state === 'rejected'
              ? connectionState.rejectionCode || 'HANDSHAKE_REJECTED'
              : 'HANDSHAKE_REQUIRED',
      });
      return { accepted: false, reason };
    },
    getStatus() {
      return { ...status };
    },
  };
}

export function createRuntimeTopologyClientPreflight(options: {
  readonly runtimePlan: RuntimePlanContract;
  readonly policy: RuntimeTopologyHandshakePolicy;
  readonly timeoutMs?: number;
}): RuntimeTopologyClientPreflight {
  const browserContract = normalizeRuntimePlanContract(options.runtimePlan);
  if (browserContract.runtime !== 'browser') {
    throw new TypeError(`Runtime topology client requires a Browser plan, got ${browserContract.runtime}`);
  }
  const browserContractDigest = digestRuntimePlanContract(browserContract);
  const timeoutMs = options.timeoutMs ?? RUNTIME_TOPOLOGY_HANDSHAKE_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError(`Runtime topology handshake timeout must be a positive integer, got ${String(timeoutMs)}`);
  }
  let status = createStatus(options.policy, browserContract, browserContractDigest);
  let hasSeenV1 = false;

  const updateStatus = (patch: Partial<RuntimeTopologyHandshakeStatus>) => {
    status = { ...status, ...patch };
  };

  return {
    channelPath: RUNTIME_TOPOLOGY_HANDSHAKE_CHANNEL_PATH,
    async run(channel, open, signal) {
      if (options.policy === 'off') {
        return;
      }
      if (signal?.aborted) {
        throw signal.reason ?? new Error('Runtime topology handshake aborted');
      }
      let hello: ServerHelloV1 | undefined;
      let attemptError: RuntimeTopologyHandshakeError | undefined;
      let validationSent = false;
      let protocolSettled = false;
      let resolveResult!: (result: ServerResultV1) => void;
      let rejectResult!: (error: unknown) => void;
      const resultPromise = new Promise<ServerResultV1>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      // The server hello arrives before `open()` resolves. Mark a protocol
      // failure as observed immediately even if this attempt exits before it
      // reaches the result wait.
      void resultPromise.catch(() => undefined);
      const messageListener = channel.onMessage((content) => {
        if (protocolSettled) {
          return;
        }
        try {
          const value = parsePayload(content);
          if (value.type === 'hello') {
            if (hello) {
              throw new RuntimeTopologyHandshakeError('HANDSHAKE_INVALID_PAYLOAD', 'Received duplicate server hello');
            }
            hello = parseServerHello(content);
            hasSeenV1 = true;
            return;
          }
          if (value.type === 'result') {
            if (!hello || !validationSent) {
              throw new RuntimeTopologyHandshakeError(
                'HANDSHAKE_INVALID_PAYLOAD',
                'Received a runtime topology result before client validation',
              );
            }
            protocolSettled = true;
            messageListener.dispose();
            resolveResult(parseServerResult(content));
            return;
          }
          throw new RuntimeTopologyHandshakeError(
            'HANDSHAKE_INVALID_PAYLOAD',
            `Unexpected runtime topology message type ${String(value.type)}`,
          );
        } catch (error) {
          protocolSettled = true;
          messageListener.dispose();
          attemptError = asHandshakeError(error, hello?.nonce);
          rejectResult(attemptError);
        }
      });

      updateStatus({ state: 'pending', attempts: status.attempts + 1, lastAttemptAt: new Date().toISOString() });
      const deadline = createHandshakeDeadline(timeoutMs, () => hello?.nonce, signal);
      try {
        // One deadline covers logical-channel readiness, hello validation, and
        // the final digest result. A server that never sends server-ready must
        // not leave startup retrying the open frame forever.
        // Attach deadline and abort observers before invoking open(), whose
        // epoch assertion may throw synchronously during a reconnect race.
        await deadline.wait(
          Promise.resolve().then(() => {
            if (signal?.aborted) {
              throw signal.reason ?? new Error('Runtime topology handshake aborted');
            }
            return open();
          }),
        );
        if (attemptError) {
          throw attemptError;
        }
        if (!hello) {
          if (hasSeenV1) {
            throw new RuntimeTopologyHandshakeError(
              'HANDSHAKE_DOWNGRADE_DETECTED',
              'Runtime topology v1 disappeared after it was previously available',
            );
          }
          if (options.policy === 'required') {
            throw new RuntimeTopologyHandshakeError(
              'HANDSHAKE_UNSUPPORTED_SERVER',
              'Server does not support the runtime topology handshake',
            );
          }
          updateStatus({ state: 'unsupported', unverifiedAdmissions: status.unverifiedAdmissions + 1 });
          return;
        }

        const topology = compileRuntimeTopologyContract(OpenSumiDefaultProductProfile, [
          browserContract,
          hello.nodeContract,
        ]);
        const topologyDigest = digestRuntimeTopologyContract(topology);
        const validation: ClientValidateV1 = {
          type: 'validate',
          protocol: RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL,
          protocolVersion: RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL_VERSION,
          contractSchemaVersion: 1,
          nonce: hello.nonce,
          browserContract,
          browserContractDigest,
        };
        validationSent = true;
        channel.send(serializePayload(validation));
        const result = await deadline.wait(resultPromise);
        if (result.nonce !== hello.nonce) {
          throw new RuntimeTopologyHandshakeError(
            'HANDSHAKE_INVALID_PAYLOAD',
            'Runtime topology result belongs to another connection epoch',
            hello.nonce,
          );
        }
        if (result.status === 'rejected') {
          throw new RuntimeTopologyHandshakeError(result.error.code, result.error.message, hello.nonce);
        }
        if (
          result.browserContractDigest !== browserContractDigest ||
          result.nodeContractDigest !== hello.nodeContractDigest ||
          result.topologyDigest !== topologyDigest
        ) {
          throw new RuntimeTopologyHandshakeError(
            'HANDSHAKE_DIGEST_MISMATCH',
            'Runtime topology result does not match the contracts validated by this client',
            hello.nonce,
          );
        }
        updateStatus({
          state: 'accepted',
          verifiedAdmissions: status.verifiedAdmissions + 1,
          lastTopologyDigest: topologyDigest,
          lastCorrelationId: hello.nonce,
          lastRejection: undefined,
          lastRejectionCode: undefined,
        });
      } catch (error) {
        // Physical-connection retirement owns cancellation. It is not a
        // topology rejection and must not let an old epoch overwrite the
        // accepted status produced by a newer connection.
        if (signal?.aborted) {
          throw signal.reason ?? error;
        }
        const handshakeError = asHandshakeError(error, hello?.nonce);
        updateStatus({
          state: 'rejected',
          rejectedAdmissions: status.rejectedAdmissions + 1,
          lastCorrelationId: handshakeError.correlationId,
          lastRejection: handshakeError.message.slice(0, 1_024),
          lastRejectionCode: handshakeError.code,
        });
        throw handshakeError;
      } finally {
        deadline.dispose();
        messageListener.dispose();
      }
    },
    getStatus() {
      return { ...status };
    },
  };
}
