import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import Koa from 'koa';

import {
  createClientStaticMiddleware,
  createRuntimeShutdownCoordinator,
  createWorkspaceIdentityMiddleware,
  listenHTTPServerForRuntime,
  resolveServedWorkspace,
  shouldClearRuntimeHardDeadline,
} from '../src/start-server';

import type { ServerRuntimeState, ServerRuntimeStopOptions, ServerRuntimeStopReport } from '@opensumi/ide-core-node';

test('HTML and unversioned assets revalidate while content-hashed assets can be cached', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'opensumi-static-cache-'));
  const app = new Koa();
  app.use(createClientStaticMiddleware(directory));
  const server = http.createServer(app.callback());
  try {
    for (const filename of ['index.html', 'bundle.js', 'main.1234abcd.js', 'main.1234abcd.css']) {
      await writeFile(path.join(directory, filename), 'first release');
    }
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    for (const route of ['/', '/index.html', '/bundle.js', '/main.1234abcd.js', '/main.1234abcd.css']) {
      const response = await fetch(base + route);
      assert.equal(response.status, 200);
      assert.equal(
        response.headers.get('cache-control'),
        route.includes('1234abcd') ? 'public, max-age=2592000, immutable' : 'no-cache',
      );
      assert.equal(await response.text(), 'first release');
    }
    await writeFile(path.join(directory, 'index.html'), 'second release');
    assert.equal(await (await fetch(base)).text(), 'second release');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('one-workspace server declares its directory in HTML independently of URL input', async () => {
  assert.equal(resolveServedWorkspace({ MY_WORKSPACE: '/developer/project' }), undefined);
  assert.deepEqual(resolveServedWorkspace({ WORKSPACE_DIR: '/workspace/project', WORKSPACE_ID: 'ws-1' }), {
    directory: '/workspace/project',
    id: 'ws-1',
  });
  const directory = await mkdtemp(path.join(os.tmpdir(), 'opensumi-workspace-html-'));
  const app = new Koa();
  app.use(createWorkspaceIdentityMiddleware(directory, { id: 'ws-1', directory: '/workspace/project' }));
  app.use(createClientStaticMiddleware(directory));
  const server = http.createServer(app.callback());
  try {
    await writeFile(path.join(directory, 'index.html'), '<html><head></head><body>IDE</body></html>');
    await writeFile(path.join(directory, 'asset.js'), 'asset');
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const html = await fetch(base + '/index.html?workspaceDir=/tmp/other');
    const source = await html.text();
    assert.equal(html.headers.get('cache-control'), 'no-cache');
    assert.match(source, /"workspaceDir":"\/workspace\/project"/);
    assert.ok(!source.includes('/tmp/other'));
    assert.equal(await (await fetch(base + '/asset.js')).text(), 'asset');
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

function completedStopReport(reason: string): ServerRuntimeStopReport {
  const timestamp = Date.now();
  return {
    reason,
    startedAt: timestamp,
    finishedAt: timestamp,
    durationMs: 0,
    deadlineMs: 1_000,
    timedOut: false,
    activeConnections: 0,
    phases: [],
  };
}

test('the product hard deadline is cleared only after every runtime owner phase completed', () => {
  const completed = completedStopReport('SIGTERM');
  const timestamp = Date.now();
  const failed: ServerRuntimeStopReport = {
    ...completed,
    phases: [
      {
        phase: 'connections',
        status: 'failed',
        startedAt: timestamp,
        finishedAt: timestamp,
        durationMs: 0,
        error: { name: 'Error', message: 'connection cleanup failed' },
      },
    ],
  };

  assert.equal(shouldClearRuntimeHardDeadline(completed, false), true);
  assert.equal(shouldClearRuntimeHardDeadline(failed, false), false);
  assert.equal(shouldClearRuntimeHardDeadline(completed, true), false);
});

test('late HTTP listener is closed when runtime shutdown wins the startup race', async () => {
  const server = http.createServer();
  let runtimeState: ServerRuntimeState = 'running';
  let observedListening = false;

  server.once('listening', () => {
    observedListening = server.listening;
    runtimeState = 'stopping';
  });

  try {
    await assert.rejects(
      listenHTTPServerForRuntime(server, { host: '127.0.0.1', port: 0 }, () => runtimeState),
      (error: unknown) => {
        assert.equal((error as Error).name, 'ServerRuntimeStartupCancelledError');
        assert.match((error as Error).message, /runtime was stopping/);
        return true;
      },
    );

    assert.equal(observedListening, true, 'the HTTP listener must have become active before cancellation');
    assert.equal(server.listening, false, 'startup cancellation must close the late HTTP listener');
    assert.equal(server.address(), null);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => (error ? reject(error) : resolve()));
      });
    }
  }
});

