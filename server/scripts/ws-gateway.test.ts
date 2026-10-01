import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { WsGatewayRuntime, parseWsGatewayReadyLine, validateWsGatewayPackage } from '../src/ws-gateway';

function currentTarget(): { goos: string; goarch: string } {
  return {
    goos: process.platform === 'win32' ? 'windows' : process.platform,
    goarch: process.arch === 'x64' ? 'amd64' : process.arch,
  };
}

describe('WS Gateway launcher', () => {
  it('accepts only complete readiness announcements', () => {
    assert.deepEqual(
      parseWsGatewayReadyLine(
        JSON.stringify({
          event: 'opensumi-ws-gateway-ready',
          address: '[::]:8000',
          revision: 'test-revision',
          channelMode: 'multiplex-v1',
          directFileRPC: true,
        }),
      ),
      {
        event: 'opensumi-ws-gateway-ready',
        address: '[::]:8000',
        revision: 'test-revision',
        channelMode: 'multiplex-v1',
        directFileRPC: true,
      },
    );
    assert.equal(parseWsGatewayReadyLine('{not-json'), undefined);
    assert.equal(
      parseWsGatewayReadyLine(JSON.stringify({ event: 'workspace-agent-ready', address: ':8000' })),
      undefined,
    );
    assert.equal(
      parseWsGatewayReadyLine(
        JSON.stringify({ event: 'opensumi-ws-gateway-ready', address: ':8000', revision: 'test-revision' }),
      ),
      undefined,
    );
  });

  it('validates the packaged binary checksum and target', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'opensumi-ws-gateway-manifest-'));
    try {
      const binaryName = process.platform === 'win32' ? 'ws-gateway.exe' : 'ws-gateway';
      const binaryPath = path.join(directory, binaryName);
      const binary = Buffer.from('test-gateway-binary');
      await writeFile(binaryPath, binary);
      await writeFile(
        path.join(directory, 'ws-gateway.manifest.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          protocol: 'opensumi-ws-bridge-v1',
          ...currentTarget(),
          revision: 'test-revision',
          binary: binaryName,
          sha256: createHash('sha256').update(binary).digest('hex'),
        })}\n`,
      );

      assert.equal(validateWsGatewayPackage(binaryPath, true)?.revision, 'test-revision');
      await writeFile(binaryPath, 'tampered');
      assert.throws(() => validateWsGatewayPackage(binaryPath, true), /checksum/);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });
});

describe('WS Gateway private channel adoption', () => {
  it('enters an idempotent admission drain before final transport shutdown', async () => {
    const runtime = await WsGatewayRuntime.create();

    runtime.beginDrain();
    runtime.stopAccepting();

    assert.equal(runtime.getStatus().state, 'draining');
    assert.equal(runtime.channelServer.listening, true, 'beginDrain must preserve the existing physical listener');

    const firstStop = runtime.stop();
    assert.equal(runtime.stop(), firstStop);
    await firstStop;
    assert.equal(runtime.getStatus().state, 'stopped');
    assert.equal(runtime.channelServer.listening, false);
  });

  it('does not reopen admission when readiness arrives after drain begins', async () => {
    const runtime = await WsGatewayRuntime.create();
    try {
      runtime.beginDrain();
      const recordReadyStatus = (
        runtime as unknown as {
          recordReadyStatus(
            ready: {
              event: 'opensumi-ws-gateway-ready';
              address: string;
              revision: string;
              channelMode: 'multiplex-v1';
              directFileRPC: boolean;
            },
            options: { nodeHTTPURL: string },
            pid: number,
          ): void;
        }
      ).recordReadyStatus.bind(runtime);

      recordReadyStatus(
        {
          event: 'opensumi-ws-gateway-ready',
          address: '127.0.0.1:8000',
          revision: 'late-ready',
          channelMode: 'multiplex-v1',
          directFileRPC: false,
        },
        { nodeHTTPURL: 'http://127.0.0.1:3000' },
        1234,
      );

      assert.deepEqual(runtime.getStatus(), {
        configured: true,
        state: 'draining',
        degraded: false,
        affectsReadiness: true,
        pid: 1234,
        publicAddress: '127.0.0.1:8000',
        nodeHTTPURL: 'http://127.0.0.1:3000',
        channelTransport: runtime.getStatus().channelTransport,
        channelMode: 'multiplex-v1',
        directFileRPC: false,
        buildRevision: 'late-ready',
      });
    } finally {
      await runtime.stop();
    }
  });

  it('releases only unadopted channel sockets on startup failure', async () => {
    const runtime = await WsGatewayRuntime.create();
    try {
      const gatewayDial = net.connect(runtime.channelServer.address() as string);
      gatewayDial.on('error', () => undefined);
      await new Promise<void>((resolve) => gatewayDial.once('connect', resolve));
      const gatewayDialClosed = new Promise<void>((resolve) => gatewayDial.once('close', () => resolve()));

      runtime.discardUnadoptedChannelConnections();
      runtime.discardUnadoptedChannelConnections();

      await gatewayDialClosed;
      assert.equal(runtime.channelServer.listening, true, 'startup cleanup must not close the listener out of order');
    } finally {
      await runtime.stop();
    }
  });

  it('replays gateway connections dialed before the handler listener exists', async () => {
    const runtime = await WsGatewayRuntime.create();
    try {
      // The gateway dials immediately at startup; this client connects before
      // any "handler" listener is attached, exactly like the real gateway.
      const gatewayDial = net.connect(runtime.channelServer.address() as string);
      await new Promise<void>((resolve, reject) => {
        gatewayDial.once('connect', resolve);
        gatewayDial.once('error', reject);
      });
      gatewayDial.write('gateway-preface');
      await delay(100);

      const adopted: net.Socket[] = [];
      // ServerApp.start would register the real handler here; simulate it.
      runtime.channelServer.on('connection', (socket: net.Socket) => {
        adopted.push(socket);
        socket.on('data', () => socket.write('node-replies'));
      });
      runtime.adoptHeldChannelConnections();

      await delay(200);
      assert.equal(adopted.length, 1, 'held connection must be replayed to the handler');
      const reply = await new Promise<string>((resolve) => {
        gatewayDial.once('data', (chunk) => resolve(String(chunk)));
      });
      assert.equal(reply, 'node-replies');
      gatewayDial.destroy();
    } finally {
      await runtime.stop();
    }
  });
});
