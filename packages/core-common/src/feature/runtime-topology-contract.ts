import { sha256 } from '@noble/hashes/sha256';

import { compileRuntimeTopology } from './feature-graph';

import type {
  FeatureRuntime,
  ProductProfile,
  RuntimePlanContract,
  RuntimePlanContractEntry,
  RuntimePortDescriptor,
} from './feature-graph';

export const RUNTIME_TOPOLOGY_CONTRACT_KIND = 'opensumi.runtime-topology' as const;
export const RUNTIME_TOPOLOGY_CONTRACT_VERSION = 1 as const;
export const RUNTIME_TOPOLOGY_DIGEST_ALGORITHM = 'sha256' as const;

export const RUNTIME_TOPOLOGY_CONTRACT_LIMITS = {
  maxBytes: 64 * 1024,
  maxEnabledOptions: 128,
  maxRuntimes: 6,
  maxEntriesPerRuntime: 512,
  maxBoundaryRequirementsPerRuntime: 128,
  maxPortsPerEntryDirection: 128,
  maxIdentifierLength: 256,
} as const;

export interface RuntimeTopologyContractRuntimeV1 {
  readonly runtime: FeatureRuntime;
  readonly boundaryRequirements: readonly {
    readonly providerRuntime: FeatureRuntime;
    readonly port: RuntimePortDescriptor;
  }[];
  /** Feature order remains behaviorally significant and matches the validated RuntimePlan. */
  readonly entries: readonly RuntimePlanContractEntry[];
}

export interface RuntimeTopologyContractV1 {
  readonly kind: typeof RUNTIME_TOPOLOGY_CONTRACT_KIND;
  readonly version: typeof RUNTIME_TOPOLOGY_CONTRACT_VERSION;
  readonly profileId: string;
  /** Canonical ProductProfile option order, not caller load-completion order. */
  readonly enabledOptions: readonly string[];
  readonly runtimes: readonly RuntimeTopologyContractRuntimeV1[];
}

export type RuntimeTopologyDigestV1 = `v1:${typeof RUNTIME_TOPOLOGY_DIGEST_ALGORITHM}:${string}`;
export type RuntimePlanDigestV1 = `v1:${typeof RUNTIME_TOPOLOGY_DIGEST_ALGORITHM}:${string}`;

export type RuntimeTopologyContractErrorCode =
  | 'INVALID_JSON'
  | 'INVALID_SCHEMA'
  | 'UNSUPPORTED_VERSION'
  | 'INVALID_VALUE'
  | 'UNKNOWN_KEY'
  | 'LIMIT_EXCEEDED'
  | 'DUPLICATE_VALUE'
  | 'DUPLICATE_PORT'
  | 'NON_CANONICAL_ORDER';

export class RuntimeTopologyContractError extends Error {
  constructor(
    public readonly code: RuntimeTopologyContractErrorCode,
    public readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'RuntimeTopologyContractError';
  }
}

const runtimeOrder: readonly FeatureRuntime[] = [
  'browser',
  'node',
  'electron-main',
  'browser-worker',
  'extension-host',
];
const runtimeSet = new Set<FeatureRuntime>(runtimeOrder);
const scopeSet = new Set<RuntimePortDescriptor['scope']>([
  'application',
  'workspace',
  'window',
  'session',
  'connection',
  'extension-host',
  'lease',
  'request',
]);
const idPattern = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/;
const utf8Encoder = new TextEncoder();

function fail(code: RuntimeTopologyContractErrorCode, path: string, message: string): never {
  throw new RuntimeTopologyContractError(code, path, message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, path: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    fail('INVALID_VALUE', path, 'must be an object');
  }
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const allowedKeys = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      fail('UNKNOWN_KEY', `${path}.${key}`, 'is not part of this contract version');
    }
  }
}

