import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { hasRunnableWsGatewayPackage, resolveWsGatewayMode } from '../src/ws-gateway-defaults';

function currentTarget(): { goos: string; goarch: string } {
  return {
    goos: process.platform === 'win32' ? 'windows' : process.platform,
    goarch: process.arch === 'x64' ? 'amd64' : process.arch,
  };
}

describe('WS Gateway mode resolution', () => {
  it('treats explicit enable values as a hard gateway requirement', () => {
    for (const raw of ['1', 'enabled', 'ENABLED']) {
      assert.deepEqual(resolveWsGatewayMode({ OPENSUMI_RUNTIME_MODE: 'hybrid', OPENSUMI_WS_GATEWAY_MODE: raw }, true), {
        mode: 'gateway',
        source: 'explicit',
      });
      assert.throws(
        () => resolveWsGatewayMode({ OPENSUMI_RUNTIME_MODE: 'hybrid', OPENSUMI_WS_GATEWAY_MODE: raw }, false),
        /native package is missing/,
      );
    }
  });

  it('supports explicit direct mode and rejects unknown values', () => {
    for (const raw of ['0', 'off', 'disabled']) {
      assert.deepEqual(resolveWsGatewayMode({ OPENSUMI_WS_GATEWAY_MODE: raw }, true), {
        mode: 'direct',
        source: 'explicit',
      });
    }
    assert.throws(() => resolveWsGatewayMode({ OPENSUMI_WS_GATEWAY_MODE: 'banana' }, true), /must be enabled or off/);
  });

  it('keeps the selected runtime stable regardless of artifacts', () => {
    for (const available of [true, false]) {
      assert.deepEqual(resolveWsGatewayMode({}, available), { mode: 'direct', source: 'default' });
    }
    assert.deepEqual(resolveWsGatewayMode({ OPENSUMI_RUNTIME_MODE: 'hybrid' }, true), {
      mode: 'gateway',
      source: 'default',
    });
    assert.throws(() => resolveWsGatewayMode({ OPENSUMI_RUNTIME_MODE: 'hybrid' }, false), /native package is missing/);
    for (const available of [true, false]) {
      assert.deepEqual(resolveWsGatewayMode({ OPENSUMI_RUNTIME_MODE: 'node' }, available), {
        mode: 'direct',
        source: 'default',
      });
    }
    assert.throws(
      () => resolveWsGatewayMode({ OPENSUMI_RUNTIME_MODE: 'node', OPENSUMI_WS_GATEWAY_MODE: 'enabled' }, true),
      /conflicts/,
    );
  });
});

describe('WS Gateway package detection', () => {
  it('requires no manifest for a development binary', async () => {
    const rootDirectory = await mkdtemp(path.join(tmpdir(), 'opensumi-gateway-defaults-'));
    try {
      const binaryName = process.platform === 'win32' ? 'ws-gateway.exe' : 'ws-gateway';
      const binaryDirectory = path.join(rootDirectory, 'go/workspace-agent/bin');
      await mkdir(binaryDirectory, { recursive: true });
      assert.equal(hasRunnableWsGatewayPackage(rootDirectory, {}), false);

      await writeFile(path.join(binaryDirectory, binaryName), 'ws-gateway-test-binary');
      assert.equal(hasRunnableWsGatewayPackage(rootDirectory, {}), true);
    } finally {
      await rm(rootDirectory, { force: true, recursive: true });
    }
  });

  it('requires a valid production package and rejects cross-built or tampered binaries', async () => {
    const rootDirectory = await mkdtemp(path.join(tmpdir(), 'opensumi-gateway-defaults-'));
    try {
      const binaryName = process.platform === 'win32' ? 'ws-gateway.exe' : 'ws-gateway';
      const packageDirectory = path.join(rootDirectory, 'server/dist/workspace-agent');
      const binaryPath = path.join(packageDirectory, binaryName);
      await mkdir(packageDirectory, { recursive: true });
      const production: NodeJS.ProcessEnv = { NODE_ENV: 'production' };
      assert.equal(hasRunnableWsGatewayPackage(rootDirectory, production), false);

      const binary = Buffer.from('ws-gateway-test-binary');
      const manifest = {
        schemaVersion: 1,
        protocol: 'opensumi-ws-bridge-v1',
        revision: 'test-revision',
        binary: binaryName,
        sha256: createHash('sha256').update(binary).digest('hex'),
        ...currentTarget(),
      };
      await writeFile(binaryPath, binary);
      await writeFile(path.join(packageDirectory, 'ws-gateway.manifest.json'), `${JSON.stringify(manifest)}\n`);
      assert.equal(hasRunnableWsGatewayPackage(rootDirectory, production), true);

      await writeFile(
        path.join(packageDirectory, 'ws-gateway.manifest.json'),
        `${JSON.stringify({ ...manifest, goarch: manifest.goarch === 'amd64' ? 'arm64' : 'amd64' })}\n`,
      );
      assert.equal(hasRunnableWsGatewayPackage(rootDirectory, production), false);

      await writeFile(path.join(packageDirectory, 'ws-gateway.manifest.json'), `${JSON.stringify(manifest)}\n`);
      await writeFile(binaryPath, 'tampered');
      assert.equal(hasRunnableWsGatewayPackage(rootDirectory, production), false);
    } finally {
      await rm(rootDirectory, { force: true, recursive: true });
    }
  });

  it('honors OPENSUMI_WS_GATEWAY_PATH as the only candidate', async () => {
    const rootDirectory = await mkdtemp(path.join(tmpdir(), 'opensumi-gateway-defaults-'));
    try {
      const binaryName = process.platform === 'win32' ? 'ws-gateway.exe' : 'ws-gateway';
      const binaryDirectory = path.join(rootDirectory, 'custom/bin');
      await mkdir(binaryDirectory, { recursive: true });
      const binaryPath = path.join(binaryDirectory, binaryName);
      const binary = Buffer.from('ws-gateway-test-binary');
      await writeFile(binaryPath, binary);
      assert.equal(hasRunnableWsGatewayPackage(rootDirectory, { OPENSUMI_WS_GATEWAY_PATH: binaryPath }), true);

      await writeFile(path.join(binaryDirectory, 'ws-gateway.manifest.json'), 'not-json');
      assert.equal(hasRunnableWsGatewayPackage(rootDirectory, { OPENSUMI_WS_GATEWAY_PATH: binaryPath }), false);

      assert.equal(
        hasRunnableWsGatewayPackage(rootDirectory, { OPENSUMI_WS_GATEWAY_PATH: path.join(rootDirectory, 'missing') }),
        false,
      );
    } finally {
      await rm(rootDirectory, { force: true, recursive: true });
    }
  });
});