test('late-listener cleanup resets when the same HTTP server starts a second listen epoch', async () => {
  const server = http.createServer();
  let runtimeState: ServerRuntimeState = 'stopping';

  try {
    await assert.rejects(
      listenHTTPServerForRuntime(server, { host: '127.0.0.1', port: 0 }, () => runtimeState),
      /startup was cancelled/,
    );
    assert.equal(server.listening, false);

    runtimeState = 'running';
    server.once('listening', () => {
      runtimeState = 'stopping';
    });
    await assert.rejects(
      listenHTTPServerForRuntime(server, { host: '127.0.0.1', port: 0 }, () => runtimeState),
      /startup was cancelled/,
    );

    assert.equal(server.listening, false, 'the reused server must close its second listener, not its old epoch');
    assert.equal(server.address(), null);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => (error ? reject(error) : resolve()));
      });
    }
  }
});

test('gateway shutdown requests readiness drain, fences private Node ingress, and stops the gateway last', async () => {
  const events: string[] = [];
  const httpServer = http.createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address !== 'string');
  httpServer.once('close', () => events.push('http-closed'));

  let finishActiveRPC!: () => void;
  const activeRPC = new Promise<void>((resolve) => {
    finishActiveRPC = resolve;
  });
  let nodeAccepting = true;
  const report = completedStopReport('SIGTERM');
  const serverApp = {
    drain: () => {
      events.push('server-app-drain');
      nodeAccepting = false;
      return Promise.resolve();
    },
    stop: async (options: ServerRuntimeStopOptions) => {
      events.push(`server-app-stop:${options.reason}`);
      assert.equal(options.deadlineMs, 1_000);
      await activeRPC;
      events.push('active-rpc-finished');
      await options.beforeSharedOwners?.();
      return report;
    },
  };
  let gatewayReadinessAccepting = true;
  let gatewayStopCalls = 0;
  let gateway:
    | {
        beginDrain(): void;
        stop(): Promise<void>;
      }
    | undefined;
  const shutdown = createRuntimeShutdownCoordinator({
    serverApp,
    httpServer,
    getWsGatewayRuntime: () => gateway,
    deadlineMs: 1_000,
    now: () => 100,
  });
  gateway = {
    beginDrain: () => {
      events.push('gateway-drain');
      gatewayReadinessAccepting = false;
    },
    stop: async () => {
      gatewayStopCalls += 1;
      events.push('gateway-stop');
    },
  };

  const firstShutdown = shutdown('SIGTERM');
  gateway = undefined;
  assert.equal(shutdown('ignored-repeat'), firstShutdown);
  assert.equal(gatewayReadinessAccepting, false, 'gateway readiness drain must be requested synchronously');
  assert.equal(nodeAccepting, false, 'Node connection admission must close synchronously');
  assert.equal(httpServer.listening, false, 'the private Node HTTP listener must be fenced synchronously');
  assert.equal(gatewayStopCalls, 0, 'gateway transport must survive while an admitted RPC is active');

  await new Promise<void>((resolve, reject) => {
    const lateIngress = net.connect(address.port, '127.0.0.1');
    lateIngress.once('connect', () => {
      lateIngress.destroy();
      reject(new Error('private HTTP listener accepted ingress after drain'));
    });
    lateIngress.once('error', () => resolve());
  });
  assert.equal(gatewayStopCalls, 0);

  finishActiveRPC();
  assert.equal(await firstShutdown, report);
  assert.equal(await shutdown('another-repeat'), report);
  assert.equal(gatewayStopCalls, 1);
  assert.deepEqual(events, [
    'gateway-drain',
    'server-app-drain',
    'server-app-stop:SIGTERM',
    'http-closed',
    'active-rpc-finished',
    'gateway-stop',
  ]);
});