function assertArray(value: unknown, maxLength: number, path: string): asserts value is unknown[] {
  if (!Array.isArray(value)) {
    fail('INVALID_VALUE', path, 'must be an array');
  }
  if (value.length > maxLength) {
    fail('LIMIT_EXCEEDED', path, `contains ${value.length} items; maximum is ${maxLength}`);
  }
}

function assertIdentifier(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || !idPattern.test(value)) {
    fail('INVALID_VALUE', path, 'must be a stable namespaced identifier');
  }
  if (value.length > RUNTIME_TOPOLOGY_CONTRACT_LIMITS.maxIdentifierLength) {
    fail(
      'LIMIT_EXCEEDED',
      path,
      `contains ${value.length} characters; maximum is ${RUNTIME_TOPOLOGY_CONTRACT_LIMITS.maxIdentifierLength}`,
    );
  }
}

function assertRuntime(value: unknown, path: string): asserts value is FeatureRuntime {
  if (typeof value !== 'string' || !runtimeSet.has(value as FeatureRuntime)) {
    fail('INVALID_VALUE', path, `must be one of ${runtimeOrder.join(', ')}`);
  }
}

function compareRuntime(left: FeatureRuntime, right: FeatureRuntime): number {
  return runtimeOrder.indexOf(left) - runtimeOrder.indexOf(right);
}

