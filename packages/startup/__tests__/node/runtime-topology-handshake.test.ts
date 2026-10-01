import {
  compileRuntimeTopologyContract,
  digestRuntimePlanContract,
  digestRuntimeTopologyContract,
  toRuntimePlanContract,
} from '@opensumi/ide-core-common';

import {
  CommonBrowserFeatures,
  CommonNodeFeatures,
  OpenSumiDefaultProductProfile,
  OptionalBrowserFeatures,
  OptionalNodeFeatures,
} from '../../src/product-profile';
import { compileOpenSumiProductRuntimePlan } from '../../src/product-runtime-plan';
import {
  RUNTIME_TOPOLOGY_HANDSHAKE_MAX_PAYLOAD_BYTES,
  RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL,
  RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL_VERSION,
  createRuntimeTopologyClientPreflight,
  createRuntimeTopologyServerHandshake,
} from '../../src/runtime-topology-handshake';

import type { RuntimeTopologyHandshakeChannel } from '../../src/runtime-topology-handshake';
import type { RuntimePlanContract, RuntimePlanDigestV1 } from '@opensumi/ide-core-common';

type ProductOption = keyof typeof OptionalBrowserFeatures;

const productTopologies = [
  ['default', []],
  ['ai', ['ai']],
  ['notebook', ['notebook']],
  ['collaboration', ['collaboration']],
  ['full', ['ai', 'notebook', 'collaboration']],
] as const satisfies readonly (readonly [string, readonly ProductOption[]])[];

const validNonce = 'epoch-0123456789abcdef';

class ManualHandshakeChannel implements RuntimeTopologyHandshakeChannel {
  private readonly listeners = new Set<(content: string) => void>();

  readonly sent: string[] = [];
  onSend?: (content: string) => void;

  send(content: string): void {
    this.sent.push(content);
    this.onSend?.(content);
  }

  onMessage(listener: (content: string) => void): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  emit(content: string): void {
    for (const listener of [...this.listeners]) {
      listener(content);
    }
  }
}

function createMemoryChannelPair(connection: object = {}) {
  const client = new ManualHandshakeChannel();
  const server = Object.assign(new ManualHandshakeChannel(), { connection });
  client.onSend = (content) => server.emit(content);
  server.onSend = (content) => client.emit(content);
  return { client, connection, server };
}

function createServerChannel(connection: object = {}) {
  return Object.assign(new ManualHandshakeChannel(), { connection });
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20 && !predicate(); index++) {
    await Promise.resolve();
  }
  expect(predicate()).toBe(true);
}

function createRuntimeContract(runtime: 'browser' | 'node', enabledOptions: readonly ProductOption[] = []) {
  const commonFeatures = runtime === 'browser' ? CommonBrowserFeatures : CommonNodeFeatures;
  const optionalFeatures = runtime === 'browser' ? OptionalBrowserFeatures : OptionalNodeFeatures;
  const plan = compileOpenSumiProductRuntimePlan({
    runtime,
    commonModules: commonFeatures.map((feature) => `${feature.id}.${runtime}-module`),
    options: enabledOptions.map((id) => ({
      id,
      modules: optionalFeatures[id].map((feature) => `${feature.id}.${runtime}-module`),
    })),
  });

  return toRuntimePlanContract(plan);
}

function createRuntimeContracts(enabledOptions: readonly ProductOption[] = []) {
  return {
    browser: createRuntimeContract('browser', enabledOptions),
    node: createRuntimeContract('node', enabledOptions),
  };
}

function createHello(nodeContract: RuntimePlanContract, overrides: Record<string, unknown> = {}) {
  return {
    type: 'hello',
    protocol: RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL,
    protocolVersion: RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL_VERSION,
    contractSchemaVersion: 1,
    enforcement: 'required',
    nonce: validNonce,
    nodeContract,
    nodeContractDigest: digestRuntimePlanContract(nodeContract),
    ...overrides,
  };
}