test('gateway waits for an already-closing active private HTTP request before disposing shared owners', async () => {
  const events: string[] = [];
  let finishRequest!: () => void;
  const requestRelease = new Promise<void>((resolve) => {
    finishRequest = resolve;
  });
  let markRequestStarted!: () => void;
  const requestStarted = new Promise<void>((resolve) => {
    markRequestStarted = resolve;
  });
  const httpServer = http.createServer(async (_request, response) => {
    events.push('private-request-started');
    markRequestStarted();
    response.setHeader('Connection', 'close');
    await requestRelease;
    events.push('private-request-finished');
    response.end('ok');
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address !== 'string');
  httpServer.once('close', () => events.push('http-closed'));

  const responseFinished = new Promise<void>((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port: address.port, path: '/' }, (response) => {
      response.resume();
      response.once('end', resolve);
    });
    request.once('error', reject);
  });
  await requestStarted;

  const report = completedStopReport('SIGTERM');
  const shutdown = createRuntimeShutdownCoordinator({
    serverApp: {
      drain: async () => {
        events.push('server-app-drain');
      },
      stop: async (options) => {
        events.push('server-app-stop');
        await options.beforeSharedOwners?.();
        events.push('shared-owners-disposed');
        return report;
      },
    },
    httpServer,
    wsGatewayRuntime: {
      beginDrain: () => events.push('gateway-drain'),
      stop: async () => {
        events.push('gateway-stop');
      },
    },
    deadlineMs: 1_000,
  });

  httpServer.close();
  assert.equal(httpServer.listening, false, 'the external close has started but its active request is not idle');
  const shutdownResult = shutdown('SIGTERM');
  await Promise.resolve();
  assert.equal(httpServer.listening, false, 'new private HTTP requests are fenced immediately');
  assert.equal(events.includes('shared-owners-disposed'), false);

  finishRequest();
  await responseFinished;
  assert.equal(await shutdownResult, report);
  assert.ok(events.indexOf('private-request-finished') < events.indexOf('http-closed'));
  assert.ok(events.indexOf('http-closed') < events.indexOf('shared-owners-disposed'));
  assert.ok(events.indexOf('shared-owners-disposed') < events.indexOf('gateway-stop'));
});

test('timed-out ServerApp work keeps the final gateway transport alive for the product hard deadline', async () => {
  const httpServer = http.createServer();
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const timestamp = Date.now();
  const timedOutReport: ServerRuntimeStopReport = {
    reason: 'startup-failure',
    startedAt: timestamp,
    finishedAt: timestamp,
    durationMs: 0,
    deadlineMs: 0,
    timedOut: true,
    activeConnections: 1,
    phases: [
      {
        phase: 'server',
        status: 'timed_out',
        startedAt: timestamp,
        finishedAt: timestamp,
        durationMs: 0,
      },
    ],
  };
  let gatewayStopCalls = 0;
  const shutdown = createRuntimeShutdownCoordinator({
    serverApp: {
      drain: () => Promise.resolve(),
      stop: async () => timedOutReport,
    },
    httpServer,
    wsGatewayRuntime: {
      beginDrain: () => undefined,
      stop: async () => {
        gatewayStopCalls += 1;
      },
    },
    deadlineMs: 0,
  });

  assert.equal(await shutdown('startup-failure'), timedOutReport);
  assert.equal(gatewayStopCalls, 0, 'an un-cancellable timed-out owner must not overlap gateway destruction');
  assert.equal(httpServer.listening, false);
});