function compareString(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePort(left: RuntimePortDescriptor, right: RuntimePortDescriptor): number {
  return compareString(left.id, right.id) || left.version - right.version || compareString(left.scope, right.scope);
}

function compareBoundary(
  left: RuntimeTopologyContractRuntimeV1['boundaryRequirements'][number],
  right: RuntimeTopologyContractRuntimeV1['boundaryRequirements'][number],
): number {
  return compareRuntime(left.providerRuntime, right.providerRuntime) || comparePort(left.port, right.port);
}

function assertUniqueStrings(values: readonly string[], path: string, code: RuntimeTopologyContractErrorCode): void {
  const seen = new Set<string>();
  for (let index = 0; index < values.length; index++) {
    const value = values[index];
    if (seen.has(value)) {
      fail(code, `${path}[${index}]`, `duplicates ${JSON.stringify(value)}`);
    }
    seen.add(value);
  }
}

function assertPort(value: unknown, path: string): asserts value is RuntimePortDescriptor {
  assertRecord(value, path);
  assertExactKeys(value, ['id', 'version', 'scope'], path);
  assertIdentifier(value.id, `${path}.id`);
  if (!Number.isSafeInteger(value.version) || (value.version as number) <= 0) {
    fail('INVALID_VALUE', `${path}.version`, 'must be a positive safe integer');
  }
  if (typeof value.scope !== 'string' || !scopeSet.has(value.scope as RuntimePortDescriptor['scope'])) {
    fail('INVALID_VALUE', `${path}.scope`, 'is not a supported runtime scope');
  }
}

function assertPortArray(value: unknown, path: string): asserts value is RuntimePortDescriptor[] {
  assertArray(value, RUNTIME_TOPOLOGY_CONTRACT_LIMITS.maxPortsPerEntryDirection, path);
  for (let index = 0; index < value.length; index++) {
    assertPort(value[index], `${path}[${index}]`);
  }
  const ports = value as RuntimePortDescriptor[];
  assertUniqueStrings(
    ports.map((port) => port.id),
    path,
    'DUPLICATE_PORT',
  );
}

function assertEntry(value: unknown, path: string): asserts value is RuntimePlanContractEntry {
  assertRecord(value, path);
  assertExactKeys(value, ['featureId', 'provides', 'consumes'], path);
  assertIdentifier(value.featureId, `${path}.featureId`);
  assertPortArray(value.provides, `${path}.provides`);
  assertPortArray(value.consumes, `${path}.consumes`);
}

function assertBoundaryRequirement(
  value: unknown,
  path: string,
): asserts value is RuntimeTopologyContractRuntimeV1['boundaryRequirements'][number] {
  assertRecord(value, path);
  assertExactKeys(value, ['providerRuntime', 'port'], path);
  assertRuntime(value.providerRuntime, `${path}.providerRuntime`);
  assertPort(value.port, `${path}.port`);
}

function assertRuntimeContract(value: unknown, path: string): asserts value is RuntimeTopologyContractRuntimeV1 {
  assertRecord(value, path);
  assertExactKeys(value, ['runtime', 'boundaryRequirements', 'entries'], path);
  assertRuntime(value.runtime, `${path}.runtime`);

  assertArray(
    value.boundaryRequirements,
    RUNTIME_TOPOLOGY_CONTRACT_LIMITS.maxBoundaryRequirementsPerRuntime,
    `${path}.boundaryRequirements`,
  );
  for (let index = 0; index < value.boundaryRequirements.length; index++) {
    assertBoundaryRequirement(value.boundaryRequirements[index], `${path}.boundaryRequirements[${index}]`);
  }
  const boundaryRequirements = value.boundaryRequirements as RuntimeTopologyContractRuntimeV1['boundaryRequirements'];
  assertUniqueStrings(
    boundaryRequirements.map((requirement) => requirement.port.id),
    `${path}.boundaryRequirements`,
    'DUPLICATE_PORT',
  );
  for (let index = 1; index < boundaryRequirements.length; index++) {
    if (compareBoundary(boundaryRequirements[index - 1], boundaryRequirements[index]) > 0) {
      fail('NON_CANONICAL_ORDER', `${path}.boundaryRequirements[${index}]`, 'is not in canonical order');
    }
  }

  assertArray(value.entries, RUNTIME_TOPOLOGY_CONTRACT_LIMITS.maxEntriesPerRuntime, `${path}.entries`);
  for (let index = 0; index < value.entries.length; index++) {
    assertEntry(value.entries[index], `${path}.entries[${index}]`);
  }
  const entries = value.entries as RuntimePlanContractEntry[];
  for (let index = 0; index < entries.length; index++) {
    for (const direction of ['provides', 'consumes'] as const) {
      const ports = entries[index][direction];
      for (let portIndex = 1; portIndex < ports.length; portIndex++) {
        if (comparePort(ports[portIndex - 1], ports[portIndex]) > 0) {
          fail(
            'NON_CANONICAL_ORDER',
            `${path}.entries[${index}].${direction}[${portIndex}]`,
            'is not in canonical order',
          );
        }
      }
    }
  }
  assertUniqueStrings(
    entries.map((entry) => entry.featureId),
    `${path}.entries`,
    'DUPLICATE_VALUE',
  );

  const providerPaths = new Map<string, string>();
  for (let index = 0; index < boundaryRequirements.length; index++) {
    providerPaths.set(boundaryRequirements[index].port.id, `${path}.boundaryRequirements[${index}].port`);
  }
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    for (let portIndex = 0; portIndex < entries[entryIndex].provides.length; portIndex++) {
      const port = entries[entryIndex].provides[portIndex];
      const portPath = `${path}.entries[${entryIndex}].provides[${portIndex}]`;
      const previousPath = providerPaths.get(port.id);
      if (previousPath) {
        fail('DUPLICATE_PORT', portPath, `${JSON.stringify(port.id)} already has a provider at ${previousPath}`);
      }
      providerPaths.set(port.id, portPath);
    }
  }
}