function createAcceptedResult(
  browserContract: RuntimePlanContract,
  nodeContract: RuntimePlanContract,
  nonce = validNonce,
) {
  const topology = compileRuntimeTopologyContract(OpenSumiDefaultProductProfile, [browserContract, nodeContract]);
  return {
    type: 'result',
    protocol: RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL,
    protocolVersion: RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL_VERSION,
    nonce,
    status: 'accepted',
    browserContractDigest: digestRuntimePlanContract(browserContract),
    nodeContractDigest: digestRuntimePlanContract(nodeContract),
    topologyDigest: digestRuntimeTopologyContract(topology),
  };
}

function createValidation(browserContract: RuntimePlanContract, nonce: string) {
  return {
    type: 'validate',
    protocol: RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL,
    protocolVersion: RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL_VERSION,
    contractSchemaVersion: 1,
    nonce,
    browserContract,
    browserContractDigest: digestRuntimePlanContract(browserContract),
  };
}

function parseFrame(content: string): Record<string, unknown> {
  return JSON.parse(content) as Record<string, unknown>;
}

function changeDigest(digest: RuntimePlanDigestV1): RuntimePlanDigestV1 {
  const replacement = digest.endsWith('0') ? '1' : '0';
  return `${digest.slice(0, -1)}${replacement}` as RuntimePlanDigestV1;
}

function driftNodeDiskPort(nodeContract: RuntimePlanContract): RuntimePlanContract {
  return {
    ...nodeContract,
    entries: nodeContract.entries.map((entry) => ({
      ...entry,
      provides: entry.provides.map((port) =>
        port.id === 'opensumi.files.disk-service' ? { ...port, version: port.version + 1 } : port,
      ),
    })),
  };
}

