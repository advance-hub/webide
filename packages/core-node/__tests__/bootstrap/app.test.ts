import http from 'http';
import net from 'net';
import path from 'path';

import Koa from 'koa';
import WS from 'ws';

import { Injectable } from '@opensumi/di';
import { WSChannel } from '@opensumi/ide-connection';
import { normalizedIpcHandlerPath } from '@opensumi/ide-core-common/node/ipc';
import {
  Deferred,
  Domain,
  ILogServiceManager,
  INodeLogger,
  IServerConnectionRegistry,
  NodeModule,
  ServerApp,
  ServerAppContribution,
  ServerCommonModule,
  ServerConnectionRegistry,
} from '@opensumi/ide-core-node';
import { createNodeInjector } from '@opensumi/ide-dev-tool/injector';
import { MockInjector } from '@opensumi/ide-dev-tool/injector';

describe('ServerApp', () => {
  let injector: MockInjector;
  const mockNodeLogger = {
    log: jest.fn(),
  };

  beforeAll(() => {
    injector = createNodeInjector([]);
    injector.addProviders(
      {
        token: INodeLogger,
        useValue: mockNodeLogger,
      },
      {
        token: ILogServiceManager,
        useValue: {
          getLogger: () => console,
        },
      },
    );
  });

  afterAll(async () => {
    await injector.disposeAll();
  });

  test('start net server', async () => {
    expect.hasAssertions();
    const deferred = new Deferred();
    const rpcListenPath = normalizedIpcHandlerPath('NODE-TEST', true);
    const app = new ServerApp({
      injector,
      modules: [ServerCommonModule],
      webSocketHandler: [],
      logDir: path.join(__dirname, 'logs'),
      processCloseExitThreshold: 0,
    });
    const server = net.createServer();

    // server 的 connection 事件在测试环境下无法正常发送，只能跑一下执行
    server.listen(rpcListenPath, () => {
      server.close(() => {
        deferred.resolve();
      });
    });

    await app.start(server);
    await deferred.promise;
    expect(app.state).toBe('running');
  });

  test('start http server', async () => {
    expect.hasAssertions();
    const deferred = new Deferred();

    const koa = new Koa();
    const app = new ServerApp({
      injector,
      modules: [ServerCommonModule],
      use: koa.use.bind(koa),
      webSocketHandler: [],
      logDir: path.join(__dirname, 'logs'),
      processCloseExitThreshold: 0,
    });
    const server = http.createServer(koa.callback());

    // server 的 connection 事件在测试环境下无法正常发送，只能跑一下执行
    server.listen(0, () => {
      server.close(() => {
        deferred.resolve();
      });
    });
    await app.start(server);
    await deferred.promise;
    expect(app.state).toBe('running');
  });

  test('keeps standalone signal handling by default and lets products own it explicitly', async () => {
    expect.hasAssertions();
    const previousJestFlag = process.env.IS_JEST_TEST;
    const bindProcessHandler = jest
      .spyOn(ServerApp.prototype as any, 'bindProcessHandler')
      .mockImplementation(() => undefined);
    const bindShutdownSignalHandlers = jest
      .spyOn(ServerApp.prototype as any, 'bindShutdownSignalHandlers')
      .mockImplementation(() => undefined);
    delete process.env.IS_JEST_TEST;

    const managedInjector = createNodeInjector([]);
    const externalInjector = createNodeInjector([]);
    bindProcessHandler.mockClear();
    bindShutdownSignalHandlers.mockClear();

    try {
      new ServerApp({ injector: managedInjector });
      new ServerApp({ injector: externalInjector, processSignalHandling: 'external' });

      expect(bindProcessHandler).toHaveBeenCalledTimes(2);
      expect(bindShutdownSignalHandlers).toHaveBeenCalledTimes(1);
    } finally {
      if (previousJestFlag === undefined) {
        delete process.env.IS_JEST_TEST;
      } else {
        process.env.IS_JEST_TEST = previousJestFlag;
      }
      bindProcessHandler.mockRestore();
      bindShutdownSignalHandlers.mockRestore();
      await managedInjector.disposeAll();
      await externalInjector.disposeAll();
    }
  });

  test.each(['initialize', 'onStart'] as const)(
    'propagates required contribution %s failure and still cleans up',
    async (phase) => {
      expect.hasAssertions();
      const failure = new Error('required runtime unavailable');
      const stopped = jest.fn();
      @Domain(ServerAppContribution)
      class RequiredContribution implements ServerAppContribution {
        readonly startupRequired = true;
        initialize() {
          if (phase === 'initialize') {
            throw failure;
          }
        }
        onStart() {
          if (phase === 'onStart') {
            throw failure;
          }
        }
        onStop() {
          stopped();
        }
      }
      @Injectable()
      class RequiredModule extends NodeModule {
        providers = [RequiredContribution];
      }
      const runtimeInjector = createNodeInjector([]);
      const app = new ServerApp({ injector: runtimeInjector, modules: [RequiredModule] });
      await expect(app.start(net.createServer(), () => undefined)).rejects.toBe(failure);
      expect(app.state).toBe('failed');
      const report = await app.stop({ deadlineMs: 1_000 });
      expect(stopped).toHaveBeenCalledTimes(1);
      expect(app.state).toBe('stopped');
      expect(report.timedOut).toBe(false);
    },
  );

  test('serializes shutdown with in-flight startup and never returns to running', async () => {
    expect.hasAssertions();
    const initializationStarted = new Deferred<void>();
    const releaseInitialization = new Deferred<void>();
    const onStart = jest.fn();
    const onStop = jest.fn();

    @Domain(ServerAppContribution)
    class DeferredStartContribution implements ServerAppContribution {
      async initialize() {
        initializationStarted.resolve();
        await releaseInitialization.promise;
      }

      onStart() {
        onStart();
      }

      onStop() {
        onStop();
      }
    }

    @Injectable()
    class DeferredStartModule extends NodeModule {
      providers = [DeferredStartContribution];
    }

    const runtimeInjector = createNodeInjector([]);
    const rootDispose = jest.fn();
    const RootDisposable = Symbol('RootDisposable');
    runtimeInjector.addProviders({ token: RootDisposable, useValue: { dispose: rootDispose } });
    runtimeInjector.get(RootDisposable);

    const app = new ServerApp({ injector: runtimeInjector, modules: [DeferredStartModule] });
    const startPromise = app.start(net.createServer(), () => undefined);
    const startResult = startPromise.then(
      () => undefined,
      (error) => error,
    );
    await initializationStarted.promise;

    const stopPromise = app.stop({ deadlineMs: 1_000, reason: 'stop-during-start' });
    await Promise.resolve();
    expect(onStop).not.toHaveBeenCalled();

    releaseInitialization.resolve();
    await expect(startResult).resolves.toMatchObject({ name: 'ServerRuntimeStartupCancelledError' });
    const report = await stopPromise;

    expect(onStart).not.toHaveBeenCalled();
    expect(onStop).toHaveBeenCalledTimes(1);
    expect(rootDispose).toHaveBeenCalledTimes(1);
    expect(app.state).toBe('stopped');
    expect(report.phases.map(({ status }) => status)).toEqual(['completed', 'completed', 'completed', 'completed']);
  });

  test('stops the runtime in ownership order and returns one idempotent report', async () => {
    expect.hasAssertions();
    const events: string[] = [];
    let registryDisposed = false;

    @Domain(ServerAppContribution)
    class StopContribution implements ServerAppContribution {
      onStop() {
        events.push('contribution-stop');
      }
    }

    @Injectable()
    class LifecycleModule extends NodeModule {
      providers = [StopContribution];
    }

    const runtimeInjector = createNodeInjector([]);
    const rootDisposable = {
      dispose: jest.fn(() => {
        events.push('root-dispose');
      }),
    };
    const connectionRegistry = {
      activeConnectionCount: 0,
      beginDrain: jest.fn(() => {
        events.push('begin-drain');
      }),
      waitForIdle: jest.fn(async () => {
        events.push('wait-connections');
      }),
      dispose: jest.fn(() => {
        if (!registryDisposed) {
          registryDisposed = true;
          events.push('registry-dispose');
        }
      }),
    };
    const RootDisposable = Symbol('RootDisposable');
    runtimeInjector.addProviders(
      { token: IServerConnectionRegistry, useValue: connectionRegistry },
      { token: RootDisposable, useValue: rootDisposable },
    );
    runtimeInjector.get(RootDisposable);

    const app = new ServerApp({ injector: runtimeInjector, modules: [LifecycleModule] });
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, resolve));
    server.once('close', () => events.push('server-close'));
    await app.start(server, () => undefined);

    const firstDrain = app.drain();
    expect(app.drain()).toBe(firstDrain);
    await firstDrain;

    const stopPromise = app.stop({ deadlineMs: 1_000, reason: 'test' });
    expect(app.dispose({ deadlineMs: 1, reason: 'ignored-second-call' })).toBe(stopPromise);
    const stopReport = await stopPromise;
    const disposeReport = await app.dispose();

    expect(disposeReport).toBe(stopReport);
    expect(stopReport).toMatchObject({
      reason: 'test',
      deadlineMs: 1_000,
      timedOut: false,
      activeConnections: 0,
    });
    expect(stopReport.phases.map(({ phase, status }) => [phase, status])).toEqual([
      ['server', 'completed'],
      ['connections', 'completed'],
      ['contributions', 'completed'],
      ['injector', 'completed'],
    ]);
    expect(events).toEqual(['begin-drain', 'registry-dispose', 'server-close', 'contribution-stop', 'root-dispose']);
    expect(connectionRegistry.waitForIdle).not.toHaveBeenCalled();
    expect(app.state).toBe('stopped');
  });

  test('awaits an external owner barrier before stopping contributions and the root injector', async () => {
    expect.hasAssertions();
    const events: string[] = [];
    const barrierStarted = new Deferred<void>();
    const releaseBarrier = new Deferred<void>();

    @Domain(ServerAppContribution)
    class BarrierContribution implements ServerAppContribution {
      onStop() {
        events.push('contribution-stop');
      }
    }

    @Injectable()
    class BarrierLifecycleModule extends NodeModule {
      providers = [BarrierContribution];
    }

    const runtimeInjector = createNodeInjector([]);
    const app = new ServerApp({ injector: runtimeInjector, modules: [BarrierLifecycleModule] });
    await app.start(net.createServer(), () => undefined);

    const stopPromise = app.stop({
      deadlineMs: 1_000,
      reason: 'external-owner-barrier-test',
      beforeSharedOwners: async () => {
        events.push('external-barrier-start');
        barrierStarted.resolve();
        await releaseBarrier.promise;
        events.push('external-barrier-finished');
      },
    });
    await barrierStarted.promise;
    expect(events).toEqual(['external-barrier-start']);

    releaseBarrier.resolve();
    const report = await stopPromise;
    expect(events).toEqual(['external-barrier-start', 'external-barrier-finished', 'contribution-stop']);
    expect(report.phases.map(({ phase, status }) => [phase, status])).toEqual([
      ['server', 'completed'],
      ['connections', 'completed'],
      ['contributions', 'completed'],
      ['injector', 'completed'],
    ]);
  });

  test('starts listener close before draining an active socket and waits for final transport disposal', async () => {
    expect.hasAssertions();

    const logger = { error: jest.fn(), log: jest.fn() } as unknown as INodeLogger;
    const registry = new ServerConnectionRegistry(logger);
    const runtimeInjector = createNodeInjector([]);
    runtimeInjector.addProviders({ token: IServerConnectionRegistry, useValue: registry });
    const app = new ServerApp({ injector: runtimeInjector });
    const accepted = new Deferred<net.Socket>();
    const server = net.createServer((socket) => accepted.resolve(socket));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    await app.start(server, () => undefined);

    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP server address');
    }
    const client = net.createConnection(address.port, '127.0.0.1');
    client.on('error', () => undefined);
    const acceptedSocket = await accepted.promise;
    const inboundIdle = new Deferred<void>();
    const scopeDisposed = jest.fn();
    const transportDisposed = jest.fn(() => acceptedSocket.destroy());
    const channel = new WSChannel({ send: jest.fn() } as any, { id: 'active-listener-channel' });
    registry.trackConnection(channel, 'active-listener-client', async () => scopeDisposed(), {
      beginDrain: jest.fn(),
      whenInboundIdle: () => inboundIdle.promise,
    });
    registry.registerTransportDisposer(transportDisposed);

    let stopSettled = false;
    const stop = app.stop({ deadlineMs: 1_000, reason: 'active-listener-test' }).then((report) => {
      stopSettled = true;
      return report;
    });
    await Promise.resolve();

    expect(server.listening).toBe(false);
    expect(stopSettled).toBe(false);
    expect(scopeDisposed).not.toHaveBeenCalled();
    expect(transportDisposed).not.toHaveBeenCalled();

    inboundIdle.resolve();
    const report = await stop;

    expect(report.timedOut).toBe(false);
    expect(report.phases.map(({ status }) => status)).toEqual(['completed', 'completed', 'completed', 'completed']);
    expect(scopeDisposed).toHaveBeenCalledTimes(1);
    expect(transportDisposed).toHaveBeenCalledTimes(1);
    client.destroy();
  });

  test('stops with an active upgraded websocket instead of waiting on server.close first', async () => {
    expect.hasAssertions();

    const runtimeInjector = createNodeInjector([]);
    const app = new ServerApp({ injector: runtimeInjector, modules: [], webSocketHandler: [] });
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    await app.start(server);
    const address = server.address();
    if (!address || typeof address === 'string') {
      throw new Error('Expected a TCP server address');
    }

    const socket = new WS(`ws://127.0.0.1:${address.port}/service`);
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    const socketClosed = new Promise<void>((resolve) => socket.once('close', () => resolve()));

    const report = await app.stop({ deadlineMs: 1_000, reason: 'active-websocket-test' });
    await socketClosed;

    expect(report.timedOut).toBe(false);
    expect(report.phases.map(({ status }) => status)).toEqual(['completed', 'completed', 'completed', 'completed']);
    expect(socket.readyState).toBe(WS.CLOSED);
  });

  test('waits for naturally closing connection scopes before stopping shared contributions', async () => {
    expect.hasAssertions();
    const events: string[] = [];
    const contributionStarted = new Deferred<void>();
    const scopeDisposalStarted = new Deferred<void>();
    const releaseScopeDisposal = new Deferred<void>();

    @Domain(ServerAppContribution)
    class OrderedStopContribution implements ServerAppContribution {
      async onStop() {
        events.push('contribution-stop');
        contributionStarted.resolve();
      }
    }

    @Injectable()
    class OrderedLifecycleModule extends NodeModule {
      providers = [OrderedStopContribution];
    }

    const logger = {
      error: jest.fn(),
      log: jest.fn(),
    } as unknown as INodeLogger;
    const registry = new ServerConnectionRegistry(logger);
    const channel = new WSChannel({ send: jest.fn() } as any, { id: 'ordered-channel' });
    registry.trackConnection(channel, 'ordered-client', async () => {
      events.push('connection-dispose');
      scopeDisposalStarted.resolve();
      await releaseScopeDisposal.promise;
      events.push('connection-disposed');
    });

    const runtimeInjector = createNodeInjector([]);
    runtimeInjector.addProviders({ token: IServerConnectionRegistry, useValue: registry });
    const app = new ServerApp({ injector: runtimeInjector, modules: [OrderedLifecycleModule] });
    await app.start(net.createServer(), () => undefined);

    channel.close(1000, 'client closed');
    await scopeDisposalStarted.promise;
    const stopPromise = app.stop({ deadlineMs: 1_000, reason: 'ordered-scope-test' });
    await Promise.resolve();
    expect(events).toEqual(['connection-dispose']);

    releaseScopeDisposal.resolve();
    await contributionStarted.promise;
    const report = await stopPromise;
    expect(events).toEqual(['connection-dispose', 'connection-disposed', 'contribution-stop']);
    expect(report.phases.map(({ status }) => status)).toEqual(['completed', 'completed', 'completed', 'completed']);
  });

  test('applies the admission barrier synchronously with a zero deadline and a fake listener', async () => {
    expect.hasAssertions();
    const runtimeInjector = createNodeInjector([]);
    const events: string[] = [];
    const connectionRegistry = {
      activeConnectionCount: 0,
      beginDrain: jest.fn(() => {
        events.push('begin-drain');
        throw new Error('synthetic registry drain failure');
      }),
      dispose: jest.fn(),
    };
    runtimeInjector.addProviders({ token: IServerConnectionRegistry, useValue: connectionRegistry });

    let finishListenerClose: ((error?: Error) => void) | undefined;
    const listener = {
      listening: true,
      close: jest.fn((callback: (error?: Error) => void) => {
        events.push('listener-close-started');
        listener.listening = false;
        finishListenerClose = callback;
      }),
    } as unknown as net.Server;
    const app = new ServerApp({ injector: runtimeInjector });
    await app.start(listener, () => undefined);

    const firstStop = app.stop({ deadlineMs: 0, reason: 'zero-budget-fake-listener' });
    const repeatedStop = app.stop({ deadlineMs: 1_000, reason: 'ignored-repeat' });

    expect(app.state).toBe('stopping');
    expect(connectionRegistry.beginDrain).toHaveBeenCalledTimes(1);
    expect(listener.close).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['begin-drain', 'listener-close-started']);
    expect(repeatedStop).toBe(firstStop);

    const report = await firstStop;
    expect(report.reason).toBe('zero-budget-fake-listener');
    expect(report.phases.map(({ phase, status }) => [phase, status])).toEqual([
      ['server', 'timed_out'],
      ['connections', 'skipped'],
      ['contributions', 'skipped'],
      ['injector', 'skipped'],
    ]);
    expect(await repeatedStop).toBe(report);
    expect(app.state).toBe('failed');

    finishListenerClose?.();
    await runtimeInjector.disposeAll();
  });

  test('closes a real listening socket synchronously even when the shutdown budget is zero', async () => {
    expect.hasAssertions();
    const runtimeInjector = createNodeInjector([]);
    const connectionRegistry = {
      activeConnectionCount: 0,
      beginDrain: jest.fn(),
      dispose: jest.fn(),
    };
    runtimeInjector.addProviders({ token: IServerConnectionRegistry, useValue: connectionRegistry });
    const app = new ServerApp({ injector: runtimeInjector });
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const listenerClosed = new Promise<void>((resolve) => server.once('close', resolve));
    await app.start(server, () => undefined);

    const stopPromise = app.stop({ deadlineMs: 0, reason: 'zero-budget-real-listener' });

    expect(app.state).toBe('stopping');
    expect(server.listening).toBe(false);
    expect(server.address()).toBe(null);
    expect(connectionRegistry.beginDrain).toHaveBeenCalledTimes(1);

    const report = await stopPromise;
    expect(report.phases.map(({ status }) => status)).toEqual(['timed_out', 'skipped', 'skipped', 'skipped']);
    await listenerClosed;
    await runtimeInjector.disposeAll();
  });

  test('applies one deadline to the whole stop sequence', async () => {
    expect.hasAssertions();
    const releaseStop = new Deferred<void>();
    const events: string[] = [];

    @Domain(ServerAppContribution)
    class SlowStopContribution implements ServerAppContribution {
      async onStop() {
        events.push('contribution-stop');
        await releaseStop.promise;
        events.push('contribution-stopped');
      }
    }

    @Injectable()
    class SlowLifecycleModule extends NodeModule {
      providers = [SlowStopContribution];
    }

    const runtimeInjector = createNodeInjector([]);
    const RootDisposable = Symbol('RootDisposable');
    runtimeInjector.addProviders({
      token: RootDisposable,
      useValue: {
        dispose: () => events.push('root-dispose'),
      },
    });
    runtimeInjector.get(RootDisposable);
    const app = new ServerApp({ injector: runtimeInjector, modules: [SlowLifecycleModule] });
    const server = net.createServer();
    await app.start(server, () => undefined);

    const report = await app.stop({ deadlineMs: 10, reason: 'deadline-test' });
    releaseStop.resolve();

    expect(report.timedOut).toBe(true);
    expect(report.durationMs).toBeLessThan(250);
    expect(report.phases.find(({ phase }) => phase === 'contributions')?.status).toBe('timed_out');
    expect(report.phases.map(({ phase, status }) => [phase, status])).toEqual([
      ['server', 'completed'],
      ['connections', 'completed'],
      ['contributions', 'timed_out'],
      ['injector', 'skipped'],
    ]);
    expect(events).toEqual(['contribution-stop']);
    expect(app.state).toBe('failed');

    await releaseStop.promise;
    await Promise.resolve();
    expect(events).toEqual(['contribution-stop', 'contribution-stopped']);
    expect(await app.stop()).toBe(report);
    await runtimeInjector.disposeAll();
    expect(events).toContain('root-dispose');
  });

  test('records a start failure and still permits ordered cleanup', async () => {
    expect.hasAssertions();
    const runtimeInjector = createNodeInjector([]);
    const app = new ServerApp({ injector: runtimeInjector });
    const server = net.createServer();
    const startupError = new Error('cannot register transport');

    await expect(
      app.start(server, () => {
        throw startupError;
      }),
    ).rejects.toBe(startupError);
    expect(app.state).toBe('failed');

    const report = await app.stop({ deadlineMs: 1_000, reason: 'start-failure' });
    expect(report.timedOut).toBe(false);
    expect(report.phases.map(({ status }) => status)).toEqual(['completed', 'completed', 'completed', 'completed']);
    expect(app.state).toBe('stopped');
  });

  test('continues ordered cleanup after a settled phase failure and keeps a failed final state', async () => {
    expect.hasAssertions();
    const events: string[] = [];

    @Domain(ServerAppContribution)
    class FailingStopContribution implements ServerAppContribution {
      onStop() {
        events.push('contribution-stop');
        throw new Error('stop failed');
      }
    }

    @Injectable()
    class FailingLifecycleModule extends NodeModule {
      providers = [FailingStopContribution];
    }

    const runtimeInjector = createNodeInjector([]);
    const RootDisposable = Symbol('RootDisposable');
    runtimeInjector.addProviders({
      token: RootDisposable,
      useValue: { dispose: () => events.push('root-dispose') },
    });
    runtimeInjector.get(RootDisposable);
    const app = new ServerApp({ injector: runtimeInjector, modules: [FailingLifecycleModule] });
    await app.start(net.createServer(), () => undefined);

    const report = await app.stop({ deadlineMs: 1_000, reason: 'settled-failure' });

    expect(report.timedOut).toBe(false);
    expect(report.phases.map(({ phase, status }) => [phase, status])).toEqual([
      ['server', 'completed'],
      ['connections', 'completed'],
      ['contributions', 'failed'],
      ['injector', 'completed'],
    ]);
    expect(report.phases[2].error).toEqual({ name: 'Error', message: 'stop failed' });
    expect(events).toEqual(['contribution-stop', 'root-dispose']);
    expect(app.state).toBe('failed');
  });
});
