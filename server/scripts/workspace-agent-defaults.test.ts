import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { configureWorkspaceAgentDefaultModes, hasRunnableWorkspaceAgentPackage } from '../src/workspace-agent-defaults';

function currentTarget(): { goos: string; goarch: string } {
  return {
    goos: process.platform === 'win32' ? 'windows' : process.platform,
    goarch: process.arch === 'x64' ? 'amd64' : process.arch,
  };
}

describe('Workspace Agent default rollout', () => {
  it('keeps default and explicit Node modes independent from native artifacts', () => {
    for (const artifactAvailable of [false, true]) {
      for (const runtimeMode of [undefined, 'node']) {
        const node: NodeJS.ProcessEnv = { OPENSUMI_RUNTIME_MODE: runtimeMode };
        assert.equal(configureWorkspaceAgentDefaultModes(node, artifactAvailable), false);
        assert.equal(node.OPENSUMI_WORKSPACE_AGENT_WATCH_MODE, 'off');
        assert.equal(node.OPENSUMI_WORKSPACE_AGENT_SEARCH_MODE, 'off');
        assert.equal(node.OPENSUMI_WORKSPACE_AGENT_FILE_SEARCH_MODE, 'off');
      }
    }
  });

  it('requires native artifacts only when hybrid mode is selected', () => {
    assert.throws(
      () => configureWorkspaceAgentDefaultModes({ OPENSUMI_RUNTIME_MODE: 'hybrid' }, false),
      /native package is missing/,
    );
    const hybrid: NodeJS.ProcessEnv = { OPENSUMI_RUNTIME_MODE: 'hybrid' };
    assert.equal(configureWorkspaceAgentDefaultModes(hybrid, true), true);
    assert.equal(hybrid.OPENSUMI_WORKSPACE_AGENT_WATCH_MODE, 'enabled');
    assert.equal(hybrid.OPENSUMI_WORKSPACE_AGENT_SEARCH_MODE, 'enabled');
    assert.equal(hybrid.OPENSUMI_WORKSPACE_AGENT_FILE_SEARCH_MODE, 'enabled');
  });

  it('preserves per-service overrides and supports a master opt-out', () => {
    const overridden: NodeJS.ProcessEnv = {
      OPENSUMI_RUNTIME_MODE: 'hybrid',
      OPENSUMI_WORKSPACE_AGENT_WATCH_MODE: 'off',
      OPENSUMI_WORKSPACE_AGENT_SEARCH_MODE: 'shadow-read',
    };
    assert.equal(configureWorkspaceAgentDefaultModes(overridden, true), true);
    assert.equal(overridden.OPENSUMI_WORKSPACE_AGENT_WATCH_MODE, 'off');
    assert.equal(overridden.OPENSUMI_WORKSPACE_AGENT_SEARCH_MODE, 'shadow-read');
    assert.equal(overridden.OPENSUMI_WORKSPACE_AGENT_FILE_SEARCH_MODE, 'enabled');

    const optedOut: NodeJS.ProcessEnv = { OPENSUMI_RUNTIME_MODE: 'hybrid', OPENSUMI_WORKSPACE_AGENT_AUTO_MODE: 'off' };
    assert.equal(configureWorkspaceAgentDefaultModes(optedOut, true), false);
    assert.equal(optedOut.OPENSUMI_WORKSPACE_AGENT_WATCH_MODE, 'off');
  });

  it('rejects mistyped modes, contradictory modes and shadow event streams', () => {
    for (const environment of [
      { OPENSUMI_RUNTIME_MODE: 'typo' },
      { OPENSUMI_WORKSPACE_AGENT_SEARCH_MODE: 'typo' },
      { OPENSUMI_WORKSPACE_AGENT_WATCH_MODE: 'shadow-read' },
      { OPENSUMI_RUNTIME_MODE: 'node', OPENSUMI_WORKSPACE_AGENT_SEARCH_MODE: 'enabled' },
    ]) {
      assert.throws(() => configureWorkspaceAgentDefaultModes(environment, true));
    }
  });

  it('requires a valid native production package before automatic rollout', async () => {
    const rootDirectory = await mkdtemp(path.join(tmpdir(), 'opensumi-agent-defaults-'));
    try {
      const binaryName = process.platform === 'win32' ? 'workspace-agent.exe' : 'workspace-agent';
      const packageDirectory = path.join(rootDirectory, 'server/dist/workspace-agent');
      const binaryPath = path.join(packageDirectory, binaryName);
      await mkdir(packageDirectory, { recursive: true });
      assert.equal(hasRunnableWorkspaceAgentPackage(rootDirectory, { NODE_ENV: 'production' }), false);

      const binary = Buffer.from('workspace-agent-test-binary');
      await writeFile(binaryPath, binary);
      await writeFile(
        path.join(packageDirectory, 'workspace-agent.manifest.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          protocolMajor: 1,
          protocolMinor: 1,
          services: ['workspace.watch.v1', 'workspace.search.v1', 'workspace.fileSearch.v1'],
          ...currentTarget(),
          revision: 'test-revision',
          binary: binaryName,
          sha256: createHash('sha256').update(binary).digest('hex'),
          nativeStartupVerified: true,
        })}\n`,
      );
      assert.equal(hasRunnableWorkspaceAgentPackage(rootDirectory, { NODE_ENV: 'production' }), true);

      await writeFile(
        path.join(packageDirectory, 'workspace-agent.manifest.json'),
        `${JSON.stringify({
          schemaVersion: 1,
          protocolMajor: 1,
          protocolMinor: 1,
          services: ['workspace.watch.v1', 'workspace.search.v1', 'workspace.fileSearch.v1'],
          ...currentTarget(),
          revision: 'cross-built',
          binary: binaryName,
          sha256: createHash('sha256').update(binary).digest('hex'),
          nativeStartupVerified: false,
        })}\n`,
      );
      assert.equal(hasRunnableWorkspaceAgentPackage(rootDirectory, { NODE_ENV: 'production' }), false);

      await writeFile(binaryPath, 'tampered');
      assert.equal(hasRunnableWorkspaceAgentPackage(rootDirectory, { NODE_ENV: 'production' }), false);
    } finally {
      await rm(rootDirectory, { force: true, recursive: true });
    }
  });
});