describe('runtime topology handshake', () => {
  it.each(productTopologies)('accepts the %s Browser/Node compatibility matrix', async (_name, enabledOptions) => {
    expect.hasAssertions();
    const contracts = createRuntimeContracts(enabledOptions);
    const connection = {};
    const channels = createMemoryChannelPair(connection);
    const server = createRuntimeTopologyServerHandshake({ runtimePlan: contracts.node, policy: 'required' });
    const client = createRuntimeTopologyClientPreflight({ runtimePlan: contracts.browser, policy: 'required' });
    const expectedTopologyDigest = digestRuntimeTopologyContract(
      compileRuntimeTopologyContract(OpenSumiDefaultProductProfile, [contracts.browser, contracts.node]),
    );

    await client.run(channels.client, async () => server.handleChannel(channels.server));

    expect(server.admitRPC(connection)).toEqual({ accepted: true });
    expect(client.getStatus()).toMatchObject({
      state: 'accepted',
      profileId: 'opensumi.default',
      enabledOptions,
      attempts: 1,
      verifiedAdmissions: 1,
      lastTopologyDigest: expectedTopologyDigest,
      lastAttemptAt: expect.any(String),
      lastCorrelationId: parseFrame(channels.server.sent[0]).nonce,
    });
    expect(server.getStatus()).toMatchObject({
      state: 'accepted',
      profileId: 'opensumi.default',
      enabledOptions,
      attempts: 1,
      verifiedAdmissions: 1,
      lastTopologyDigest: expectedTopologyDigest,
      lastAttemptAt: expect.any(String),
      lastCorrelationId: parseFrame(channels.server.sent[0]).nonce,
    });
  });

  it('completes a real pre-ready hello -> validate -> accepted round trip', async () => {
    expect.hasAssertions();
    const contracts = createRuntimeContracts();
    const connection = {};
    const channels = createMemoryChannelPair(connection);
    const server = createRuntimeTopologyServerHandshake({ runtimePlan: contracts.node, policy: 'required' });
    const client = createRuntimeTopologyClientPreflight({ runtimePlan: contracts.browser, policy: 'required' });
    const inbound: Array<{ openCallbackReturned: boolean; type: unknown }> = [];
    let openCallbackReturned = false;
    channels.client.onMessage((content) => {
      inbound.push({ openCallbackReturned, type: parseFrame(content).type });
    });

    await client.run(channels.client, async () => {
      server.handleChannel(channels.server);
      expect(server.admitRPC(connection)).toEqual({
        accepted: false,
        reason: 'runtime topology handshake pending',
      });
      openCallbackReturned = true;
    });

    expect(inbound).toEqual([
      { type: 'hello', openCallbackReturned: false },
      { type: 'result', openCallbackReturned: true },
    ]);
    expect(channels.server.sent.map((content) => parseFrame(content).type)).toEqual(['hello', 'result']);
    expect(channels.client.sent.map((content) => parseFrame(content).type)).toEqual(['validate']);
    expect(parseFrame(channels.server.sent[1])).toMatchObject({
      type: 'result',
      status: 'accepted',
      nonce: parseFrame(channels.server.sent[0]).nonce,
    });
    expect(server.admitRPC(connection)).toEqual({ accepted: true });
  });

  it.each([
    {
      name: 'wire contract drift',
      expectedCode: 'UNKNOWN_KEY',
      create: (browser: RuntimePlanContract, node: RuntimePlanContract) => ({
        browser,
        hello: createHello(node, { nodeContract: { ...node, futureField: true } }),
      }),
    },
    {
      name: 'contract digest drift',
      expectedCode: 'HANDSHAKE_DIGEST_MISMATCH',
      create: (browser: RuntimePlanContract, node: RuntimePlanContract) => ({
        browser,
        hello: createHello(node, { nodeContractDigest: changeDigest(digestRuntimePlanContract(node)) }),
      }),
    },
    {
      name: 'product profile drift',
      expectedCode: 'RUNTIME_PLAN_PROFILE_MISMATCH',
      create: (browser: RuntimePlanContract, node: RuntimePlanContract) => {
        const driftedNode = { ...node, profileId: 'opensumi.drifted' };
        return { browser, hello: createHello(driftedNode) };
      },
    },
    {
      name: 'product option contract drift',
      expectedCode: 'RUNTIME_PLAN_OPTIONS_MISMATCH',
      create: (_browser: RuntimePlanContract, node: RuntimePlanContract) => ({
        browser: createRuntimeContract('browser', ['ai']),
        hello: createHello(node),
      }),
    },
    {
      name: 'runtime port drift',
      expectedCode: 'PORT_CONTRACT_MISMATCH',
      create: (browser: RuntimePlanContract, node: RuntimePlanContract) => ({
        browser,
        hello: createHello(driftNodeDiskPort(node)),
      }),
    },
  ])('rejects $name before validation', async ({ create, expectedCode }) => {
    expect.hasAssertions();
    const contracts = createRuntimeContracts();
    const scenario = create(contracts.browser, contracts.node);
    const channel = new ManualHandshakeChannel();
    const client = createRuntimeTopologyClientPreflight({ runtimePlan: scenario.browser, policy: 'compatible' });

    await expect(client.run(channel, async () => channel.emit(JSON.stringify(scenario.hello)))).rejects.toMatchObject({
      name: 'RuntimeTopologyHandshakeError',
      code: expectedCode,
    });
    expect(channel.sent).toEqual([]);
    expect(client.getStatus()).toMatchObject({ state: 'rejected', rejectedAdmissions: 1 });
  });

  it.each(['browserContractDigest', 'nodeContractDigest', 'topologyDigest'] as const)(
    'rejects accepted-result %s drift',
    async (digestField) => {
      expect.hasAssertions();
      const contracts = createRuntimeContracts();
      const channel = new ManualHandshakeChannel();
      const client = createRuntimeTopologyClientPreflight({ runtimePlan: contracts.browser, policy: 'required' });
      channel.onSend = () => {
        const accepted = createAcceptedResult(contracts.browser, contracts.node);
        channel.emit(
          JSON.stringify({
            ...accepted,
            [digestField]: changeDigest(accepted[digestField]),
          }),
        );
      };

      await expect(
        client.run(channel, async () => channel.emit(JSON.stringify(createHello(contracts.node)))),
      ).rejects.toMatchObject({
        name: 'RuntimeTopologyHandshakeError',
        code: 'HANDSHAKE_DIGEST_MISMATCH',
        correlationId: validNonce,
      });
      expect(channel.sent.map((content) => parseFrame(content).type)).toEqual(['validate']);
      expect(client.getStatus()).toMatchObject({ state: 'rejected', rejectedAdmissions: 1 });
    },
  );

  it('falls back only for a genuinely old server under compatible policy', async () => {
    expect.hasAssertions();
    const client = createRuntimeTopologyClientPreflight({
      runtimePlan: createRuntimeContract('browser'),
      policy: 'compatible',
    });
    const channel = new ManualHandshakeChannel();

    await expect(client.run(channel, async () => undefined)).resolves.toBeUndefined();
    expect(channel.sent).toEqual([]);
    expect(client.getStatus()).toMatchObject({
      state: 'unsupported',
      attempts: 1,
      unverifiedAdmissions: 1,
      rejectedAdmissions: 0,
    });
  });

  it('rejects a genuinely old server under required policy', async () => {
    expect.hasAssertions();
    const client = createRuntimeTopologyClientPreflight({
      runtimePlan: createRuntimeContract('browser'),
      policy: 'required',
    });

    await expect(client.run(new ManualHandshakeChannel(), async () => undefined)).rejects.toMatchObject({
      name: 'RuntimeTopologyHandshakeError',
      code: 'HANDSHAKE_UNSUPPORTED_SERVER',
    });
    expect(client.getStatus()).toMatchObject({ state: 'rejected', rejectedAdmissions: 1 });
  });

  it.each([
    ['invalid JSON', () => '{', 'HANDSHAKE_INVALID_PAYLOAD'],
    [
      'an unknown hello field',
      (node: RuntimePlanContract) => JSON.stringify({ ...createHello(node), futureField: true }),
      'HANDSHAKE_INVALID_PAYLOAD',
    ],
    [
      'an unknown message instead of hello',
      () => JSON.stringify({ type: 'legacy-ready' }),
      'HANDSHAKE_INVALID_PAYLOAD',
    ],
    [
      'an unknown hello version',
      (node: RuntimePlanContract) => JSON.stringify({ ...createHello(node), protocolVersion: 2 }),
      'HANDSHAKE_UNSUPPORTED_VERSION',
    ],
  ] as const)('does not use compatible fallback for %s', async (_name, payload, expectedCode) => {
    expect.hasAssertions();
    const contracts = createRuntimeContracts();
    const channel = new ManualHandshakeChannel();
    const client = createRuntimeTopologyClientPreflight({ runtimePlan: contracts.browser, policy: 'compatible' });

    await expect(client.run(channel, async () => channel.emit(payload(contracts.node)))).rejects.toMatchObject({
      name: 'RuntimeTopologyHandshakeError',
      code: expectedCode,
    });
    expect(client.getStatus()).toMatchObject({
      state: 'rejected',
      unverifiedAdmissions: 0,
      rejectedAdmissions: 1,
    });
  });

  it('does not use compatible fallback for a result received before hello', async () => {
    expect.hasAssertions();
    const contracts = createRuntimeContracts();
    const channel = new ManualHandshakeChannel();
    const client = createRuntimeTopologyClientPreflight({ runtimePlan: contracts.browser, policy: 'compatible' });

    await expect(
      client.run(channel, async () =>
        channel.emit(JSON.stringify(createAcceptedResult(contracts.browser, contracts.node))),
      ),
    ).rejects.toMatchObject({
      name: 'RuntimeTopologyHandshakeError',
      code: 'HANDSHAKE_INVALID_PAYLOAD',
    });
    expect(client.getStatus()).toMatchObject({
      state: 'rejected',
      unverifiedAdmissions: 0,
      rejectedAdmissions: 1,
    });
  });

  it('rejects a result received after hello but before client validation', async () => {
    expect.hasAssertions();
    const contracts = createRuntimeContracts();
    const channel = new ManualHandshakeChannel();
    const client = createRuntimeTopologyClientPreflight({ runtimePlan: contracts.browser, policy: 'compatible' });

    await expect(
      client.run(channel, async () => {
        channel.emit(JSON.stringify(createHello(contracts.node)));
        channel.emit(JSON.stringify(createAcceptedResult(contracts.browser, contracts.node)));
      }),
    ).rejects.toMatchObject({
      name: 'RuntimeTopologyHandshakeError',
      code: 'HANDSHAKE_INVALID_PAYLOAD',
      correlationId: validNonce,
    });
    expect(channel.sent).toEqual([]);
    expect(client.getStatus()).toMatchObject({
      state: 'rejected',
      unverifiedAdmissions: 0,
      rejectedAdmissions: 1,
      lastCorrelationId: validNonce,
      lastRejectionCode: 'HANDSHAKE_INVALID_PAYLOAD',
      lastRejection: 'Received a runtime topology result before client validation',
    });
  });

  it('makes v1 support sticky and rejects a later downgrade', async () => {
    expect.hasAssertions();
    const contracts = createRuntimeContracts();
    const client = createRuntimeTopologyClientPreflight({ runtimePlan: contracts.browser, policy: 'compatible' });
    const server = createRuntimeTopologyServerHandshake({ runtimePlan: contracts.node, policy: 'compatible' });
    const supportedChannels = createMemoryChannelPair();

    await client.run(supportedChannels.client, async () => server.handleChannel(supportedChannels.server));
    await expect(client.run(new ManualHandshakeChannel(), async () => undefined)).rejects.toMatchObject({
      name: 'RuntimeTopologyHandshakeError',
      code: 'HANDSHAKE_DOWNGRADE_DETECTED',
    });
    expect(client.getStatus()).toMatchObject({
      state: 'rejected',
      attempts: 2,
      verifiedAdmissions: 1,
      unverifiedAdmissions: 0,
      rejectedAdmissions: 1,
    });
  });

  it('treats an aborted old attempt as cancellation without overwriting a newer accepted state', async () => {
    expect.hasAssertions();
    const contracts = createRuntimeContracts();
    const client = createRuntimeTopologyClientPreflight({ runtimePlan: contracts.browser, policy: 'required' });
    const staleChannel = new ManualHandshakeChannel();
    const staleEpoch = new AbortController();
    const staleRun = client.run(
      staleChannel,
      async () => staleChannel.emit(JSON.stringify(createHello(contracts.node))),
      staleEpoch.signal,
    );
    void staleRun.catch(() => undefined);
    await waitFor(() => staleChannel.sent.length === 1);
    expect(staleChannel.sent.map((content) => parseFrame(content).type)).toEqual(['validate']);
    expect(client.getStatus()).toMatchObject({ state: 'pending', attempts: 1, rejectedAdmissions: 0 });

    const currentChannels = createMemoryChannelPair();
    const currentServer = createRuntimeTopologyServerHandshake({ runtimePlan: contracts.node, policy: 'required' });
    await client.run(currentChannels.client, async () => currentServer.handleChannel(currentChannels.server));
    const acceptedStatus = client.getStatus();
    expect(acceptedStatus).toMatchObject({
      state: 'accepted',
      attempts: 2,
      verifiedAdmissions: 1,
      rejectedAdmissions: 0,
      lastRejection: undefined,
      lastRejectionCode: undefined,
    });

    const staleReason = new Error('physical connection epoch retired');
    staleEpoch.abort(staleReason);
    await expect(staleRun).rejects.toBe(staleReason);

    expect(client.getStatus()).toEqual(acceptedStatus);
    expect(client.getStatus().rejectedAdmissions).toBe(0);
  });

  it('does not start or record an attempt for an already-aborted physical epoch', async () => {
    expect.hasAssertions();
    const client = createRuntimeTopologyClientPreflight({
      runtimePlan: createRuntimeContract('browser'),
      policy: 'required',
    });
    const epoch = new AbortController();
    const reason = new Error('physical connection epoch already retired');
    const open = jest.fn(async () => undefined);
    epoch.abort(reason);

    await expect(client.run(new ManualHandshakeChannel(), open, epoch.signal)).rejects.toBe(reason);

    expect(open).not.toHaveBeenCalled();
    expect(client.getStatus()).toMatchObject({ state: 'unseen', attempts: 0, rejectedAdmissions: 0 });
  });

  it('rejects result and validation nonces from another connection epoch', async () => {
    expect.hasAssertions();
    const contracts = createRuntimeContracts();
    const clientChannel = new ManualHandshakeChannel();
    const client = createRuntimeTopologyClientPreflight({ runtimePlan: contracts.browser, policy: 'required' });
    clientChannel.onSend = () => {
      clientChannel.emit(
        JSON.stringify(createAcceptedResult(contracts.browser, contracts.node, 'other-0123456789abcdef')),
      );
    };

    await expect(
      client.run(clientChannel, async () => clientChannel.emit(JSON.stringify(createHello(contracts.node)))),
    ).rejects.toMatchObject({
      name: 'RuntimeTopologyHandshakeError',
      code: 'HANDSHAKE_INVALID_PAYLOAD',
      correlationId: validNonce,
    });

    const connection = {};
    const serverChannel = createServerChannel(connection);
    const server = createRuntimeTopologyServerHandshake({ runtimePlan: contracts.node, policy: 'required' });
    server.handleChannel(serverChannel);
    serverChannel.emit(
      JSON.stringify({
        type: 'validate',
        protocol: RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL,
        protocolVersion: RUNTIME_TOPOLOGY_HANDSHAKE_PROTOCOL_VERSION,
        contractSchemaVersion: 1,
        nonce: 'other-0123456789abcdef',
        browserContract: contracts.browser,
        browserContractDigest: digestRuntimePlanContract(contracts.browser),
      }),
    );

    expect(parseFrame(serverChannel.sent[1])).toMatchObject({
      type: 'result',
      status: 'rejected',
      error: { code: 'HANDSHAKE_INVALID_PAYLOAD', retryable: false },
    });
    expect(server.admitRPC(connection)).toEqual({
      accepted: false,
      reason: 'runtime topology handshake rejected',
    });
  });

  it('keeps an accepted server epoch immutable after a later malformed validation', () => {
    expect.hasAssertions();
    const contracts = createRuntimeContracts();
    const connection = {};
    const channel = createServerChannel(connection);
    const server = createRuntimeTopologyServerHandshake({ runtimePlan: contracts.node, policy: 'required' });
    server.handleChannel(channel);
    const nonce = parseFrame(channel.sent[0]).nonce as string;

    channel.emit(JSON.stringify(createValidation(contracts.browser, nonce)));
    const acceptedResult = channel.sent[1];
    const acceptedStatus = server.getStatus();
    expect(parseFrame(acceptedResult)).toMatchObject({ status: 'accepted', nonce });
    expect(acceptedStatus).toMatchObject({
      state: 'accepted',
      attempts: 1,
      lastCorrelationId: nonce,
      lastRejection: undefined,
      lastRejectionCode: undefined,
    });

    channel.emit('{');

    expect(channel.sent).toHaveLength(2);
    expect(channel.sent[1]).toBe(acceptedResult);
    expect(server.getStatus()).toEqual(acceptedStatus);
    expect(server.admitRPC(connection)).toEqual({ accepted: true });
  });

  it('does not restart or overwrite an accepted handshake on the same physical connection', () => {
    expect.hasAssertions();
    const contracts = createRuntimeContracts();
    const connection = {};
    const primaryChannel = createServerChannel(connection);
    const server = createRuntimeTopologyServerHandshake({ runtimePlan: contracts.node, policy: 'required' });
    server.handleChannel(primaryChannel);
    const nonce = parseFrame(primaryChannel.sent[0]).nonce as string;
    primaryChannel.emit(JSON.stringify(createValidation(contracts.browser, nonce)));
    const acceptedStatus = server.getStatus();

    const duplicateChannel = createServerChannel(connection);
    server.handleChannel(duplicateChannel);
    expect(duplicateChannel.sent).toHaveLength(1);
    expect(parseFrame(duplicateChannel.sent[0])).toMatchObject({
      type: 'result',
      nonce,
      status: 'rejected',
      error: {
        code: 'HANDSHAKE_INVALID_PAYLOAD',
        message: 'Runtime topology handshake already started for this physical connection',
      },
    });

    duplicateChannel.emit(JSON.stringify(createValidation(contracts.browser, nonce)));

    expect(duplicateChannel.sent).toHaveLength(1);
    expect(primaryChannel.sent).toHaveLength(2);
    expect(server.getStatus()).toEqual(acceptedStatus);
    expect(server.getStatus()).toMatchObject({ state: 'accepted', attempts: 1, lastCorrelationId: nonce });
    expect(server.admitRPC(connection)).toEqual({ accepted: true });
  });

  it('admits RPC by connection epoch across pending, rejected, accepted, and unseen states', async () => {
    expect.hasAssertions();
    const contracts = createRuntimeContracts();
    const server = createRuntimeTopologyServerHandshake({ runtimePlan: contracts.node, policy: 'required' });

    const pendingConnection = { clientId: 'pending-client' };
    server.handleChannel(createServerChannel(pendingConnection));
    expect(server.admitRPC(pendingConnection)).toEqual({
      accepted: false,
      reason: 'runtime topology handshake pending',
    });

    const rejectedConnection = { clientId: 'rejected-client' };
    const rejectedChannel = createServerChannel(rejectedConnection);
    server.handleChannel(rejectedChannel);
    rejectedChannel.emit('{');
    expect(server.admitRPC(rejectedConnection)).toEqual({
      accepted: false,
      reason: 'runtime topology handshake rejected',
    });

    const acceptedConnection = { clientId: 'same-client' };
    const acceptedChannels = createMemoryChannelPair(acceptedConnection);
    const client = createRuntimeTopologyClientPreflight({ runtimePlan: contracts.browser, policy: 'required' });
    await client.run(acceptedChannels.client, async () => server.handleChannel(acceptedChannels.server));
    expect(server.admitRPC(acceptedConnection)).toEqual({ accepted: true });

    const sameClientIdButUnseenConnection = { clientId: 'same-client' };
    expect(server.admitRPC(sameClientIdButUnseenConnection)).toEqual({
      accepted: false,
      reason: 'runtime topology handshake required',
    });
    expect(server.getStatus()).toMatchObject({
      verifiedAdmissions: 1,
      rejectedAdmissions: 3,
    });
  });

  it('rejects oversized payloads on both handshake peers', async () => {
    expect.hasAssertions();
    const contracts = createRuntimeContracts();
    const oversizedPayload = '€'.repeat(Math.floor(RUNTIME_TOPOLOGY_HANDSHAKE_MAX_PAYLOAD_BYTES / 3) + 1);
    const clientChannel = new ManualHandshakeChannel();
    const client = createRuntimeTopologyClientPreflight({ runtimePlan: contracts.browser, policy: 'compatible' });

    await expect(client.run(clientChannel, async () => clientChannel.emit(oversizedPayload))).rejects.toMatchObject({
      name: 'RuntimeTopologyHandshakeError',
      code: 'HANDSHAKE_INVALID_PAYLOAD',
      message: expect.stringContaining('exceeds'),
    });
    expect(client.getStatus()).toMatchObject({ state: 'rejected', unverifiedAdmissions: 0 });

    const connection = {};
    const serverChannel = createServerChannel(connection);
    const server = createRuntimeTopologyServerHandshake({ runtimePlan: contracts.node, policy: 'required' });
    server.handleChannel(serverChannel);
    serverChannel.emit(oversizedPayload);

    expect(parseFrame(serverChannel.sent[1])).toMatchObject({
      status: 'rejected',
      error: {
        code: 'HANDSHAKE_INVALID_PAYLOAD',
        message: expect.stringContaining('exceeds'),
      },
    });
    expect(server.admitRPC(connection)).toEqual({
      accepted: false,
      reason: 'runtime topology handshake rejected',
    });
  });

  it('quick-rejects an oversized UTF-16 string before exact UTF-8 encoding', async () => {
    expect.hasAssertions();
    const contracts = createRuntimeContracts();
    const channel = new ManualHandshakeChannel();
    const client = createRuntimeTopologyClientPreflight({ runtimePlan: contracts.browser, policy: 'compatible' });
    const oversizedUtf16 = 'x'.repeat(RUNTIME_TOPOLOGY_HANDSHAKE_MAX_PAYLOAD_BYTES + 1);
    const encodeSpy = jest.spyOn(TextEncoder.prototype, 'encode');

    try {
      await expect(client.run(channel, async () => channel.emit(oversizedUtf16))).rejects.toMatchObject({
        name: 'RuntimeTopologyHandshakeError',
        code: 'HANDSHAKE_INVALID_PAYLOAD',
        message: expect.stringContaining('exceeds'),
      });
      expect(encodeSpy).not.toHaveBeenCalled();
      expect(client.getStatus()).toMatchObject({
        state: 'rejected',
        lastRejectionCode: 'HANDSHAKE_INVALID_PAYLOAD',
      });
    } finally {
      encodeSpy.mockRestore();
    }
  });

  it('times out the whole handshake when logical-channel open never resolves', async () => {
    expect.hasAssertions();
    jest.useFakeTimers();
    try {
      const channel = new ManualHandshakeChannel();
      const client = createRuntimeTopologyClientPreflight({
        runtimePlan: createRuntimeContract('browser'),
        policy: 'required',
        timeoutMs: 25,
      });
      const runPromise = client.run(channel, () => new Promise<void>(() => undefined));
      void runPromise.catch(() => undefined);

      await Promise.resolve();
      expect(client.getStatus()).toMatchObject({
        state: 'pending',
        attempts: 1,
        lastAttemptAt: expect.any(String),
      });
      jest.advanceTimersByTime(24);
      await Promise.resolve();
      expect(client.getStatus().state).toBe('pending');

      jest.advanceTimersByTime(1);
      await expect(runPromise).rejects.toMatchObject({
        name: 'RuntimeTopologyHandshakeError',
        code: 'HANDSHAKE_TIMEOUT',
        message: 'Runtime topology handshake timed out after 25ms',
        correlationId: undefined,
      });
      expect(channel.sent).toEqual([]);
      expect(client.getStatus()).toMatchObject({
        state: 'rejected',
        attempts: 1,
        rejectedAdmissions: 1,
        lastCorrelationId: undefined,
        lastRejectionCode: 'HANDSHAKE_TIMEOUT',
        lastRejection: 'Runtime topology handshake timed out after 25ms',
      });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('times out while waiting for a result after validation', async () => {
    expect.hasAssertions();
    jest.useFakeTimers();
    try {
      const contracts = createRuntimeContracts();
      const channel = new ManualHandshakeChannel();
      const client = createRuntimeTopologyClientPreflight({
        runtimePlan: contracts.browser,
        policy: 'required',
        timeoutMs: 25,
      });
      const runPromise = client.run(channel, async () => channel.emit(JSON.stringify(createHello(contracts.node))));
      void runPromise.catch(() => undefined);

      await waitFor(() => channel.sent.length === 1);
      expect(channel.sent.map((content) => parseFrame(content).type)).toEqual(['validate']);
      jest.advanceTimersByTime(24);
      await Promise.resolve();
      expect(client.getStatus().state).toBe('pending');

      jest.advanceTimersByTime(1);
      await expect(runPromise).rejects.toMatchObject({
        name: 'RuntimeTopologyHandshakeError',
        code: 'HANDSHAKE_TIMEOUT',
        correlationId: validNonce,
      });
      expect(client.getStatus()).toMatchObject({
        state: 'rejected',
        rejectedAdmissions: 1,
        lastCorrelationId: validNonce,
        lastRejectionCode: 'HANDSHAKE_TIMEOUT',
        lastRejection: 'Runtime topology handshake timed out after 25ms',
      });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });
});