function assertRuntimePlanContractInput(value: unknown, path: string): asserts value is RuntimePlanContract {
  assertRecord(value, path);
  assertExactKeys(value, ['profileId', 'runtime', 'enabledOptions', 'boundaryRequirements', 'entries'], path);
  assertIdentifier(value.profileId, `${path}.profileId`);
  assertRuntime(value.runtime, `${path}.runtime`);

  assertArray(value.enabledOptions, RUNTIME_TOPOLOGY_CONTRACT_LIMITS.maxEnabledOptions, `${path}.enabledOptions`);
  for (let index = 0; index < value.enabledOptions.length; index++) {
    assertIdentifier(value.enabledOptions[index], `${path}.enabledOptions[${index}]`);
  }
  const enabledOptions = value.enabledOptions as string[];
  assertUniqueStrings(enabledOptions, `${path}.enabledOptions`, 'DUPLICATE_VALUE');

  assertArray(
    value.boundaryRequirements,
    RUNTIME_TOPOLOGY_CONTRACT_LIMITS.maxBoundaryRequirementsPerRuntime,
    `${path}.boundaryRequirements`,
  );
  for (let index = 0; index < value.boundaryRequirements.length; index++) {
    assertBoundaryRequirement(value.boundaryRequirements[index], `${path}.boundaryRequirements[${index}]`);
  }
  const boundaryRequirements = value.boundaryRequirements as RuntimeTopologyContractRuntimeV1['boundaryRequirements'];
  assertUniqueStrings(
    boundaryRequirements.map((requirement) => requirement.port.id),
    `${path}.boundaryRequirements`,
    'DUPLICATE_PORT',
  );

  assertArray(value.entries, RUNTIME_TOPOLOGY_CONTRACT_LIMITS.maxEntriesPerRuntime, `${path}.entries`);
  for (let index = 0; index < value.entries.length; index++) {
    assertEntry(value.entries[index], `${path}.entries[${index}]`);
  }
  const entries = value.entries as RuntimePlanContractEntry[];
  assertUniqueStrings(
    entries.map((entry) => entry.featureId),
    `${path}.entries`,
    'DUPLICATE_VALUE',
  );

  const providerPaths = new Map<string, string>();
  for (let index = 0; index < boundaryRequirements.length; index++) {
    providerPaths.set(boundaryRequirements[index].port.id, `${path}.boundaryRequirements[${index}].port`);
  }
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex++) {
    for (let portIndex = 0; portIndex < entries[entryIndex].provides.length; portIndex++) {
      const port = entries[entryIndex].provides[portIndex];
      const portPath = `${path}.entries[${entryIndex}].provides[${portIndex}]`;
      const previousPath = providerPaths.get(port.id);
      if (previousPath) {
        fail('DUPLICATE_PORT', portPath, `${JSON.stringify(port.id)} already has a provider at ${previousPath}`);
      }
      providerPaths.set(port.id, portPath);
    }
  }
}

function describePort(port: RuntimePortDescriptor): RuntimePortDescriptor {
  return {
    id: port.id,
    version: port.version,
    scope: port.scope,
  };
}

function cloneCanonicalPlanContract(plan: RuntimePlanContract): RuntimePlanContract {
  return {
    profileId: plan.profileId,
    runtime: plan.runtime,
    enabledOptions: [...plan.enabledOptions],
    boundaryRequirements: plan.boundaryRequirements
      .map((requirement) => ({
        providerRuntime: requirement.providerRuntime,
        port: describePort(requirement.port),
      }))
      .sort(compareBoundary),
    entries: plan.entries.map((entry) => ({
      featureId: entry.featureId,
      provides: entry.provides.map(describePort).sort(comparePort),
      consumes: entry.consumes.map(describePort).sort(comparePort),
    })),
  };
}

function cloneCanonicalContract(contract: RuntimeTopologyContractV1): RuntimeTopologyContractV1 {
  return {
    kind: RUNTIME_TOPOLOGY_CONTRACT_KIND,
    version: RUNTIME_TOPOLOGY_CONTRACT_VERSION,
    profileId: contract.profileId,
    enabledOptions: [...contract.enabledOptions],
    runtimes: contract.runtimes.map((runtime) => ({
      runtime: runtime.runtime,
      boundaryRequirements: runtime.boundaryRequirements.map((requirement) => ({
        providerRuntime: requirement.providerRuntime,
        port: describePort(requirement.port),
      })),
      entries: runtime.entries.map((entry) => ({
        featureId: entry.featureId,
        provides: entry.provides.map(describePort),
        consumes: entry.consumes.map(describePort),
      })),
    })),
  };
}

function assertSerializedSize(serialized: string, path: string): void {
  const bytes = utf8Encoder.encode(serialized).byteLength;
  if (bytes > RUNTIME_TOPOLOGY_CONTRACT_LIMITS.maxBytes) {
    fail(
      'LIMIT_EXCEEDED',
      path,
      `contains ${bytes} UTF-8 bytes; maximum is ${RUNTIME_TOPOLOGY_CONTRACT_LIMITS.maxBytes}`,
    );
  }
}

export function assertRuntimeTopologyContract(value: unknown): asserts value is RuntimeTopologyContractV1 {
  assertRecord(value, '$');
  assertExactKeys(value, ['kind', 'version', 'profileId', 'enabledOptions', 'runtimes'], '$');
  if (value.kind !== RUNTIME_TOPOLOGY_CONTRACT_KIND) {
    fail('INVALID_SCHEMA', '$.kind', `must be ${JSON.stringify(RUNTIME_TOPOLOGY_CONTRACT_KIND)}`);
  }
  if (value.version !== RUNTIME_TOPOLOGY_CONTRACT_VERSION) {
    fail(
      'UNSUPPORTED_VERSION',
      '$.version',
      `must be ${RUNTIME_TOPOLOGY_CONTRACT_VERSION}, got ${JSON.stringify(value.version)}`,
    );
  }
  assertIdentifier(value.profileId, '$.profileId');

  assertArray(value.enabledOptions, RUNTIME_TOPOLOGY_CONTRACT_LIMITS.maxEnabledOptions, '$.enabledOptions');
  for (let index = 0; index < value.enabledOptions.length; index++) {
    assertIdentifier(value.enabledOptions[index], `$.enabledOptions[${index}]`);
  }
  const enabledOptions = value.enabledOptions as string[];
  assertUniqueStrings(enabledOptions, '$.enabledOptions', 'DUPLICATE_VALUE');

  assertArray(value.runtimes, RUNTIME_TOPOLOGY_CONTRACT_LIMITS.maxRuntimes, '$.runtimes');
  for (let index = 0; index < value.runtimes.length; index++) {
    assertRuntimeContract(value.runtimes[index], `$.runtimes[${index}]`);
  }
  const runtimes = value.runtimes as RuntimeTopologyContractRuntimeV1[];
  for (let index = 1; index < runtimes.length; index++) {
    if (compareRuntime(runtimes[index - 1].runtime, runtimes[index].runtime) >= 0) {
      fail('NON_CANONICAL_ORDER', `$.runtimes[${index}]`, 'runtimes must be unique and in canonical order');
    }
  }

  let serialized: string;
  try {
    serialized = JSON.stringify(cloneCanonicalContract(value as unknown as RuntimeTopologyContractV1));
  } catch (error) {
    fail('INVALID_JSON', '$', `cannot be serialized: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertSerializedSize(serialized, '$');
}

export function isRuntimeTopologyContract(value: unknown): value is RuntimeTopologyContractV1 {
  try {
    assertRuntimeTopologyContract(value);
    return true;
  } catch {
    return false;
  }
}

export function parseRuntimeTopologyContract(serialized: string): RuntimeTopologyContractV1 {
  if (typeof serialized !== 'string') {
    fail('INVALID_VALUE', '$', 'serialized contract must be a string');
  }
  assertSerializedSize(serialized, '$');

  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    fail('INVALID_JSON', '$', `cannot be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
  assertRuntimeTopologyContract(value);
  return cloneCanonicalContract(value);
}

/**
 * Strictly validates and snapshots one side of a runtime handshake. This does
 * not replace whole-product validation: Browser and Node plans have different
 * digests and must still be joined by compileRuntimeTopology.
 */
export function normalizeRuntimePlanContract(value: unknown): RuntimePlanContract {
  assertRuntimePlanContractInput(value, '$');
  const normalized = cloneCanonicalPlanContract(value);
  assertSerializedSize(JSON.stringify(normalized), '$');
  return normalized;
}

export function parseRuntimePlanContract(serialized: string): RuntimePlanContract {
  if (typeof serialized !== 'string') {
    fail('INVALID_VALUE', '$', 'serialized contract must be a string');
  }
  assertSerializedSize(serialized, '$');

  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    fail('INVALID_JSON', '$', `cannot be parsed: ${error instanceof Error ? error.message : String(error)}`);
  }
  return normalizeRuntimePlanContract(value);
}

export function serializeRuntimePlanContract(plan: RuntimePlanContract): string {
  const serialized = JSON.stringify(normalizeRuntimePlanContract(plan));
  assertSerializedSize(serialized, '$');
  return serialized;
}

export function digestRuntimePlanContract(plan: RuntimePlanContract): RuntimePlanDigestV1 {
  const serialized = serializeRuntimePlanContract(plan);
  const digest = bytesToHex(sha256(utf8Encoder.encode(serialized)));
  return `v1:${RUNTIME_TOPOLOGY_DIGEST_ALGORITHM}:${digest}`;
}

/**
 * Validates all executable-plan contracts as one product before creating the
 * constructor-free, versioned digest input. Set-like arrays are sorted while
 * the validated RuntimePlan entry order remains intact.
 */
export function compileRuntimeTopologyContract(
  profile: ProductProfile,
  runtimePlans: readonly RuntimePlanContract[],
): RuntimeTopologyContractV1 {
  const topology = compileRuntimeTopology(profile, runtimePlans);
  const normalizedPlans = runtimePlans.map((plan, index) => {
    try {
      return normalizeRuntimePlanContract(plan);
    } catch (error) {
      if (error instanceof RuntimeTopologyContractError && error.path.startsWith('$')) {
        throw new RuntimeTopologyContractError(
          error.code,
          `$runtimePlans[${index}]${error.path.slice(1)}`,
          error.message.slice(error.path.length + 2),
        );
      }
      throw error;
    }
  });

  const planByRuntime = new Map(normalizedPlans.map((plan) => [plan.runtime, plan]));
  const contract: RuntimeTopologyContractV1 = {
    kind: RUNTIME_TOPOLOGY_CONTRACT_KIND,
    version: RUNTIME_TOPOLOGY_CONTRACT_VERSION,
    profileId: topology.profileId,
    enabledOptions: [...topology.enabledOptions],
    runtimes: topology.runtimes.map(({ runtime }) => {
      const plan = planByRuntime.get(runtime)!;
      return {
        runtime,
        boundaryRequirements: plan.boundaryRequirements
          .map((requirement) => ({
            providerRuntime: requirement.providerRuntime,
            port: describePort(requirement.port),
          }))
          .sort(compareBoundary),
        entries: plan.entries.map((entry) => ({
          featureId: entry.featureId,
          provides: entry.provides.map(describePort).sort(comparePort),
          consumes: entry.consumes.map(describePort).sort(comparePort),
        })),
      };
    }),
  };

  assertRuntimeTopologyContract(contract);
  return contract;
}

export function serializeRuntimeTopologyContract(contract: RuntimeTopologyContractV1): string {
  assertRuntimeTopologyContract(contract);
  const serialized = JSON.stringify(cloneCanonicalContract(contract));
  assertSerializedSize(serialized, '$');
  return serialized;
}

function bytesToHex(bytes: Uint8Array): string {
  let result = '';
  for (const byte of bytes) {
    result += byte.toString(16).padStart(2, '0');
  }
  return result;
}

export function digestRuntimeTopologyContract(contract: RuntimeTopologyContractV1): RuntimeTopologyDigestV1 {
  const serialized = serializeRuntimeTopologyContract(contract);
  const digest = bytesToHex(sha256(utf8Encoder.encode(serialized)));
  return `v1:${RUNTIME_TOPOLOGY_DIGEST_ALGORITHM}:${digest}`;
}
