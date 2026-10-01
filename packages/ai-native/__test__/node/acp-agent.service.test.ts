jest.mock('@opensumi/di', () => {
  const actual = jest.requireActual('@opensumi/di');
  const noopDecorator = () => () => {};
  return {
    ...actual,
    Injectable: () => (cls: any) => cls,
    Autowired: noopDecorator,
    Inject: noopDecorator,
    Optional: noopDecorator,
  };
});

import {
  ACP_SESSION_NOT_FOUND_ERROR_NAME,
  ACP_THREAD_POOL_SATURATED_ERROR_NAME,
  DEFAULT_ACP_THREAD_POOL_SIZE,
} from '@opensumi/ide-core-common';
import { INodeLogger } from '@opensumi/ide-core-node';

import { AcpAgentLifecycleContribution } from '../../src/node';
import { AcpAgentService, AcpAgentServiceToken } from '../../src/node/acp/acp-agent.service';
import { AcpThread } from '../../src/node/acp/acp-thread';

// ---- Mock dependencies ----

const mockLogger: INodeLogger = {
  log: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
  verbose: jest.fn(),
  warn: jest.fn(),
  critical: jest.fn(),
  dispose: jest.fn(),
  getLevel: jest.fn(),
  setLevel: jest.fn(),
} as unknown as INodeLogger;

const mockTerminalHandler = {
  releaseSessionTerminals: jest.fn().mockResolvedValue(undefined),
};

const mockAppConfig = {};

const mockPermissionRouting = {
  registerSession: jest.fn(),
  unregisterSession: jest.fn(),
  routePermissionRequest: jest.fn(),
  registeredSessions: new Map(),
};

const mockAgentProcessConfig = {
  agentId: 'test-agent',
  command: 'npx',
  args: ['@anthropic-ai/claude-code@latest'],
  cwd: '/test/workspace',
  env: [],
};

const SMALL_THREAD_POOL_SIZE = 3;

const mockAgentProcessConfigWithSmallPool = {
  ...mockAgentProcessConfig,
  threadPoolSize: SMALL_THREAD_POOL_SIZE,
};

// ---- Mock AcpThread factory ----

interface MockThread {
  threadId: string;
  sessionId: string;
  initialized: boolean;
  needsReset: boolean;
  initialize: jest.Mock;
  newSession: jest.Mock;
  loadSession: jest.Mock;
  loadSessionOrNew: jest.Mock;
  prompt: jest.Mock;
  cancel: jest.Mock;
  listSessions: jest.Mock;
  getEntries: jest.Mock;
  getSessionNotifications: jest.Mock;
  getSessionState: jest.Mock;
  getStatus: jest.Mock;
  setStatus: jest.Mock;
  setError: jest.Mock;
  handleNotification: jest.Mock;
  addUserMessage: jest.Mock;
  markAssistantComplete: jest.Mock;
  markToolCallWaiting: jest.Mock;
  respondToToolCall: jest.Mock;
  setSessionMode: jest.Mock;
  setSessionConfigOption: jest.Mock;
  unstable_setSessionModel: jest.Mock;
  reset: jest.Mock;
  dispose: jest.Mock;
  onEvent: jest.Mock;
  _fireEvent: (event: any) => void;
  _eventListeners: Array<(event: any) => void>;
}

function flushAsyncWork(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function createDeferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value?: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value?: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createMockThread(overrides: Record<string, any> = {}): MockThread {
  const eventListeners: Array<(event: any) => void> = [];
  const base: MockThread = {
    threadId: `thread-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: '',
    initialized: false,
    needsReset: false,
    initialize: jest.fn().mockResolvedValue({ protocolVersion: 1, agentCapabilities: {} }),
    newSession: jest.fn().mockResolvedValue({ sessionId: 'new-session-1' }),
    loadSession: jest.fn().mockResolvedValue({ sessionId: 'loaded-session-1' }),
    loadSessionOrNew: jest.fn().mockResolvedValue({ sessionId: 'new-session-1', createdByFallback: true }),
    prompt: jest.fn().mockResolvedValue({ stopReason: 'end_turn' }),
    cancel: jest.fn().mockResolvedValue(undefined),
    listSessions: jest.fn().mockResolvedValue({ sessions: [] }),
    getEntries: jest.fn().mockReturnValue([]),
    getSessionNotifications: jest.fn().mockReturnValue([]),
    getSessionState: jest.fn().mockReturnValue({
      notifications: [],
      entries: [],
      modes: [],
    }),
    getStatus: jest.fn().mockReturnValue('idle'),
    setStatus: jest.fn(),
    setError: jest.fn(),
    handleNotification: jest.fn(),
    addUserMessage: jest.fn().mockReturnValue({ id: 'msg-1', content: '', timestamp: Date.now() }),
    markAssistantComplete: jest.fn(),
    markToolCallWaiting: jest.fn(),
    respondToToolCall: jest.fn(),
    setSessionMode: jest.fn().mockResolvedValue(undefined),
    setSessionConfigOption: jest.fn().mockResolvedValue(undefined),
    unstable_setSessionModel: jest.fn().mockResolvedValue(undefined),
    reset: jest.fn(),
    dispose: jest.fn().mockResolvedValue(undefined),
    onEvent: jest.fn((cb: any) => {
      eventListeners.push(cb);
      return { dispose: jest.fn(() => {}) };
    }),
    _fireEvent(event: any) {
      eventListeners.forEach((cb) => cb(event));
    },
    _eventListeners: eventListeners,
  };
  return { ...base, ...overrides } as unknown as MockThread;
}

function setupServiceWithMockFactory(mockFactory: jest.Mock) {
  const service = new AcpAgentService();
  (service as any).threadFactory = mockFactory;
  (service as any).terminalHandler = mockTerminalHandler;
  (service as any).appConfig = mockAppConfig;
  (service as any).logger = mockLogger;
  (service as any).permissionRouting = mockPermissionRouting;
  return service;
}

function createConnectedAcpThread(connection: Record<string, unknown>): AcpThread {
  const thread = new AcpThread({
    ...mockAgentProcessConfig,
    fileSystemHandler: {} as any,
    terminalHandler: mockTerminalHandler as any,
    permissionRouting: mockPermissionRouting as any,
    logger: mockLogger,
  });
  (thread as any)._initialized = true;
  (thread as any)._connected = true;
  (thread as any)._connection = connection;
  return thread;
}

function createService(): { service: AcpAgentService; mockFactory: jest.Mock; thread: MockThread } {
  const thread = createMockThread();
  const mockFactory = jest.fn().mockReturnValue(thread);
  const service = setupServiceWithMockFactory(mockFactory);
  return { service, mockFactory, thread };
}

// Helper that fires available_commands_update immediately
function createServiceWithAutoEvents(): { service: AcpAgentService; mockFactory: jest.Mock; thread: MockThread } {
  const eventListeners: Array<(event: any) => void> = [];
  const thread = createMockThread({
    onEvent: jest.fn((cb: any) => {
      eventListeners.push(cb);
      return { dispose: jest.fn(() => {}) };
    }),
    _fireEvent(event: any) {
      eventListeners.forEach((cb) => cb(event));
    },
    _eventListeners: eventListeners,
  });
  const mockFactory = jest.fn().mockReturnValue(thread);
  const service = setupServiceWithMockFactory(mockFactory);
  return { service, mockFactory, thread };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTerminalHandler.releaseSessionTerminals.mockResolvedValue(undefined);
  jest.useRealTimers();
});

// ============================================================================
// Tests
// ============================================================================

describe('AcpAgentService (Thread Pool)', () => {
  describe('Token', () => {
    it('should export AcpAgentServiceToken as a symbol', () => {
      expect(typeof AcpAgentServiceToken).toBe('symbol');
    });
  });

  describe('warmUpAgentPool()', () => {
    it('initializes one standby thread without creating sessions', async () => {
      const threads: MockThread[] = [];
      const mockFactory = jest.fn(() => {
        const thread = createMockThread();
        thread.initialize.mockImplementation(async () => {
          thread.initialized = true;
          return { protocolVersion: 1, agentCapabilities: {} };
        });
        threads.push(thread);
        return thread;
      });
      const service = setupServiceWithMockFactory(mockFactory);

      await service.warmUpAgentPool(mockAgentProcessConfigWithSmallPool);

      expect(mockFactory).toHaveBeenCalledTimes(1);
      expect(threads.every((thread) => thread.initialize.mock.calls.length === 1)).toBe(true);
      expect(threads.every((thread) => thread.newSession.mock.calls.length === 0)).toBe(true);
      expect((service as any).threadPool).toHaveLength(1);
      expect((service as any).sessions.size).toBe(0);
    });

    it('deduplicates concurrent and repeated warmups for the same runtime config', async () => {
      const initializeGate = createDeferred<any>();
      const threads: MockThread[] = [];
      const mockFactory = jest.fn(() => {
        const thread = createMockThread();
        thread.initialize.mockImplementation(async () => {
          await initializeGate.promise;
          thread.initialized = true;
          return { protocolVersion: 1, agentCapabilities: {} };
        });
        threads.push(thread);
        return thread;
      });
      const service = setupServiceWithMockFactory(mockFactory);

      const firstWarmup = service.warmUpAgentPool(mockAgentProcessConfigWithSmallPool);
      const secondWarmup = service.warmUpAgentPool(mockAgentProcessConfigWithSmallPool);
      expect(mockFactory).toHaveBeenCalledTimes(1);

      initializeGate.resolve({ protocolVersion: 1, agentCapabilities: {} });
      await Promise.all([firstWarmup, secondWarmup]);
      await service.warmUpAgentPool(mockAgentProcessConfigWithSmallPool);

      expect(mockFactory).toHaveBeenCalledTimes(1);
      expect(threads.every((thread) => thread.initialize.mock.calls.length === 1)).toBe(true);
    });

    it('starts at most one warmup process across concurrent different runtime configurations', async () => {
      const initializeGate = createDeferred<any>();
      const thread = createMockThread();
      thread.initialize.mockImplementation(async () => {
        await initializeGate.promise;
        thread.initialized = true;
        return { protocolVersion: 1, agentCapabilities: {} };
      });
      const mockFactory = jest.fn().mockReturnValue(thread);
      const service = setupServiceWithMockFactory(mockFactory);
      const configA = { ...mockAgentProcessConfigWithSmallPool, cwd: '/workspace-a' };
      const configB = { ...mockAgentProcessConfigWithSmallPool, cwd: '/workspace-b' };

      const warmupA = service.warmUpAgentPool(configA);
      const warmupB = service.warmUpAgentPool(configB);
      await flushAsyncWork();

      expect(mockFactory).toHaveBeenCalledTimes(1);
      expect(thread.initialize).toHaveBeenCalledTimes(1);
      expect((service as any).threadPool).toEqual([thread]);

      initializeGate.resolve({ protocolVersion: 1, agentCapabilities: {} });
      await Promise.all([warmupA, warmupB]);

      expect(mockFactory).toHaveBeenCalledTimes(1);
    });

    it('lets a session claim a warming thread without replenishing another standby', async () => {
      const initializeGate = createDeferred<any>();
      const thread = createMockThread();
      thread.initialize.mockImplementation(async () => {
        await initializeGate.promise;
        thread.initialized = true;
        return { protocolVersion: 1, agentCapabilities: {} };
      });
      thread.newSession.mockImplementation(async () => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'new-session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
        return { sessionId: 'new-session-1' };
      });
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));
      const oneThreadConfig = { ...mockAgentProcessConfig, threadPoolSize: 1 };

      const warmup = service.warmUpAgentPool(oneThreadConfig);
      const session = service.createSession(oneThreadConfig);
      await flushAsyncWork();

      expect(thread.initialize).toHaveBeenCalledTimes(1);
      initializeGate.resolve({ protocolVersion: 1, agentCapabilities: {} });
      await Promise.all([warmup, session]);
      await service.warmUpAgentPool(oneThreadConfig);

      expect(thread.initialize).toHaveBeenCalledTimes(1);
      expect(thread.newSession).toHaveBeenCalledTimes(1);
      expect((service as any).threadFactory).toHaveBeenCalledTimes(1);
    });

    it('waits for and replaces an incompatible warming thread before creating a session', async () => {
      const initializeGate = createDeferred<any>();
      const warmingThread = createMockThread();
      warmingThread.initialize.mockImplementation(async () => {
        await initializeGate.promise;
        warmingThread.initialized = true;
        return { protocolVersion: 1, agentCapabilities: {} };
      });
      const sessionThread = createMockThread({
        newSession: jest.fn(async () => {
          sessionThread._fireEvent({
            type: 'session_notification',
            notification: {
              sessionId: 'workspace-b-session',
              update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
            },
          });
          return { sessionId: 'workspace-b-session' };
        }),
      });
      const mockFactory = jest.fn().mockReturnValueOnce(warmingThread).mockReturnValueOnce(sessionThread);
      const service = setupServiceWithMockFactory(mockFactory);
      const configA = { ...mockAgentProcessConfig, cwd: '/workspace-a', threadPoolSize: 1 };
      const configB = { ...mockAgentProcessConfig, cwd: '/workspace-b', threadPoolSize: 1 };

      const warmup = service.warmUpAgentPool(configA);
      let sessionSettled = false;
      const session = service.createSession(configB).finally(() => {
        sessionSettled = true;
      });
      await flushAsyncWork();

      expect(sessionSettled).toBe(false);
      expect(warmingThread.dispose).not.toHaveBeenCalled();
      expect(mockFactory).toHaveBeenCalledTimes(1);

      initializeGate.resolve({ protocolVersion: 1, agentCapabilities: {} });
      const [, result] = await Promise.all([warmup, session]);

      expect(result.sessionId).toBe('workspace-b-session');
      expect(warmingThread.dispose).toHaveBeenCalledTimes(1);
      expect(sessionThread.initialize).toHaveBeenCalledWith(expect.objectContaining({ cwd: '/workspace-b' }));
      expect((service as any).threadPool).toEqual([sessionThread]);
      expect(mockFactory).toHaveBeenCalledTimes(2);
    });

    it('gives one foreground request exclusive ownership of an incompatible warming slot', async () => {
      const initializeGate = createDeferred<any>();
      const warmingThread = createMockThread();
      warmingThread.initialize.mockImplementation(async () => {
        await initializeGate.promise;
        warmingThread.initialized = true;
        return { protocolVersion: 1, agentCapabilities: {} };
      });
      const sessionThread = createMockThread({
        newSession: jest.fn(async () => {
          sessionThread._fireEvent({
            type: 'session_notification',
            notification: {
              sessionId: 'foreground-session',
              update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
            },
          });
          return { sessionId: 'foreground-session' };
        }),
      });
      const mockFactory = jest.fn().mockReturnValueOnce(warmingThread).mockReturnValueOnce(sessionThread);
      const service = setupServiceWithMockFactory(mockFactory);
      const warmupConfig = { ...mockAgentProcessConfig, cwd: '/workspace-a', threadPoolSize: 1 };
      const foregroundConfig = { ...mockAgentProcessConfig, cwd: '/workspace-b', threadPoolSize: 1 };

      const warmup = service.warmUpAgentPool(warmupConfig);
      const firstRequest = service.createSession(foregroundConfig);
      await flushAsyncWork();

      let secondError: Error | undefined;
      try {
        await service.createSession(foregroundConfig);
      } catch (error) {
        secondError = error as Error;
      }
      expect(secondError).toBeInstanceOf(Error);
      expect(secondError!.name).toBe('ACP_THREAD_POOL_SATURATED');
      expect(secondError!.message).toContain('Thread pool is full (1)');
      expect(warmingThread.dispose).not.toHaveBeenCalled();

      initializeGate.resolve({ protocolVersion: 1, agentCapabilities: {} });
      await Promise.all([warmup, firstRequest]);

      expect(warmingThread.dispose).toHaveBeenCalledTimes(1);
      expect(sessionThread.newSession).toHaveBeenCalledTimes(1);
      expect(mockFactory).toHaveBeenCalledTimes(2);
    });

    it('disposes a failed warmup thread', async () => {
      const failedThread = createMockThread({
        initialize: jest.fn().mockRejectedValue(new Error('warmup failed')),
      });
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(failedThread));

      await service.warmUpAgentPool(mockAgentProcessConfigWithSmallPool);

      expect(failedThread.dispose).toHaveBeenCalledTimes(1);
      expect((service as any).threadPool).toEqual([]);
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('failed to initialize thread'));
    });
  });

  describe('getSessionMcpServers()', () => {
    it('should start and return the built-in OpenSumi MCP server connection descriptor', async () => {
      const { service } = createService();
      const connection = {
        name: 'opensumi-ide',
        type: 'http',
        transport: 'streamable-http',
        url: 'http://127.0.0.1:12345/mcp/token',
        redactedUrl: 'http://127.0.0.1:12345/mcp/<redacted>',
        headers: [],
      };
      const opensumiMcpHttpServer = {
        start: jest.fn().mockResolvedValue(undefined),
        getConnectionInfo: jest.fn().mockReturnValue(connection),
      };
      (service as any).opensumiMcpHttpServer = opensumiMcpHttpServer;

      await expect(service.getOpenSumiMcpServerConnection('client-full')).resolves.toBe(connection);
      expect(opensumiMcpHttpServer.start).toHaveBeenCalled();
      expect(opensumiMcpHttpServer.getConnectionInfo).toHaveBeenCalledWith('client-full');
    });

    it('should append the built-in OpenSumi MCP server when the agent supports HTTP MCP', async () => {
      const thread = createMockThread({
        agentCapabilities: {
          mcpCapabilities: {
            http: true,
            sse: true,
          },
        },
      });
      const mockFactory = jest.fn().mockReturnValue(thread);
      const service = setupServiceWithMockFactory(mockFactory);
      const opensumiMcpHttpServer = {
        getServerName: jest.fn().mockReturnValue('opensumi-ide'),
        start: jest.fn().mockResolvedValue(undefined),
        getUrl: jest.fn().mockReturnValue('http://127.0.0.1:12345/mcp/token'),
      };
      (service as any).opensumiMcpHttpServer = opensumiMcpHttpServer;

      const servers = await (service as any).getSessionMcpServers(thread, {
        ...mockAgentProcessConfig,
        mcpServers: [
          {
            name: 'external-http',
            type: 'http',
            url: 'http://127.0.0.1:9999/mcp',
            headers: [],
          },
        ],
      });

      expect(opensumiMcpHttpServer.start).toHaveBeenCalled();
      expect(servers).toEqual([
        {
          name: 'external-http',
          type: 'http',
          url: 'http://127.0.0.1:9999/mcp',
          headers: [],
        },
        {
          name: 'opensumi-ide',
          type: 'http',
          url: 'http://127.0.0.1:12345/mcp/token',
          headers: [],
        },
      ]);
    });

    it('should not append the built-in OpenSumi MCP server without HTTP MCP support', async () => {
      const thread = createMockThread({
        agentCapabilities: {
          mcpCapabilities: {
            http: false,
            sse: true,
          },
        },
      });
      const mockFactory = jest.fn().mockReturnValue(thread);
      const service = setupServiceWithMockFactory(mockFactory);
      const opensumiMcpHttpServer = {
        getServerName: jest.fn().mockReturnValue('opensumi-ide'),
        start: jest.fn().mockResolvedValue(undefined),
        getUrl: jest.fn().mockReturnValue('http://127.0.0.1:12345/mcp/token'),
      };
      (service as any).opensumiMcpHttpServer = opensumiMcpHttpServer;

      const servers = await (service as any).getSessionMcpServers(thread, {
        ...mockAgentProcessConfig,
        mcpServers: [],
      });

      expect(opensumiMcpHttpServer.start).not.toHaveBeenCalled();
      expect(servers).toEqual([]);
    });

    it('should not append the built-in OpenSumi MCP server when WebMCP is disabled', async () => {
      const thread = createMockThread({
        agentCapabilities: {
          mcpCapabilities: {
            http: true,
            sse: true,
          },
        },
      });
      const mockFactory = jest.fn().mockReturnValue(thread);
      const service = setupServiceWithMockFactory(mockFactory);
      const opensumiMcpHttpServer = {
        getServerName: jest.fn().mockReturnValue('opensumi-ide'),
        start: jest.fn().mockResolvedValue(undefined),
        getUrl: jest.fn().mockReturnValue('http://127.0.0.1:12345/mcp/token'),
      };
      (service as any).opensumiMcpHttpServer = opensumiMcpHttpServer;

      const externalServer = {
        name: 'external-http',
        type: 'http',
        url: 'http://127.0.0.1:9999/mcp',
        headers: [],
      };
      const servers = await (service as any).getSessionMcpServers(thread, {
        ...mockAgentProcessConfig,
        webMcp: {
          enabled: false,
        },
        mcpServers: [externalServer],
      });

      expect(opensumiMcpHttpServer.start).not.toHaveBeenCalled();
      expect(servers).toEqual([externalServer]);
    });
  });

  // -----------------------------------------------------------------------
  // createSession
  // -----------------------------------------------------------------------

  describe('createSession()', () => {
    it('should create a new thread, initialize, and return sessionId with availableCommands', async () => {
      const { service, thread } = createServiceWithAutoEvents();

      // Fire available_commands_update event
      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: {
              sessionUpdate: 'available_commands_update',
              availableCommands: [
                { name: 'ReadFile', description: 'Read a file' },
                { name: 'WriteFile', description: 'Write a file' },
              ],
            },
          },
        });
      }, 10);

      const result = await service.createSession(mockAgentProcessConfig);

      expect(result.sessionId).toBeDefined();
      expect(result.availableCommands).toHaveLength(2);
      expect(result.availableCommands[0].name).toBe('ReadFile');
      expect(thread.initialize).toHaveBeenCalled();
      expect(thread.newSession).toHaveBeenCalled();
    });

    it('should create a session with empty commands when available_commands_update times out', async () => {
      jest.useFakeTimers();
      const { service, thread } = createServiceWithAutoEvents();

      const resultPromise = service.createSession(mockAgentProcessConfig);
      await jest.advanceTimersByTimeAsync(5000);

      const result = await resultPromise;

      expect(result.sessionId).toBe('new-session-1');
      expect(result.availableCommands).toEqual([]);
      expect(thread.dispose).not.toHaveBeenCalled();
    });

    it('should preserve working sessions and report diagnostics when the pool is saturated', async () => {
      const { service } = createServiceWithAutoEvents();

      // Fill the pool with max threads
      const createdThreads: MockThread[] = [];
      for (let i = 0; i < SMALL_THREAD_POOL_SIZE; i++) {
        const t = createMockThread({
          getStatus: jest.fn().mockReturnValue('working'),
          newSession: jest.fn().mockResolvedValue({ sessionId: `session-${i}` }),
          onEvent: jest.fn((cb: any) => {
            setTimeout(() => {
              cb({
                type: 'session_notification',
                notification: {
                  sessionId: `session-${i}`,
                  update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
                },
              });
            }, 10);
            return { dispose: jest.fn() };
          }),
        });
        createdThreads.push(t);
        (service as any).threadFactory.mockReturnValueOnce(t);
        await service.createSession(mockAgentProcessConfigWithSmallPool);
      }

      (mockLogger.warn as jest.Mock).mockClear();
      let saturationError: Error | undefined;
      try {
        await service.createSession(mockAgentProcessConfigWithSmallPool);
      } catch (error) {
        saturationError = error as Error;
      }

      expect(saturationError).toBeInstanceOf(Error);
      expect(saturationError!.name).toBe('ACP_THREAD_POOL_SATURATED');
      expect(saturationError!.message).toContain('Thread pool is full');
      expect(createdThreads.every((thread) => thread.dispose.mock.calls.length === 0)).toBe(true);
      expect((service as any).sessions.size).toBe(SMALL_THREAD_POOL_SIZE);
      createdThreads.forEach((thread, index) => {
        expect((service as any).sessions.get(`session-${index}`)).toBe(thread);
      });
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('"warming":false'));
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('"processReusable":false'));
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('"capacityReclaimable":false'));
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('"exclusionReasons"'));
    });

    it('should recycle the least recently used reusable thread when pool is full', async () => {
      const { service, mockFactory } = createServiceWithAutoEvents();
      const threads: MockThread[] = [];

      for (let i = 0; i < 3; i++) {
        const t = createMockThread({
          threadId: `thread-${i}`,
          getStatus: jest.fn().mockReturnValue('awaiting_prompt'),
          newSession: jest.fn().mockResolvedValue({ sessionId: `session-${i}` }),
          onEvent: jest.fn((cb: any) => {
            setTimeout(() => {
              cb({
                type: 'session_notification',
                notification: {
                  sessionId: `session-${i}`,
                  update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
                },
              });
            }, 10);
            return { dispose: jest.fn() };
          }),
        });
        threads.push(t);
        mockFactory.mockReturnValueOnce(t);
        await service.createSession(mockAgentProcessConfigWithSmallPool);
      }

      threads[0].newSession.mockResolvedValueOnce({ sessionId: 'session-3' });
      const result = await service.createSession(mockAgentProcessConfigWithSmallPool);

      expect(result.sessionId).toBe('session-3');
      expect(mockFactory).toHaveBeenCalledTimes(3);
      expect(threads[0].newSession).toHaveBeenCalledTimes(2);
      expect((service as any).sessions.has('session-0')).toBe(false);
      expect((service as any).sessions.get('session-3')).toBe(threads[0]);
    });

    it('should not let loadSession reuse a thread reserved by createSession', async () => {
      const initializeGate = createDeferred<any>();
      const creatingThread = createMockThread({
        threadId: 'creating-thread',
        initialize: jest.fn().mockReturnValue(initializeGate.promise),
        newSession: jest.fn().mockResolvedValue({ sessionId: 'created-session' }),
        getStatus: jest.fn().mockReturnValue('idle'),
      });
      const loadingThread = createMockThread({
        threadId: 'loading-thread',
        getStatus: jest.fn().mockReturnValue('idle'),
        loadSession: jest.fn().mockResolvedValue({ sessionId: 'loaded-session' }),
      });
      const mockFactory = jest.fn().mockReturnValueOnce(creatingThread).mockReturnValueOnce(loadingThread);
      const service = setupServiceWithMockFactory(mockFactory);

      const createPromise = service.createSession(mockAgentProcessConfig);
      await flushAsyncWork();

      const loadPromise = service.loadSession('loaded-session', mockAgentProcessConfig);
      await flushAsyncWork();

      expect(mockFactory).toHaveBeenCalledTimes(2);
      expect((service as any).sessions.get('loaded-session')).toBe(loadingThread);
      expect(creatingThread.loadSession).not.toHaveBeenCalled();

      initializeGate.resolve({ protocolVersion: 1, agentCapabilities: {} });
      creatingThread._fireEvent({
        type: 'session_notification',
        notification: {
          sessionId: 'created-session',
          update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
        },
      });

      const [createResult, loadResult] = await Promise.all([createPromise, loadPromise]);

      expect(loadingThread.loadSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'loaded-session', cwd: mockAgentProcessConfig.cwd }),
      );
      expect(createResult.sessionId).toBe('created-session');
      expect(loadResult.sessionId).toBe('loaded-session');
      expect((service as any).sessions.get('created-session')).toBe(creatingThread);
      expect((service as any).sessions.get('loaded-session')).toBe(loadingThread);
    });

    it('should clean up on error when thread was newly created', async () => {
      const thread = createMockThread({
        onEvent: jest.fn(() => ({ dispose: jest.fn() })),
        initialize: jest.fn().mockRejectedValue(new Error('Init failed')),
      });
      const mockFactory = jest.fn().mockReturnValue(thread);
      const service = setupServiceWithMockFactory(mockFactory);

      await expect(service.createSession(mockAgentProcessConfig)).rejects.toThrow('Init failed');
      expect(thread.dispose).toHaveBeenCalled();
    });

    it('keeps a connected process reusable when newSession fails', async () => {
      const thread = createMockThread({
        onEvent: jest.fn(() => ({ dispose: jest.fn() })),
        newSession: jest.fn().mockRejectedValue(new Error('Session creation failed')),
      });
      thread.initialize.mockImplementation(async () => {
        thread.initialized = true;
        return { protocolVersion: 1, agentCapabilities: {} };
      });
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));

      await expect(service.createSession(mockAgentProcessConfig)).rejects.toThrow('Session creation failed');

      expect(thread.reset).toHaveBeenCalled();
      expect(thread.dispose).not.toHaveBeenCalled();
      expect((service as any).threadPool).toEqual([thread]);
      expect((service as any).sessions.size).toBe(0);
    });

    it('releases session resources when creation fails after receiving a session id', async () => {
      const thread = createMockThread({
        onEvent: jest.fn(() => ({ dispose: jest.fn() })),
        newSession: jest.fn().mockResolvedValue({ sessionId: 'partially-created-session' }),
        getSessionState: jest.fn(() => {
          throw new Error('Session state failed');
        }),
      });
      thread.initialize.mockImplementation(async () => {
        thread.initialized = true;
        return { protocolVersion: 1, agentCapabilities: {} };
      });
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));

      await expect(service.createSession(mockAgentProcessConfig)).rejects.toThrow('Session state failed');

      expect(mockTerminalHandler.releaseSessionTerminals).toHaveBeenCalledWith('partially-created-session');
      expect(mockPermissionRouting.unregisterSession).toHaveBeenCalledWith('partially-created-session');
      expect(thread.reset).toHaveBeenCalled();
      expect(thread.dispose).not.toHaveBeenCalled();
    });

    it('disposes a fresh replacement when its initialization fails', async () => {
      const originalThread = createMockThread({
        threadId: 'original-thread',
        getStatus: jest.fn().mockReturnValue('awaiting_prompt'),
        newSession: jest.fn(async () => {
          originalThread._fireEvent({
            type: 'session_notification',
            notification: {
              sessionId: 'session-a',
              update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
            },
          });
          return { sessionId: 'session-a' };
        }),
      });
      originalThread.initialize.mockImplementation(async () => {
        originalThread.initialized = true;
        return { protocolVersion: 1, agentCapabilities: {} };
      });
      const replacementThread = createMockThread({
        threadId: 'replacement-thread',
        initialize: jest.fn().mockRejectedValue(new Error('Replacement init failed')),
      });
      const service = setupServiceWithMockFactory(
        jest.fn().mockReturnValueOnce(originalThread).mockReturnValueOnce(replacementThread),
      );
      const configA = { ...mockAgentProcessConfig, cwd: '/workspace-a', threadPoolSize: 1 };
      const configB = { ...mockAgentProcessConfig, cwd: '/workspace-b', threadPoolSize: 1 };

      await service.createSession(configA);
      await expect(service.createSession(configB)).rejects.toThrow('Replacement init failed');

      expect(originalThread.dispose).toHaveBeenCalled();
      expect(replacementThread.dispose).toHaveBeenCalled();
      expect(replacementThread.reset).not.toHaveBeenCalled();
      expect((service as any).threadPool).toEqual([]);
    });

    it('should apply valid default mode, model, and config options after creating a session', async () => {
      jest.useFakeTimers();
      const { service, thread } = createServiceWithAutoEvents();
      thread.getSessionState.mockReturnValue({
        notifications: [],
        entries: [],
        modes: [{ id: 'plan', name: 'Plan' }],
        models: [{ modelId: 'gpt-5', name: 'GPT-5' }],
        configOptions: [
          {
            id: 'permission',
            options: [{ value: 'acceptEdits' }, { value: 'ask' }],
          },
          {
            id: 'thinking',
          },
        ],
      });

      const resultPromise = service.createSession({
        ...mockAgentProcessConfig,
        defaultMode: 'plan',
        defaultModel: 'gpt-5',
        defaultConfigOptions: {
          permission: 'acceptEdits',
          thinking: true,
        },
      });
      await jest.advanceTimersByTimeAsync(5000);
      const result = await resultPromise;

      expect(result.sessionId).toBe('new-session-1');
      expect(thread.setSessionMode).toHaveBeenCalledWith({ sessionId: 'new-session-1', modeId: 'plan' });
      expect(thread.unstable_setSessionModel).toHaveBeenCalledWith({ sessionId: 'new-session-1', model: 'gpt-5' });
      expect(thread.setSessionConfigOption).toHaveBeenCalledWith({
        sessionId: 'new-session-1',
        configId: 'permission',
        value: 'acceptEdits',
      });
      expect(thread.setSessionConfigOption).toHaveBeenCalledWith({
        sessionId: 'new-session-1',
        configId: 'thinking',
        value: true,
      });
    });

    it('should warn and continue when default session options are invalid', async () => {
      jest.useFakeTimers();
      const { service, thread } = createServiceWithAutoEvents();
      thread.getSessionState.mockReturnValue({
        notifications: [],
        entries: [],
        modes: [{ id: 'code', name: 'Code' }],
        models: [{ modelId: 'claude-sonnet', name: 'Claude Sonnet' }],
        configOptions: [
          {
            id: 'permission',
            options: [{ value: 'ask' }],
          },
        ],
      });

      const resultPromise = service.createSession({
        ...mockAgentProcessConfig,
        defaultMode: 'plan',
        defaultModel: 'gpt-5',
        defaultConfigOptions: {
          permission: 'acceptEdits',
          missing: 'value',
        },
      });
      await jest.advanceTimersByTimeAsync(5000);
      const result = await resultPromise;

      expect(result.sessionId).toBe('new-session-1');
      expect(thread.setSessionMode).not.toHaveBeenCalled();
      expect(thread.unstable_setSessionModel).not.toHaveBeenCalled();
      expect(thread.setSessionConfigOption).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Invalid defaultMode'));
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Invalid defaultModel'));
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Invalid defaultConfigOptions value'));
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('Invalid defaultConfigOptions key'));
    });
  });

  // -----------------------------------------------------------------------
  // initializeAgent
  // -----------------------------------------------------------------------

  describe('initializeAgent()', () => {
    it('should create a session and return AgentSessionInfo', async () => {
      const { service, thread } = createServiceWithAutoEvents();

      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      const result = await service.initializeAgent(mockAgentProcessConfig);

      expect(result.sessionId).toBeDefined();
      expect(result.processId).toBe(thread.threadId);
      expect(result.status).toBe('ready');
    });
  });

  // -----------------------------------------------------------------------
  // loadSession
  // -----------------------------------------------------------------------

  describe('loadSession()', () => {
    it('should return directly if session already exists in mapping', async () => {
      const { service, thread } = createServiceWithAutoEvents();

      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      const createResult = await service.createSession(mockAgentProcessConfig);
      const loadResult = await service.loadSession(createResult.sessionId, mockAgentProcessConfig);

      expect(loadResult.sessionId).toBe(createResult.sessionId);
      expect(thread.loadSession).not.toHaveBeenCalled();
    });

    it('should create new thread and load session when no idle thread', async () => {
      const thread = createMockThread({
        initialized: true,
        getStatus: jest.fn().mockReturnValue('idle'),
        onEvent: jest.fn(() => ({ dispose: jest.fn() })),
      });
      const mockFactory = jest.fn().mockReturnValue(thread);
      const service = setupServiceWithMockFactory(mockFactory);

      const result = await service.loadSession('existing-session-id', mockAgentProcessConfig);

      expect(result.sessionId).toBe('existing-session-id');
      expect(thread.loadSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'existing-session-id' }));
    });

    it('releases a late ordinary load identity exactly once after stop owns its cleanup', async () => {
      const loadSessionGate = createDeferred<{ sessionId: string }>();
      const loadSession = jest.fn(() => loadSessionGate.promise);
      const thread = new AcpThread({
        ...mockAgentProcessConfig,
        fileSystemHandler: {} as any,
        terminalHandler: mockTerminalHandler as any,
        permissionRouting: mockPermissionRouting as any,
        logger: mockLogger,
      });
      (thread as any)._initialized = true;
      (thread as any)._connected = true;
      (thread as any)._connection = { loadSession };
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));
      (service as any).stopLeaseMs = 20;
      const terminalReleaseFinished = createDeferred();
      const allowStopToClearSessions = createDeferred();
      const releasePendingTerminals = (service as any).releasePendingTerminals.bind(service);
      let releasePass = 0;
      jest.spyOn(service as any, 'releasePendingTerminals').mockImplementation(async (...args: any[]) => {
        const errors = await releasePendingTerminals(...args);
        releasePass += 1;
        if (releasePass === 1) {
          terminalReleaseFinished.resolve();
          await allowStopToClearSessions.promise;
        }
        return errors;
      });

      const loadOutcome = service.loadSession('existing-session', mockAgentProcessConfig).then(
        (result) => result,
        (error) => error as Error,
      );
      await flushAsyncWork();
      expect(loadSession).toHaveBeenCalledTimes(1);

      const disposeOutcomePromise = service.dispose().then(
        () => undefined,
        (error) => error as AggregateError,
      );
      await terminalReleaseFinished.promise;
      expect((service as any).sessions.has('existing-session')).toBe(true);
      expect((service as any).pendingTerminalReleaseIds.has('existing-session')).toBe(false);
      expect(mockTerminalHandler.releaseSessionTerminals).toHaveBeenCalledTimes(1);
      expect(mockTerminalHandler.releaseSessionTerminals).toHaveBeenCalledWith('existing-session');

      loadSessionGate.resolve({ sessionId: 'existing-session' });
      expect(await loadOutcome).toMatchObject({ name: 'AcpThreadDisposedError' });
      await flushAsyncWork();
      expect(
        mockTerminalHandler.releaseSessionTerminals.mock.calls.filter(([id]) => id === 'existing-session'),
      ).toHaveLength(1);

      allowStopToClearSessions.resolve();
      const disposeOutcome = await disposeOutcomePromise;
      expect(disposeOutcome).toBeInstanceOf(AggregateError);
      await flushAsyncWork();

      expect(
        mockTerminalHandler.releaseSessionTerminals.mock.calls.filter(([id]) => id === 'existing-session'),
      ).toHaveLength(1);
      expect((service as any).pendingTerminalReleaseIds.size).toBe(0);
      expect((service as any).sessions.size).toBe(0);
    });

    it('should return native agent replay notifications as historyUpdates', async () => {
      const nativeHistory = [
        {
          sessionId: 'existing-session-id',
          update: {
            sessionUpdate: 'tool_call_update',
            toolCallId: 'edit-1',
            status: 'completed',
            content: [{ type: 'diff', path: 'src/index.ts' }],
            rawOutput: { changedFiles: ['src/index.ts'] },
          },
        },
        {
          sessionId: 'existing-session-id',
          update: {
            sessionUpdate: 'usage_update',
            used: 120,
            size: 2000,
          },
        },
      ];
      const thread = createMockThread({
        initialized: true,
        getStatus: jest.fn().mockReturnValue('idle'),
        getSessionNotifications: jest.fn().mockReturnValue(nativeHistory),
        onEvent: jest.fn(() => ({ dispose: jest.fn() })),
      });
      const mockFactory = jest.fn().mockReturnValue(thread);
      const service = setupServiceWithMockFactory(mockFactory);

      const result = await service.loadSession('existing-session-id', mockAgentProcessConfig);

      expect(result.historyUpdates).toEqual(nativeHistory);
    });

    it('does not expose local prompt, response, tool, thought, or permission sentinels in metadata-only session restore results', async () => {
      const thread = createMockThread({
        initialized: true,
        getStatus: jest.fn().mockReturnValue('idle'),
        getEntries: jest.fn().mockReturnValue([
          {
            type: 'user_message',
            data: { id: 'msg-1', content: 'BDD_SENSITIVE_PROMPT', timestamp: 1 },
          },
          {
            type: 'agent_message',
            data: { id: 'msg-2', content: 'BDD_ASSISTANT_PART', timestamp: 2 },
          },
          {
            type: 'thought',
            data: { id: 'msg-3', content: 'BDD_THOUGHT_STEP', timestamp: 3 },
          },
          {
            type: 'tool_result',
            data: { id: 'msg-4', content: 'BDD_TOOL_RESULT', timestamp: 4 },
          },
          {
            type: 'permission',
            data: { id: 'msg-5', content: 'BDD_PERMISSION_ALLOWED', timestamp: 5 },
          },
        ]),
        getSessionNotifications: jest.fn().mockReturnValue([]),
        onEvent: jest.fn(() => ({ dispose: jest.fn() })),
      });
      const mockFactory = jest.fn().mockReturnValue(thread);
      const service = setupServiceWithMockFactory(mockFactory);

      const result = await service.loadSession('existing-session-id', mockAgentProcessConfig);

      expect(result.historyUpdates).toEqual([]);
      const serialized = JSON.stringify(result);
      [
        'BDD_SENSITIVE_PROMPT',
        'BDD_ASSISTANT_PART',
        'BDD_THOUGHT_STEP',
        'BDD_TOOL_RESULT',
        'BDD_PERMISSION_ALLOWED',
      ].forEach((sentinel) => expect(serialized).not.toContain(sentinel));
    });

    it('should apply default session options after loading a session', async () => {
      const thread = createMockThread({
        initialized: true,
        getStatus: jest.fn().mockReturnValue('idle'),
        getSessionState: jest.fn().mockReturnValue({
          notifications: [],
          entries: [],
          modes: [{ id: 'code', name: 'Code' }],
          models: [{ modelId: 'gpt-5-mini', name: 'GPT-5 Mini' }],
          configOptions: [{ id: 'approval', options: [{ value: 'on-request' }] }],
        }),
        onEvent: jest.fn(() => ({ dispose: jest.fn() })),
      });
      const mockFactory = jest.fn().mockReturnValue(thread);
      const service = setupServiceWithMockFactory(mockFactory);

      await service.loadSession('existing-session-id', {
        ...mockAgentProcessConfig,
        defaultMode: 'code',
        defaultModel: 'gpt-5-mini',
        defaultConfigOptions: {
          approval: 'on-request',
        },
      });

      expect(thread.setSessionMode).toHaveBeenCalledWith({ sessionId: 'existing-session-id', modeId: 'code' });
      expect(thread.unstable_setSessionModel).toHaveBeenCalledWith({
        sessionId: 'existing-session-id',
        model: 'gpt-5-mini',
      });
      expect(thread.setSessionConfigOption).toHaveBeenCalledWith({
        sessionId: 'existing-session-id',
        configId: 'approval',
        value: 'on-request',
      });
    });

    it('keeps a connected process reusable when loadSession fails', async () => {
      const thread = createMockThread({
        loadSession: jest
          .fn()
          .mockRejectedValueOnce(new Error('Session load failed'))
          .mockResolvedValueOnce({ sessionId: 'next-session' }),
      });
      thread.initialize.mockImplementation(async () => {
        thread.initialized = true;
        return { protocolVersion: 1, agentCapabilities: {} };
      });
      const mockFactory = jest.fn().mockReturnValue(thread);
      const service = setupServiceWithMockFactory(mockFactory);

      await expect(service.loadSession('failed-session', mockAgentProcessConfig)).rejects.toThrow(
        'Session load failed',
      );
      const result = await service.loadSession('next-session', mockAgentProcessConfig);

      expect(result.sessionId).toBe('next-session');
      expect(mockFactory).toHaveBeenCalledTimes(1);
      expect(thread.reset).toHaveBeenCalled();
      expect(thread.dispose).not.toHaveBeenCalled();
      expect(mockTerminalHandler.releaseSessionTerminals).toHaveBeenCalledWith('failed-session');
      expect((service as any).sessions.has('failed-session')).toBe(false);
      expect((service as any).sessions.get('next-session')).toBe(thread);
    });

    it('maps ACP resource-not-found during session/load to the stable missing-session error', async () => {
      const missingSessionError = Object.assign(new Error('Resource not found: missing-session'), { code: -32002 });
      const thread = createMockThread({
        loadSession: jest.fn().mockRejectedValueOnce(missingSessionError),
      });
      thread.initialize.mockImplementation(async () => {
        thread.initialized = true;
        return { protocolVersion: 1, agentCapabilities: {} };
      });
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));

      await expect(service.loadSession('missing-session', mockAgentProcessConfig)).rejects.toMatchObject({
        name: ACP_SESSION_NOT_FOUND_ERROR_NAME,
      });
    });

    it('should join an in-flight load instead of returning a half-loaded thread', async () => {
      const loadGate = createDeferred<void>();
      let loaded = false;
      const thread = createMockThread({
        initialized: true,
        getStatus: jest.fn().mockReturnValue('idle'),
        loadSession: jest.fn(async () => {
          await loadGate.promise;
          loaded = true;
          return { sessionId: 'shared-session' };
        }),
        getSessionNotifications: jest.fn(() =>
          loaded
            ? [
                {
                  sessionId: 'shared-session',
                  update: {
                    sessionUpdate: 'agent_message_chunk',
                    content: { type: 'text', text: 'Loaded history' },
                  },
                },
              ]
            : [],
        ),
        onEvent: jest.fn(() => ({ dispose: jest.fn() })),
      });
      const mockFactory = jest.fn().mockReturnValue(thread);
      const service = setupServiceWithMockFactory(mockFactory);

      const firstLoad = service.loadSession('shared-session', mockAgentProcessConfig);
      await flushAsyncWork();
      expect(thread.loadSession).toHaveBeenCalledTimes(1);

      let secondResolved = false;
      const secondLoad = service.loadSession('shared-session', mockAgentProcessConfig).then((result) => {
        secondResolved = true;
        return result;
      });

      await flushAsyncWork();
      expect(thread.loadSession).toHaveBeenCalledTimes(1);
      expect(secondResolved).toBe(false);

      loadGate.resolve();
      const [firstResult, secondResult] = await Promise.all([firstLoad, secondLoad]);

      expect(firstResult.historyUpdates).toHaveLength(1);
      expect(secondResult.historyUpdates).toHaveLength(1);
      expect(secondResult.historyUpdates[0].update).toEqual(
        expect.objectContaining({
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Loaded history' },
        }),
      );
    });

    it('should reject load without disturbing working sessions when the pool is saturated', async () => {
      const { service } = createServiceWithAutoEvents();
      const workingThreads: MockThread[] = [];

      // Fill the pool
      for (let i = 0; i < SMALL_THREAD_POOL_SIZE; i++) {
        const t = createMockThread({
          getStatus: jest.fn().mockReturnValue('working'),
          newSession: jest.fn().mockResolvedValue({ sessionId: `session-${i}` }),
          onEvent: jest.fn((cb: any) => {
            setTimeout(() => {
              cb({
                type: 'session_notification',
                notification: {
                  sessionId: `session-${i}`,
                  update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
                },
              });
            }, 10);
            return { dispose: jest.fn() };
          }),
        });
        workingThreads.push(t);
        (service as any).threadFactory.mockReturnValueOnce(t);
        await service.createSession(mockAgentProcessConfigWithSmallPool);
      }

      let saturationError: Error | undefined;
      try {
        await service.loadSession('new-session', mockAgentProcessConfigWithSmallPool);
      } catch (error) {
        saturationError = error as Error;
      }

      expect(saturationError).toBeInstanceOf(Error);
      expect(saturationError!.name).toBe(ACP_THREAD_POOL_SATURATED_ERROR_NAME);
      expect(workingThreads.every((thread) => thread.dispose.mock.calls.length === 0)).toBe(true);
      expect((service as any).sessions.size).toBe(SMALL_THREAD_POOL_SIZE);
    });

    it('reclaims a disconnected process while keeping its durable session reloadable', async () => {
      let disconnectedStatus = 'idle';
      const disconnectedThread = createMockThread({
        threadId: 'disconnected-thread',
        getStatus: jest.fn(() => disconnectedStatus),
        newSession: jest.fn(async () => {
          disconnectedThread._fireEvent({
            type: 'session_notification',
            notification: {
              sessionId: 'durable-session',
              update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
            },
          });
          return { sessionId: 'durable-session' };
        }),
      });
      const replacementThread = createMockThread({
        threadId: 'replacement-thread',
        initialized: true,
        getStatus: jest.fn().mockReturnValue('awaiting_prompt'),
        loadSession: jest.fn(async ({ sessionId }) => ({ sessionId })),
      });
      const mockFactory = jest.fn().mockReturnValueOnce(disconnectedThread).mockReturnValueOnce(replacementThread);
      const service = setupServiceWithMockFactory(mockFactory);
      const oneThreadConfig = { ...mockAgentProcessConfig, threadPoolSize: 1 };

      await service.createSession(oneThreadConfig);
      disconnectedStatus = 'disconnected';

      const replacementResult = await service.loadSession('replacement-session', oneThreadConfig);

      expect(replacementResult.sessionId).toBe('replacement-session');
      expect(disconnectedThread.dispose).toHaveBeenCalledTimes(1);
      expect(mockTerminalHandler.releaseSessionTerminals).toHaveBeenCalledWith('durable-session');
      expect(mockPermissionRouting.unregisterSession).toHaveBeenCalledWith('durable-session');
      expect((service as any).sessions.has('durable-session')).toBe(false);
      expect((service as any).sessionRefCounts.has('durable-session')).toBe(false);
      expect((service as any).threadStatusDisposables.has('durable-session')).toBe(false);
      expect((service as any).threadPool).toEqual([replacementThread]);

      const reloadedResult = await service.loadSession('durable-session', oneThreadConfig);

      expect(reloadedResult.sessionId).toBe('durable-session');
      expect(replacementThread.loadSession).toHaveBeenLastCalledWith(
        expect.objectContaining({ sessionId: 'durable-session', cwd: oneThreadConfig.cwd }),
      );
    });

    it('should load a new session by recycling the least recently used reusable thread', async () => {
      const { service, mockFactory } = createServiceWithAutoEvents();
      const threads: MockThread[] = [];

      for (let i = 0; i < 3; i++) {
        const t = createMockThread({
          threadId: `thread-${i}`,
          getStatus: jest.fn().mockReturnValue('awaiting_prompt'),
          newSession: jest.fn().mockResolvedValue({ sessionId: `session-${i}` }),
          loadSession: jest.fn().mockResolvedValue({ sessionId: 'session-3' }),
          onEvent: jest.fn((cb: any) => {
            setTimeout(() => {
              cb({
                type: 'session_notification',
                notification: {
                  sessionId: `session-${i}`,
                  update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
                },
              });
            }, 10);
            return { dispose: jest.fn() };
          }),
        });
        threads.push(t);
        mockFactory.mockReturnValueOnce(t);
        await service.createSession(mockAgentProcessConfigWithSmallPool);
      }

      const result = await service.loadSession('session-3', mockAgentProcessConfigWithSmallPool);

      expect(result.sessionId).toBe('session-3');
      expect(mockFactory).toHaveBeenCalledTimes(3);
      expect(threads[0].loadSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-3', cwd: mockAgentProcessConfig.cwd }),
      );
      expect((service as any).sessions.has('session-0')).toBe(false);
      expect((service as any).sessions.get('session-3')).toBe(threads[0]);
    });

    it('should reserve a recycled thread before async cleanup so concurrent loads cannot reuse it', async () => {
      const { service, mockFactory } = createServiceWithAutoEvents();
      const threads: MockThread[] = [];

      for (let i = 0; i < 3; i++) {
        const t = createMockThread({
          threadId: `thread-${i}`,
          getStatus: jest.fn().mockReturnValue('awaiting_prompt'),
          newSession: jest.fn().mockResolvedValue({ sessionId: `session-${i}` }),
          loadSession: jest.fn(async (params) => ({ sessionId: params.sessionId })),
          onEvent: jest.fn((cb: any) => {
            setTimeout(() => {
              cb({
                type: 'session_notification',
                notification: {
                  sessionId: `session-${i}`,
                  update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
                },
              });
            }, 10);
            return { dispose: jest.fn() };
          }),
        });
        threads.push(t);
        mockFactory.mockReturnValueOnce(t);
        await service.createSession(mockAgentProcessConfigWithSmallPool);
      }

      const firstReleaseGate = createDeferred<void>();
      mockTerminalHandler.releaseSessionTerminals.mockImplementation(async (sessionId: string) => {
        if (sessionId === 'session-0') {
          await firstReleaseGate.promise;
        }
      });

      const firstLoad = service.loadSession('session-3', mockAgentProcessConfigWithSmallPool);
      await flushAsyncWork();
      expect(mockTerminalHandler.releaseSessionTerminals).toHaveBeenCalledWith('session-0');

      const secondLoad = service.loadSession('session-4', mockAgentProcessConfigWithSmallPool);
      await flushAsyncWork();
      expect(mockTerminalHandler.releaseSessionTerminals).toHaveBeenCalledWith('session-1');

      firstReleaseGate.resolve();
      await Promise.all([firstLoad, secondLoad]);

      expect(threads[0].loadSession).toHaveBeenCalledTimes(1);
      expect(threads[0].loadSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-3', cwd: mockAgentProcessConfig.cwd }),
      );
      expect(threads[1].loadSession).toHaveBeenCalledTimes(1);
      expect(threads[1].loadSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-4', cwd: mockAgentProcessConfig.cwd }),
      );
      expect((service as any).sessions.get('session-3')).toBe(threads[0]);
      expect((service as any).sessions.get('session-4')).toBe(threads[1]);
    });

    it('prevents a reserved reclamation candidate from starting a concurrent prompt', async () => {
      const releaseGate = createDeferred<void>();
      let status = 'awaiting_prompt';
      const thread = createMockThread({
        threadId: 'reclamation-candidate',
        getStatus: jest.fn(() => status),
        newSession: jest.fn(async () => {
          thread._fireEvent({
            type: 'session_notification',
            notification: {
              sessionId: 'session-0',
              update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
            },
          });
          return { sessionId: 'session-0' };
        }),
        loadSession: jest.fn(async ({ sessionId }) => ({ sessionId })),
        prompt: jest.fn(async () => {
          status = 'working';
          return { stopReason: 'end_turn' };
        }),
      });
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));
      const oneThreadConfig = { ...mockAgentProcessConfig, threadPoolSize: 1 };
      mockTerminalHandler.releaseSessionTerminals.mockImplementation(async (sessionId: string) => {
        if (sessionId === 'session-0') {
          await releaseGate.promise;
        }
      });

      await service.createSession(oneThreadConfig);

      const replacementLoad = service.loadSession('session-1', oneThreadConfig);
      await flushAsyncWork();
      expect(mockTerminalHandler.releaseSessionTerminals).toHaveBeenCalledWith('session-0');
      expect((service as any).reservedThreads.has(thread)).toBe(true);

      const promptErrors: Error[] = [];
      const stream = service.sendMessage({ sessionId: 'session-0', prompt: 'do not start' }, oneThreadConfig);
      stream.onError((error) => promptErrors.push(error));
      await flushAsyncWork();

      expect(thread.prompt).not.toHaveBeenCalled();
      expect(status).toBe('awaiting_prompt');
      expect(promptErrors).toHaveLength(1);
      expect(promptErrors[0].name).toBe(ACP_THREAD_POOL_SATURATED_ERROR_NAME);

      releaseGate.resolve();
      await replacementLoad;

      expect(thread.loadSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-1', cwd: oneThreadConfig.cwd }),
      );
    });
  });

  describe('loadSessionOrNew()', () => {
    it('should rebind service state when fallback creates a different session id', async () => {
      const thread = createMockThread({
        initialized: true,
        getStatus: jest.fn().mockReturnValue('idle'),
        loadSessionOrNew: jest.fn().mockResolvedValue({
          sessionId: 'actual-session-id',
          createdByFallback: true,
        }),
        onEvent: jest.fn(() => ({ dispose: jest.fn() })),
      });
      const mockFactory = jest.fn().mockReturnValue(thread);
      const service = setupServiceWithMockFactory(mockFactory);

      const result = await service.loadSessionOrNew('missing-session-id', mockAgentProcessConfig);

      expect(result.sessionId).toBe('actual-session-id');
      expect((service as any).sessions.has('missing-session-id')).toBe(false);
      expect((service as any).sessions.get('actual-session-id')).toBe(thread);
      expect(mockPermissionRouting.unregisterSession).toHaveBeenCalledWith('missing-session-id');
      expect(mockPermissionRouting.registerSession).toHaveBeenCalledWith('actual-session-id');
    });

    it('should join a pending loadSessionOrNew request for the same session', async () => {
      const loadGate = createDeferred<{ sessionId: string; createdByFallback: boolean }>();
      const thread = createMockThread({
        initialized: true,
        getStatus: jest.fn().mockReturnValue('idle'),
        loadSessionOrNew: jest.fn().mockReturnValue(loadGate.promise),
        onEvent: jest.fn(() => ({ dispose: jest.fn() })),
      });
      const mockFactory = jest.fn().mockReturnValue(thread);
      const service = setupServiceWithMockFactory(mockFactory);

      const firstLoad = service.loadSessionOrNew('pending-session-id', mockAgentProcessConfig);
      await flushAsyncWork();

      const secondLoad = service.loadSessionOrNew('pending-session-id', mockAgentProcessConfig);
      loadGate.resolve({ sessionId: 'pending-session-id', createdByFallback: false });
      const [firstResult, secondResult] = await Promise.all([firstLoad, secondLoad]);

      expect(firstResult.sessionId).toBe('pending-session-id');
      expect(secondResult.sessionId).toBe('pending-session-id');
      expect(thread.loadSessionOrNew).toHaveBeenCalledTimes(1);
      expect((service as any).sessionRefCounts.get('pending-session-id')).toBe(2);
    });

    it('should release recycled thread reservation after loadSessionOrNew registers a pending load', async () => {
      const { service, mockFactory } = createServiceWithAutoEvents();
      const threads: MockThread[] = [];

      for (let i = 0; i < 3; i++) {
        const t = createMockThread({
          threadId: `thread-${i}`,
          getStatus: jest.fn().mockReturnValue('awaiting_prompt'),
          newSession: jest.fn().mockResolvedValue({ sessionId: `session-${i}` }),
          loadSessionOrNew: jest.fn().mockResolvedValue({ sessionId: 'session-3', createdByFallback: false }),
          onEvent: jest.fn((cb: any) => {
            setTimeout(() => {
              cb({
                type: 'session_notification',
                notification: {
                  sessionId: `session-${i}`,
                  update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
                },
              });
            }, 10);
            return { dispose: jest.fn() };
          }),
        });
        threads.push(t);
        mockFactory.mockReturnValueOnce(t);
        await service.createSession(mockAgentProcessConfigWithSmallPool);
      }

      await service.loadSessionOrNew('session-3', mockAgentProcessConfigWithSmallPool);

      expect(threads[0].loadSessionOrNew).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-3', cwd: mockAgentProcessConfig.cwd }),
      );
      expect((service as any).reservedThreads.has(threads[0])).toBe(false);
    });

    it('keeps a connected process reusable when loadSessionOrNew fails', async () => {
      const thread = createMockThread({
        loadSessionOrNew: jest.fn().mockRejectedValue(new Error('Load or create failed')),
      });
      thread.initialize.mockImplementation(async () => {
        thread.initialized = true;
        return { protocolVersion: 1, agentCapabilities: {} };
      });
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));

      await expect(service.loadSessionOrNew('failed-session', mockAgentProcessConfig)).rejects.toThrow(
        'Load or create failed',
      );

      expect(thread.reset).toHaveBeenCalled();
      expect(thread.dispose).not.toHaveBeenCalled();
      expect(mockTerminalHandler.releaseSessionTerminals).toHaveBeenCalledWith('failed-session');
      expect((service as any).threadPool).toEqual([thread]);
      expect((service as any).sessions.has('failed-session')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // sendMessage
  // -----------------------------------------------------------------------

  describe('sendMessage()', () => {
    it('should return stream with error if session cannot be loaded', async () => {
      const thread = createMockThread({
        loadSession: jest.fn().mockRejectedValue(new Error('Session not found')),
      });
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));
      const stream = service.sendMessage({ prompt: 'hello', sessionId: 'nonexistent' }, mockAgentProcessConfig);

      const errors: Error[] = [];
      stream.onError((e) => errors.push(e));
      await flushAsyncWork();

      expect(errors.length).toBe(1);
      expect(errors[0].message).toContain('Session not found');
    });

    it('should reload an LRU-evicted session before sending a message', async () => {
      const { service, mockFactory } = createServiceWithAutoEvents();
      const threads: MockThread[] = [];

      for (let i = 0; i < 3; i++) {
        const threadIndex = i;
        const t = createMockThread({
          threadId: `thread-${threadIndex}`,
          getStatus: jest.fn().mockReturnValue('awaiting_prompt'),
          newSession: jest.fn().mockResolvedValue({ sessionId: `session-${threadIndex}` }),
          loadSession: jest.fn().mockResolvedValue({ sessionId: 'session-0' }),
          onEvent: jest.fn((cb: any) => {
            setTimeout(() => {
              cb({
                type: 'session_notification',
                notification: {
                  sessionId: `session-${threadIndex}`,
                  update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
                },
              });
            }, 10);
            return { dispose: jest.fn() };
          }),
        });
        threads.push(t);
        mockFactory.mockReturnValueOnce(t);
        await service.createSession(mockAgentProcessConfigWithSmallPool);
      }

      threads[0].newSession.mockResolvedValueOnce({ sessionId: 'session-3' });
      await service.createSession(mockAgentProcessConfigWithSmallPool);

      expect((service as any).sessions.has('session-0')).toBe(false);

      const stream = service.sendMessage(
        { prompt: 'Hello again', sessionId: 'session-0' },
        mockAgentProcessConfigWithSmallPool,
      );
      const updates: any[] = [];
      stream.onData((data) => updates.push(data));
      await flushAsyncWork();

      expect((service as any).sessions.get('session-0')).toBe(threads[1]);
      expect(threads[1].loadSession).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-0', cwd: mockAgentProcessConfig.cwd }),
      );
      expect(threads[1].addUserMessage).toHaveBeenCalledWith('Hello again');
      expect(threads[1].prompt).toHaveBeenCalledWith(
        expect.objectContaining({ sessionId: 'session-0', prompt: expect.any(Array) }),
      );
      expect(updates).toContainEqual(expect.objectContaining({ type: 'thread_status' }));
    });

    it('should add user message and prompt the thread', async () => {
      const { service, thread } = createServiceWithAutoEvents();

      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      const createResult = await service.createSession(mockAgentProcessConfig);
      service.sendMessage({ prompt: 'Hello world', sessionId: createResult.sessionId }, mockAgentProcessConfig);
      await flushAsyncWork();

      expect(thread.addUserMessage).toHaveBeenCalledWith('Hello world');
      expect(thread.prompt).toHaveBeenCalled();
    });

    it('should prepend only the low-priority WebMCP hint for the first built-in MCP prompt', async () => {
      const { service, thread } = createServiceWithAutoEvents();

      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      const createResult = await service.createSession(mockAgentProcessConfig);
      (service as any).builtInMcpSessionIds.add(createResult.sessionId);

      service.sendMessage(
        { prompt: 'Explain the current file', sessionId: createResult.sessionId },
        mockAgentProcessConfig,
      );
      await flushAsyncWork();

      const promptBlocks = thread.prompt.mock.calls[0][0].prompt;
      expect(promptBlocks).toEqual([
        {
          type: 'text',
          text: [
            '<opensumi_mcp_usage_hint priority="low">',
            'Use the opensumi-ide MCP catalog tools to discover and enable IDE capability groups before invoking non-default OpenSumi tools.',
            '</opensumi_mcp_usage_hint>',
            '',
            'Explain the current file',
          ].join('\n'),
        },
      ]);
      expect(promptBlocks[0].text).not.toContain('terminal_create');
      expect(promptBlocks[0].text).not.toContain('Live OpenSumi opensumi-ide MCP registered capability metadata');
    });

    it('should not repeat the WebMCP hint after the first built-in MCP prompt', async () => {
      const { service, thread } = createServiceWithAutoEvents();

      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      const createResult = await service.createSession(mockAgentProcessConfig);
      (service as any).builtInMcpSessionIds.add(createResult.sessionId);
      thread.getEntries.mockReturnValue([{ id: 'user-1' }, { id: 'assistant-1' }]);

      service.sendMessage({ prompt: 'Summarize this file', sessionId: createResult.sessionId }, mockAgentProcessConfig);
      await flushAsyncWork();

      expect(thread.prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: [{ type: 'text', text: 'Summarize this file' }],
        }),
      );
    });

    it('should emit thought updates from session_notification events', async () => {
      const { service, thread } = createServiceWithAutoEvents();

      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      const createResult = await service.createSession(mockAgentProcessConfig);

      const updates: any[] = [];
      const stream = service.sendMessage(
        { prompt: 'Hello', sessionId: createResult.sessionId },
        mockAgentProcessConfig,
      );
      stream.onData((data) => updates.push(data));

      // Simulate a session notification event
      thread._fireEvent({
        type: 'session_notification',
        notification: {
          sessionId: createResult.sessionId,
          update: {
            sessionUpdate: 'agent_thought_chunk',
            content: { type: 'text', text: 'I am thinking...' },
          },
        },
      });

      expect(updates).toContainEqual(expect.objectContaining({ type: 'thought', content: 'I am thinking...' }));
    });

    it('should emit message updates from session_notification events', async () => {
      const { service, thread } = createServiceWithAutoEvents();

      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      const createResult = await service.createSession(mockAgentProcessConfig);

      const updates: any[] = [];
      const stream = service.sendMessage(
        { prompt: 'Hello', sessionId: createResult.sessionId },
        mockAgentProcessConfig,
      );
      stream.onData((data) => updates.push(data));

      thread._fireEvent({
        type: 'session_notification',
        notification: {
          sessionId: createResult.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'Here is my answer.' },
          },
        },
      });

      expect(updates).toContainEqual(expect.objectContaining({ type: 'message', content: 'Here is my answer.' }));
    });

    it('should ignore stream updates from a different session', async () => {
      const { service, thread } = createServiceWithAutoEvents();

      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      const createResult = await service.createSession(mockAgentProcessConfig);

      const updates: any[] = [];
      const stream = service.sendMessage(
        { prompt: 'Hello', sessionId: createResult.sessionId },
        mockAgentProcessConfig,
      );
      stream.onData((data) => updates.push(data));

      thread._fireEvent({
        type: 'session_notification',
        notification: {
          sessionId: 'stale-session',
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'stale answer' },
          },
        },
      });

      expect(updates).not.toContainEqual(expect.objectContaining({ type: 'message', content: 'stale answer' }));
      expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining('ignoring notification for stale-session'));
    });

    it('should emit tool_call updates', async () => {
      const { service, thread } = createServiceWithAutoEvents();

      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      const createResult = await service.createSession(mockAgentProcessConfig);

      const updates: any[] = [];
      const stream = service.sendMessage(
        { prompt: 'Hello', sessionId: createResult.sessionId },
        mockAgentProcessConfig,
      );
      stream.onData((data) => updates.push(data));

      thread._fireEvent({
        type: 'session_notification',
        notification: {
          sessionId: createResult.sessionId,
          update: {
            sessionUpdate: 'tool_call',
            title: 'ReadFile',
            rawInput: { path: '/test/file.ts' },
          },
        },
      });

      expect(updates).toContainEqual(
        expect.objectContaining({
          type: 'tool_call',
          content: 'ReadFile',
          toolCall: expect.objectContaining({ name: 'ReadFile', input: { path: '/test/file.ts' } }),
        }),
      );
    });

    it('should emit tool_result updates from tool_call_update with diff', async () => {
      const { service, thread } = createServiceWithAutoEvents();

      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      const createResult = await service.createSession(mockAgentProcessConfig);

      const updates: any[] = [];
      const stream = service.sendMessage(
        { prompt: 'Hello', sessionId: createResult.sessionId },
        mockAgentProcessConfig,
      );
      stream.onData((data) => updates.push(data));

      thread._fireEvent({
        type: 'session_notification',
        notification: {
          sessionId: createResult.sessionId,
          update: {
            sessionUpdate: 'tool_call_update',
            content: [{ type: 'diff', path: 'src/index.ts' }],
          },
        },
      });

      expect(updates).toContainEqual(
        expect.objectContaining({ type: 'tool_result', content: 'Modified src/index.ts' }),
      );
    });

    it('should emit done and end stream after prompt completes', (done) => {
      const { service, thread } = createServiceWithAutoEvents();

      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      service.createSession(mockAgentProcessConfig).then((createResult) => {
        const updates: any[] = [];
        const stream = service.sendMessage(
          { prompt: 'Hello', sessionId: createResult.sessionId },
          mockAgentProcessConfig,
        );
        stream.onData((data) => updates.push(data));
        stream.onEnd(() => {
          expect(updates).toContainEqual({ type: 'done', content: '' });
          expect(thread.markAssistantComplete).toHaveBeenCalled();
          done();
        });
      });
    });

    it('should emit error if prompt fails', async () => {
      const eventListeners: Array<(event: any) => void> = [];
      const thread = createMockThread({
        onEvent: jest.fn((cb: any) => {
          eventListeners.push(cb);
          return { dispose: jest.fn() };
        }),
        _fireEvent(event: any) {
          eventListeners.forEach((cb) => cb(event));
        },
        _eventListeners: eventListeners,
        prompt: jest.fn().mockRejectedValue(new Error('Prompt failed')),
      });
      const mockFactory = jest.fn().mockReturnValue(thread);
      const service = setupServiceWithMockFactory(mockFactory);

      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      const createResult = await service.createSession(mockAgentProcessConfig);

      const errors: Error[] = [];
      const stream = service.sendMessage(
        { prompt: 'Hello', sessionId: createResult.sessionId },
        mockAgentProcessConfig,
      );
      stream.onError((e) => errors.push(e));

      // Wait for the async prompt to complete and error to be emitted
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(errors.length).toBe(1);
      expect(errors[0].message).toBe('Prompt failed');
    });

    it('should preserve message from JSON-RPC error objects when prompt fails', async () => {
      const eventListeners: Array<(event: any) => void> = [];
      const thread = createMockThread({
        onEvent: jest.fn((cb: any) => {
          eventListeners.push(cb);
          return { dispose: jest.fn() };
        }),
        _fireEvent(event: any) {
          eventListeners.forEach((cb) => cb(event));
        },
        _eventListeners: eventListeners,
        prompt: jest.fn().mockRejectedValue({
          code: -32603,
          message: 'Internal error: API Error: 422 provider config not found',
          data: { errorKind: 'unknown' },
        }),
      });
      const mockFactory = jest.fn().mockReturnValue(thread);
      const service = setupServiceWithMockFactory(mockFactory);

      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      const createResult = await service.createSession(mockAgentProcessConfig);

      const errors: Error[] = [];
      const stream = service.sendMessage(
        { prompt: 'Hello', sessionId: createResult.sessionId },
        mockAgentProcessConfig,
      );
      stream.onError((e) => errors.push(e));

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(errors.length).toBe(1);
      expect(errors[0].message).toBe('Internal error: API Error: 422 provider config not found');
      expect((errors[0] as any).code).toBe(-32603);
      expect((errors[0] as any).data).toEqual({ errorKind: 'unknown' });
    });

    it('should include images in prompt', async () => {
      const { service, thread } = createServiceWithAutoEvents();

      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      const createResult = await service.createSession(mockAgentProcessConfig);

      const imageData = 'data:image/png;base64,iVBORw0KGgo=';
      service.sendMessage(
        { prompt: 'Look at this', sessionId: createResult.sessionId, images: [imageData] },
        mockAgentProcessConfig,
      );
      await flushAsyncWork();

      expect(thread.prompt).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: expect.arrayContaining([
            { type: 'text', text: expect.stringContaining('Look at this') },
            { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' },
          ]),
        }),
      );
    });
  });

  describe('attachSession()', () => {
    it('should emit the current snapshot before forwarding later session updates without prompting again', async () => {
      const { service, thread } = createServiceWithAutoEvents();
      const historyUpdates = [
        {
          sessionId: 'session-1',
          update: {
            sessionUpdate: 'user_message_chunk',
            content: { type: 'text', text: 'keep working' },
          },
        },
      ];
      thread.getSessionNotifications.mockReturnValue(historyUpdates);
      thread.getStatus.mockReturnValue('working');

      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      const createResult = await service.createSession(mockAgentProcessConfig);
      thread.prompt.mockClear();

      const attachment = service.attachSession(createResult.sessionId);
      const updates: any[] = [];
      attachment.onData((update) => updates.push(update));

      thread._fireEvent({
        type: 'session_notification',
        notification: {
          sessionId: createResult.sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text: 'still running' },
          },
        },
      });

      expect(updates[0]).toEqual(
        expect.objectContaining({
          type: 'snapshot',
          snapshot: expect.objectContaining({
            sessionId: createResult.sessionId,
            historyUpdates,
            threadStatus: 'working',
          }),
        }),
      );
      expect(updates).toContainEqual(
        expect.objectContaining({
          type: 'update',
          update: expect.objectContaining({ type: 'message', content: 'still running' }),
        }),
      );
      expect(thread.prompt).not.toHaveBeenCalled();
      attachment.end();
    });

    it('should release the thread event subscription when an attachment ends', async () => {
      const { service, thread } = createServiceWithAutoEvents();

      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      const createResult = await service.createSession(mockAgentProcessConfig);
      const attachmentSubscription = { dispose: jest.fn() };
      thread.onEvent.mockReturnValueOnce(attachmentSubscription);

      const attachment = service.attachSession(createResult.sessionId);
      attachment.end();

      expect(attachmentSubscription.dispose).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // cancelRequest
  // -----------------------------------------------------------------------

  describe('cancelRequest()', () => {
    it('should call thread.cancel', async () => {
      const { service, thread } = createServiceWithAutoEvents();

      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      const result = await service.createSession(mockAgentProcessConfig);
      await service.cancelRequest(result.sessionId);

      expect(thread.cancel).toHaveBeenCalledWith(expect.objectContaining({ sessionId: result.sessionId }));
    });

    it('should return early and warn if session not found', async () => {
      const { service } = createService();
      await service.cancelRequest('nonexistent-session');

      expect(mockLogger.warn).toHaveBeenCalled();
    });

    it('should swallow errors', async () => {
      const { service, thread } = createServiceWithAutoEvents();

      thread.cancel = jest.fn().mockRejectedValue(new Error('Cancel failed'));

      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      const result = await service.createSession(mockAgentProcessConfig);
      await expect(service.cancelRequest(result.sessionId)).resolves.toBeUndefined();
      expect(mockLogger.warn).toHaveBeenCalled();
    });
  });

  // -----------------------------------------------------------------------
  // disposeSession
  // -----------------------------------------------------------------------

  describe('disposeSession()', () => {
    it('should release terminals and remove from session mapping (default)', async () => {
      const { service, thread } = createServiceWithAutoEvents();

      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      const result = await service.createSession(mockAgentProcessConfig);
      await service.disposeSession(result.sessionId);

      expect(mockTerminalHandler.releaseSessionTerminals).toHaveBeenCalledWith(result.sessionId);
      expect(service.getSessionInfo(result.sessionId)).toBeNull();
      expect(thread.dispose).not.toHaveBeenCalled();
    });

    it('should fully dispose thread when force=true', async () => {
      const { service, thread } = createServiceWithAutoEvents();

      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      const result = await service.createSession(mockAgentProcessConfig);
      await service.disposeSession(result.sessionId, true);

      expect(thread.dispose).toHaveBeenCalled();
      expect(service.getSessionInfo(result.sessionId)).toBeNull();
    });

    it('should still fully dispose the thread when force terminal cleanup fails', async () => {
      const { service, thread } = createServiceWithAutoEvents();

      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      const result = await service.createSession(mockAgentProcessConfig);
      mockTerminalHandler.releaseSessionTerminals.mockRejectedValueOnce(new Error('terminal cleanup failed'));

      await expect(service.disposeSession(result.sessionId, true)).rejects.toThrow('terminal cleanup failed');

      expect(thread.dispose).toHaveBeenCalledTimes(1);
      expect((service as any).threadPool).not.toContain(thread);
      expect(service.getSessionInfo(result.sessionId)).toBeNull();
    });

    it('should not release terminals again when the same disposed session is disposed twice', async () => {
      const { service, thread } = createServiceWithAutoEvents();

      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      const result = await service.createSession(mockAgentProcessConfig);

      await service.disposeSession(result.sessionId);
      await service.disposeSession(result.sessionId);

      expect(mockTerminalHandler.releaseSessionTerminals).toHaveBeenCalledTimes(1);
      expect(mockTerminalHandler.releaseSessionTerminals).toHaveBeenCalledWith(result.sessionId);
    });

    it('should preserve a new same-id binding while the previous session disposal is still draining terminals', async () => {
      const firstLoadSession = jest.fn().mockResolvedValue({ sessionId: 'same-session' });
      const secondLoadSession = jest.fn().mockResolvedValue({ sessionId: 'same-session' });
      const firstThread = createConnectedAcpThread({ loadSession: firstLoadSession });
      const secondThread = createConnectedAcpThread({ loadSession: secondLoadSession });
      const mockFactory = jest.fn().mockReturnValueOnce(firstThread).mockReturnValueOnce(secondThread);
      const service = setupServiceWithMockFactory(mockFactory);

      await service.loadSession('same-session', mockAgentProcessConfig);

      const releaseStarted = createDeferred();
      const releaseGate = createDeferred();
      mockTerminalHandler.releaseSessionTerminals.mockImplementationOnce(() => {
        releaseStarted.resolve();
        return releaseGate.promise;
      });

      const firstDisposal = service.disposeSession('same-session');
      await releaseStarted.promise;
      const replacement = await service.loadSession('same-session', mockAgentProcessConfig);

      expect(replacement.processId).toBe(secondThread.threadId);
      expect((service as any).sessions.get('same-session')).toBe(secondThread);
      expect(secondThread.sessionId).toBe('same-session');

      releaseGate.resolve();
      await firstDisposal;

      expect((service as any).sessions.get('same-session')).toBe(secondThread);
      expect(secondThread.sessionId).toBe('same-session');
      expect(mockTerminalHandler.releaseSessionTerminals).toHaveBeenCalledTimes(1);
    });

    it('should release a loaded session only after the final retained reference is disposed', async () => {
      const thread = createMockThread({
        initialized: true,
        getStatus: jest.fn().mockReturnValue('idle'),
        onEvent: jest.fn(() => ({ dispose: jest.fn() })),
      });
      const mockFactory = jest.fn().mockReturnValue(thread);
      const service = setupServiceWithMockFactory(mockFactory);

      await Promise.all([
        service.loadSession('shared-session', mockAgentProcessConfig),
        service.loadSession('shared-session', mockAgentProcessConfig),
      ]);

      mockTerminalHandler.releaseSessionTerminals.mockClear();

      await service.disposeSession('shared-session');

      expect(mockTerminalHandler.releaseSessionTerminals).not.toHaveBeenCalled();
      expect((service as any).sessions.get('shared-session')).toBe(thread);

      await service.disposeSession('shared-session');

      expect(mockTerminalHandler.releaseSessionTerminals).toHaveBeenCalledWith('shared-session');
      expect((service as any).sessions.has('shared-session')).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // stopAgent
  // -----------------------------------------------------------------------

  describe('stopAgent()', () => {
    it('should dispose all threads and clear pool', async () => {
      const { service } = createServiceWithAutoEvents();

      const threads: MockThread[] = [];
      for (let i = 0; i < 3; i++) {
        const t = createMockThread({
          newSession: jest.fn().mockResolvedValue({ sessionId: `session-${i}` }),
          onEvent: jest.fn((cb: any) => {
            setTimeout(() => {
              cb({
                type: 'session_notification',
                notification: {
                  sessionId: `session-${i}`,
                  update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
                },
              });
            }, 10);
            return { dispose: jest.fn() };
          }),
        });
        threads.push(t);
        (service as any).threadFactory.mockReturnValueOnce(t);
        await service.createSession(mockAgentProcessConfigWithSmallPool);
      }

      await service.stopAgent();

      for (const t of threads) {
        expect(t.dispose).toHaveBeenCalled();
      }
      expect((service as any).threadPool).toHaveLength(0);
      expect((service as any).sessions.size).toBe(0);
    });

    it('should be no-op when no threads', async () => {
      const { service } = createService();
      await service.stopAgent();

      expect((service as any).threadPool).toHaveLength(0);
    });

    it('shares one in-flight stop and keeps admission closed until it settles', async () => {
      const disposalGate = createDeferred();
      const thread = createMockThread({ dispose: jest.fn(() => disposalGate.promise) });
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));
      (service as any).threadPool.push(thread);

      const firstStop = service.stopAgent();
      const secondStop = service.stopAgent();

      expect(secondStop).toBe(firstStop);
      await flushAsyncWork();
      expect(thread.dispose).toHaveBeenCalledTimes(1);
      await expect(service.createSession(mockAgentProcessConfig)).rejects.toMatchObject({
        name: 'AcpAgentServiceStoppingError',
      });

      disposalGate.resolve();
      await Promise.all([firstStop, secondStop]);

      expect((service as any).stopping).toBe(false);
    });

    it('waits for warming initialization to settle before disposing the thread', async () => {
      const initializeGate = createDeferred<any>();
      const thread = createMockThread();
      thread.initialize.mockImplementation(async () => {
        await initializeGate.promise;
        thread.initialized = true;
        return { protocolVersion: 1, agentCapabilities: {} };
      });
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));
      const config = { ...mockAgentProcessConfig, threadPoolSize: 1 };

      const warmup = service.warmUpAgentPool(config);
      let stopSettled = false;
      const stop = service.stopAgent().finally(() => {
        stopSettled = true;
      });
      await flushAsyncWork();

      expect(stopSettled).toBe(false);
      expect(thread.dispose).toHaveBeenCalledTimes(1);

      initializeGate.resolve({ protocolVersion: 1, agentCapabilities: {} });
      await Promise.all([warmup, stop]);

      expect(thread.dispose).toHaveBeenCalledTimes(1);
      expect((service as any).threadPool).toHaveLength(0);
    });

    it('waits for a fresh createSession initialization before completing shutdown', async () => {
      const initializeGate = createDeferred<any>();
      const thread = createMockThread();
      thread.initialize.mockImplementation(async () => {
        await initializeGate.promise;
        thread.initialized = true;
        return { protocolVersion: 1, agentCapabilities: {} };
      });
      thread.newSession.mockImplementation(async () => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'foreground-session',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
        return { sessionId: 'foreground-session' };
      });
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));
      const config = { ...mockAgentProcessConfig, threadPoolSize: 1 };

      const createOutcome = service.createSession(config).then(
        (result) => result,
        (error) => error as Error,
      );
      await flushAsyncWork();
      expect(thread.initialize).toHaveBeenCalledTimes(1);

      let stopSettled = false;
      const stop = service.stopAgent().finally(() => {
        stopSettled = true;
      });
      await flushAsyncWork();

      expect(stopSettled).toBe(false);
      expect(thread.dispose).toHaveBeenCalledTimes(1);

      initializeGate.resolve({ protocolVersion: 1, agentCapabilities: {} });
      const [outcome] = await Promise.all([createOutcome, stop]);

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).name).toBe('AcpAgentServiceStoppingError');
      expect(thread.dispose).toHaveBeenCalledTimes(1);
      expect((service as any).threadPool).toHaveLength(0);
    });

    it('drains an admitted prompt and rejects new prompt work after shutdown admission closes', async () => {
      expect.hasAssertions();
      const promptGate = createDeferred<any>();
      const thread = createMockThread({
        prompt: jest.fn(() => promptGate.promise),
      });
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));
      (service as any).threadPool.push(thread);
      (service as any).sessions.set('active-session', thread);

      const admittedStream = service.sendMessage(
        { prompt: 'finish this prompt', sessionId: 'active-session' },
        mockAgentProcessConfig,
      );
      admittedStream.onError(jest.fn());
      await flushAsyncWork();
      expect(thread.prompt).toHaveBeenCalledTimes(1);

      let stopSettled = false;
      const stop = service.stopAgent().finally(() => {
        stopSettled = true;
      });
      await flushAsyncWork();
      expect(stopSettled).toBe(false);
      expect(thread.dispose).toHaveBeenCalledTimes(1);

      const rejectedErrors: Error[] = [];
      const rejectedStream = service.sendMessage(
        { prompt: 'do not admit this prompt', sessionId: 'active-session' },
        mockAgentProcessConfig,
      );
      rejectedStream.onError((error) => rejectedErrors.push(error));
      await flushAsyncWork();
      expect(rejectedErrors).toHaveLength(1);
      expect(rejectedErrors[0].name).toBe('AcpAgentServiceStoppingError');
      expect(thread.prompt).toHaveBeenCalledTimes(1);

      promptGate.resolve({ stopReason: 'end_turn' });
      await stop;

      expect(thread.dispose).toHaveBeenCalledTimes(1);
      expect(stopSettled).toBe(true);
    });

    it('bounds a stuck prompt, retires its ownership, and only reopens after a later clean stop', async () => {
      const promptGate = createDeferred<any>();
      const thread = createMockThread({ prompt: jest.fn(() => promptGate.promise) });
      const replacementThread = createMockThread();
      replacementThread.newSession.mockImplementation(async () => {
        replacementThread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'replacement-session',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
        return { sessionId: 'replacement-session' };
      });
      const mockFactory = jest.fn().mockReturnValueOnce(replacementThread);
      const service = setupServiceWithMockFactory(mockFactory);
      (service as any).stopLeaseMs = 20;
      (service as any).threadPool.push(thread);
      (service as any).sessions.set('stuck-session', thread);

      const stream = service.sendMessage(
        { prompt: 'never returns', sessionId: 'stuck-session' },
        mockAgentProcessConfig,
      );
      stream.onError(jest.fn());
      await flushAsyncWork();
      expect(thread.prompt).toHaveBeenCalledTimes(1);

      const firstOutcome = await service.stopAgent().then(
        () => undefined,
        (error) => error as AggregateError,
      );

      expect(firstOutcome).toBeInstanceOf(AggregateError);
      expect(firstOutcome?.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'AcpAgentServiceStopTimeoutError' })]),
      );
      expect(thread.dispose).toHaveBeenCalledTimes(1);
      expect((service as any).sessions.size).toBe(0);
      await expect(service.createSession(mockAgentProcessConfig)).rejects.toMatchObject({
        name: 'AcpAgentServiceStoppingError',
      });

      promptGate.resolve({ stopReason: 'end_turn' });
      await flushAsyncWork();
      await service.stopAgent();

      const replacement = await service.createSession(mockAgentProcessConfig);
      expect(replacement.sessionId).toBe('replacement-session');
      expect((service as any).sessions.get('replacement-session')).toBe(replacementThread);
      await service.stopAgent();
    });

    it('bounds a stuck initialize and keeps acquisition closed until the admitted create settles', async () => {
      const initializeGate = createDeferred<any>();
      const thread = createMockThread({ initialize: jest.fn(() => initializeGate.promise) });
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));
      (service as any).stopLeaseMs = 20;

      const createOutcome = service.createSession(mockAgentProcessConfig).then(
        (result) => result,
        (error) => error as Error,
      );
      await flushAsyncWork();
      expect(thread.initialize).toHaveBeenCalledTimes(1);

      const stopOutcome = await service.stopAgent().then(
        () => undefined,
        (error) => error as AggregateError,
      );
      expect(stopOutcome).toBeInstanceOf(AggregateError);
      expect(stopOutcome?.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'AcpAgentServiceStopTimeoutError' })]),
      );
      await expect(service.createSession(mockAgentProcessConfig)).rejects.toMatchObject({
        name: 'AcpAgentServiceStoppingError',
      });

      initializeGate.resolve({ protocolVersion: 1, agentCapabilities: {} });
      expect(await createOutcome).toMatchObject({ name: 'AcpAgentServiceStoppingError' });
      await flushAsyncWork();
      await service.stopAgent();

      expect((service as any).stopping).toBe(false);
    });

    it('releases a session created by an admitted newSession RPC after stop begins', async () => {
      const newSessionGate = createDeferred<{ sessionId: string }>();
      const thread = createMockThread({
        initialized: true,
        newSession: jest.fn(() => newSessionGate.promise),
      });
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));

      const createOutcome = service.createSession(mockAgentProcessConfig).then(
        (result) => result,
        (error) => error as Error,
      );
      await flushAsyncWork();
      expect(thread.newSession).toHaveBeenCalledTimes(1);

      const stop = service.stopAgent();
      await flushAsyncWork();
      expect(thread.dispose).toHaveBeenCalledTimes(1);

      newSessionGate.resolve({ sessionId: 'late-created-session' });
      const [outcome] = await Promise.all([createOutcome, stop]);

      expect(outcome).toMatchObject({ name: 'AcpAgentServiceStoppingError' });
      expect(mockTerminalHandler.releaseSessionTerminals).toHaveBeenCalledTimes(1);
      expect(mockTerminalHandler.releaseSessionTerminals).toHaveBeenCalledWith('late-created-session');
      expect((service as any).pendingTerminalReleaseIds.size).toBe(0);
      expect((service as any).sessions.size).toBe(0);
    });

    it('does not replay a non-fallback load identity when stop owns the late loadSessionOrNew result', async () => {
      const loadGate = createDeferred<{ sessionId: string }>();
      const loadStarted = createDeferred();
      const loadSession = jest.fn(() => {
        loadStarted.resolve();
        return loadGate.promise;
      });
      const newSession = jest.fn();
      const thread = createConnectedAcpThread({ loadSession, newSession });
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));

      const loadOutcome = service.loadSessionOrNew('existing-load-or-new', mockAgentProcessConfig).then(
        (result) => result,
        (error) => error as Error,
      );
      await loadStarted.promise;

      const stop = service.stopAgent();
      loadGate.resolve({ sessionId: 'existing-load-or-new' });
      const [outcome] = await Promise.all([loadOutcome, stop]);

      expect(outcome).toMatchObject({ name: 'AcpThreadDisposedError' });
      expect(newSession).not.toHaveBeenCalled();
      expect(
        mockTerminalHandler.releaseSessionTerminals.mock.calls.filter(([id]) => id === 'existing-load-or-new'),
      ).toHaveLength(1);
    });

    it('does not replay a create identity bound before stop while available commands are pending', async () => {
      const newSession = jest.fn().mockResolvedValue({ sessionId: 'bound-create-session' });
      const thread = createConnectedAcpThread({ newSession });
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));
      (service as any).availableCommandsWaitMs = 15;
      (service as any).stopLeaseMs = 100;
      const sessionBound = createDeferred();
      const bindSession = (service as any).bindSession.bind(service);
      jest.spyOn(service as any, 'bindSession').mockImplementation((sessionId: string, boundThread: AcpThread) => {
        bindSession(sessionId, boundThread);
        if (sessionId === 'bound-create-session') {
          sessionBound.resolve();
        }
      });

      const createOutcome = service.createSession(mockAgentProcessConfig).then(
        (result) => result,
        (error) => error as Error,
      );
      await sessionBound.promise;
      const stop = service.stopAgent();
      const [outcome] = await Promise.all([createOutcome, stop]);

      expect(outcome).toMatchObject({ name: 'AcpAgentServiceStoppingError' });
      expect(
        mockTerminalHandler.releaseSessionTerminals.mock.calls.filter(([id]) => id === 'bound-create-session'),
      ).toHaveLength(1);
    });

    it('lets disposeSession close a bound create operation without stop replaying its identity', async () => {
      const newSession = jest.fn().mockResolvedValue({ sessionId: 'dispose-bound-create' });
      const thread = createConnectedAcpThread({ newSession });
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));
      (service as any).availableCommandsWaitMs = 5000;
      const sessionBound = createDeferred();
      const bindSession = (service as any).bindSession.bind(service);
      jest.spyOn(service as any, 'bindSession').mockImplementation((sessionId: string, boundThread: AcpThread) => {
        bindSession(sessionId, boundThread);
        if (sessionId === 'dispose-bound-create') {
          sessionBound.resolve();
        }
      });

      const createOutcome = service.createSession(mockAgentProcessConfig).then(
        (result) => result,
        (error) => error as Error,
      );
      await sessionBound.promise;

      await service.disposeSession('dispose-bound-create');
      const outcome = await createOutcome;

      expect(outcome).toBeInstanceOf(Error);
      expect((service as any).sessions.has('dispose-bound-create')).toBe(false);
      expect(
        mockTerminalHandler.releaseSessionTerminals.mock.calls.filter(([id]) => id === 'dispose-bound-create'),
      ).toHaveLength(1);

      await service.stopAgent();

      expect(
        mockTerminalHandler.releaseSessionTerminals.mock.calls.filter(([id]) => id === 'dispose-bound-create'),
      ).toHaveLength(1);
    });

    it('automatically releases a real session id observed after terminal disposal already timed out', async () => {
      const newSessionGate = createDeferred<{ sessionId: string }>();
      const newSession = jest.fn(() => newSessionGate.promise);
      const thread = new AcpThread({
        ...mockAgentProcessConfig,
        fileSystemHandler: {} as any,
        terminalHandler: mockTerminalHandler as any,
        permissionRouting: mockPermissionRouting as any,
        logger: mockLogger,
      });
      (thread as any)._initialized = true;
      (thread as any)._connected = true;
      (thread as any)._connection = { newSession };
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));
      (service as any).stopLeaseMs = 20;

      const createOutcome = service.createSession(mockAgentProcessConfig).then(
        (result) => result,
        (error) => error as Error,
      );
      await flushAsyncWork();
      expect(newSession).toHaveBeenCalledTimes(1);

      const disposeOutcome = await service.dispose().then(
        () => undefined,
        (error) => error as AggregateError,
      );
      expect(disposeOutcome).toBeInstanceOf(AggregateError);
      expect(disposeOutcome?.errors).toEqual(
        expect.arrayContaining([expect.objectContaining({ name: 'AcpAgentServiceStopTimeoutError' })]),
      );
      expect(mockTerminalHandler.releaseSessionTerminals).not.toHaveBeenCalled();

      newSessionGate.resolve({ sessionId: 'late-real-session' });
      expect(await createOutcome).toMatchObject({ name: 'AcpAgentServiceDisposedError' });
      await flushAsyncWork();

      expect(mockTerminalHandler.releaseSessionTerminals).toHaveBeenCalledTimes(1);
      expect(mockTerminalHandler.releaseSessionTerminals).toHaveBeenCalledWith('late-real-session');
      expect((service as any).pendingTerminalReleaseIds.size).toBe(0);
      expect((service as any).lateTerminalReleaseIds.size).toBe(0);
      expect((service as any).sessions.size).toBe(0);
      expect(thread.sessionId).toBe('');
      expect(thread.needsReset).toBe(false);
      expect(thread.isConnected).toBe(false);
      await expect(service.createSession(mockAgentProcessConfig)).rejects.toMatchObject({
        name: 'AcpAgentServiceDisposedError',
      });
    });

    it('releases a late fallback session id without double-releasing the retired load identity', async () => {
      const newSessionGate = createDeferred<{ sessionId: string }>();
      const newSessionStarted = createDeferred();
      const loadSession = jest.fn().mockRejectedValue(new Error('session not found'));
      const newSession = jest.fn(() => {
        newSessionStarted.resolve();
        return newSessionGate.promise;
      });
      const thread = new AcpThread({
        ...mockAgentProcessConfig,
        fileSystemHandler: {} as any,
        terminalHandler: mockTerminalHandler as any,
        permissionRouting: mockPermissionRouting as any,
        logger: mockLogger,
      });
      (thread as any)._initialized = true;
      (thread as any)._connected = true;
      (thread as any)._connection = { loadSession, newSession };
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));
      (service as any).stopLeaseMs = 20;
      const terminalReleaseFinished = createDeferred();
      const allowStopToClearSessions = createDeferred();
      const releasePendingTerminals = (service as any).releasePendingTerminals.bind(service);
      let releasePass = 0;
      jest.spyOn(service as any, 'releasePendingTerminals').mockImplementation(async (...args: any[]) => {
        const errors = await releasePendingTerminals(...args);
        releasePass += 1;
        if (releasePass === 1) {
          terminalReleaseFinished.resolve();
          await allowStopToClearSessions.promise;
        }
        return errors;
      });

      const loadOutcome = service.loadSessionOrNew('missing-session', mockAgentProcessConfig).then(
        (result) => result,
        (error) => error as Error,
      );
      await newSessionStarted.promise;
      expect(loadSession).toHaveBeenCalledTimes(1);
      expect(newSession).toHaveBeenCalledTimes(1);

      const disposeOutcomePromise = service.dispose().then(
        () => undefined,
        (error) => error as AggregateError,
      );
      await terminalReleaseFinished.promise;
      expect((service as any).sessions.has('missing-session')).toBe(true);
      expect((service as any).pendingTerminalReleaseIds.has('missing-session')).toBe(false);
      expect(mockTerminalHandler.releaseSessionTerminals).toHaveBeenCalledTimes(1);
      expect(mockTerminalHandler.releaseSessionTerminals).toHaveBeenCalledWith('missing-session');

      newSessionGate.resolve({ sessionId: 'late-fallback-session' });
      expect(await loadOutcome).toMatchObject({ name: 'AcpAgentServiceDisposedError' });
      await flushAsyncWork();

      expect(
        mockTerminalHandler.releaseSessionTerminals.mock.calls.filter(([id]) => id === 'missing-session'),
      ).toHaveLength(1);

      allowStopToClearSessions.resolve();
      const disposeOutcome = await disposeOutcomePromise;
      expect(disposeOutcome).toBeInstanceOf(AggregateError);
      await flushAsyncWork();

      expect(
        mockTerminalHandler.releaseSessionTerminals.mock.calls.filter(([id]) => id === 'missing-session'),
      ).toHaveLength(1);
      expect(
        mockTerminalHandler.releaseSessionTerminals.mock.calls.filter(([id]) => id === 'late-fallback-session'),
      ).toHaveLength(1);
      expect((service as any).pendingTerminalReleaseIds.size).toBe(0);
      expect((service as any).lateTerminalReleaseIds.size).toBe(0);
      expect((service as any).sessions.size).toBe(0);
      expect(thread.sessionId).not.toBe('late-fallback-session');
    });

    it('treats a fallback-created session that reuses the requested string as a new cleanup generation', async () => {
      const newSessionGate = createDeferred<{ sessionId: string }>();
      const newSessionStarted = createDeferred();
      const loadSession = jest.fn().mockRejectedValue(new Error('session not found'));
      const newSession = jest.fn(() => {
        newSessionStarted.resolve();
        return newSessionGate.promise;
      });
      const thread = createConnectedAcpThread({ loadSession, newSession });
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));
      (service as any).stopLeaseMs = 15;

      const loadOutcome = service.loadSessionOrNew('same-session-id', mockAgentProcessConfig).then(
        (result) => result,
        (error) => error as Error,
      );
      await newSessionStarted.promise;

      const disposeOutcome = await service.dispose().then(
        () => undefined,
        (error) => error as AggregateError,
      );
      expect(disposeOutcome).toBeInstanceOf(AggregateError);
      expect(
        mockTerminalHandler.releaseSessionTerminals.mock.calls.filter(([id]) => id === 'same-session-id'),
      ).toHaveLength(1);

      newSessionGate.resolve({ sessionId: 'same-session-id' });
      expect(await loadOutcome).toMatchObject({ name: 'AcpAgentServiceDisposedError' });
      await flushAsyncWork();

      expect(
        mockTerminalHandler.releaseSessionTerminals.mock.calls.filter(([id]) => id === 'same-session-id'),
      ).toHaveLength(2);
    });

    it('lets disposeSession own a pending ordinary load without a second requested-id release', async () => {
      const loadGate = createDeferred<{ sessionId: string }>();
      const loadStarted = createDeferred();
      const loadSession = jest.fn(() => {
        loadStarted.resolve();
        return loadGate.promise;
      });
      const thread = createConnectedAcpThread({ loadSession });
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));

      const loadOutcome = service.loadSession('pending-dispose-session', mockAgentProcessConfig).then(
        (result) => result,
        (error) => error as Error,
      );
      await loadStarted.promise;
      const disposal = service.disposeSession('pending-dispose-session');
      await flushAsyncWork();
      expect(
        mockTerminalHandler.releaseSessionTerminals.mock.calls.filter(([id]) => id === 'pending-dispose-session'),
      ).toHaveLength(1);

      loadGate.resolve({ sessionId: 'pending-dispose-session' });
      expect(await loadOutcome).toBeInstanceOf(Error);
      await disposal;

      expect(
        mockTerminalHandler.releaseSessionTerminals.mock.calls.filter(([id]) => id === 'pending-dispose-session'),
      ).toHaveLength(1);
      expect((service as any).sessions.has('pending-dispose-session')).toBe(false);
    });

    it('disposes both identities when fallback is rebound and default options are still pending', async () => {
      const defaultsGate = createDeferred<Record<string, never>>();
      const defaultsStarted = createDeferred();
      const loadSession = jest.fn().mockRejectedValue(new Error('session not found'));
      const newSession = jest.fn().mockResolvedValue({
        sessionId: 'fallback-actual-session',
        configOptions: [{ id: 'permission', type: 'boolean' }],
      });
      const setSessionConfigOption = jest.fn(() => {
        defaultsStarted.resolve();
        return defaultsGate.promise;
      });
      const thread = createConnectedAcpThread({ loadSession, newSession, setSessionConfigOption });
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));
      const config = {
        ...mockAgentProcessConfig,
        defaultConfigOptions: { permission: true },
      };

      const loadOutcome = service.loadSessionOrNew('fallback-requested-session', config).then(
        (result) => result,
        (error) => error as Error,
      );
      await defaultsStarted.promise;
      expect((service as any).sessions.has('fallback-requested-session')).toBe(false);
      expect((service as any).sessions.get('fallback-actual-session')).toBe(thread);
      expect(
        mockTerminalHandler.releaseSessionTerminals.mock.calls.filter(([id]) => id === 'fallback-requested-session'),
      ).toHaveLength(1);

      const disposal = service.disposeSession('fallback-requested-session');
      await flushAsyncWork();
      defaultsGate.resolve({});
      expect(await loadOutcome).toBeInstanceOf(Error);
      await disposal;

      expect(
        mockTerminalHandler.releaseSessionTerminals.mock.calls.filter(([id]) => id === 'fallback-requested-session'),
      ).toHaveLength(1);
      expect(
        mockTerminalHandler.releaseSessionTerminals.mock.calls.filter(([id]) => id === 'fallback-actual-session'),
      ).toHaveLength(1);
      expect((service as any).sessions.has('fallback-actual-session')).toBe(false);
      expect((service as any).sessionRefCounts.has('fallback-actual-session')).toBe(false);
    });

    it('keeps a late fallback join retained after the actual id is rebound', async () => {
      const defaultsGate = createDeferred<Record<string, never>>();
      const defaultsStarted = createDeferred();
      const loadSession = jest.fn().mockRejectedValue(new Error('session not found'));
      const newSession = jest.fn().mockResolvedValue({
        sessionId: 'late-join-actual',
        configOptions: [{ id: 'permission', type: 'boolean' }],
      });
      const setSessionConfigOption = jest.fn(() => {
        defaultsStarted.resolve();
        return defaultsGate.promise;
      });
      const thread = createConnectedAcpThread({ loadSession, newSession, setSessionConfigOption });
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));
      const config = { ...mockAgentProcessConfig, defaultConfigOptions: { permission: true } };

      const firstLoad = service.loadSessionOrNew('late-join-requested', config);
      await defaultsStarted.promise;
      const secondLoad = service.loadSessionOrNew('late-join-requested', config);
      await flushAsyncWork();

      expect((service as any).sessionRefCounts.get('late-join-actual')).toBe(2);
      await service.disposeSession('late-join-actual');
      expect((service as any).sessions.get('late-join-actual')).toBe(thread);
      expect((service as any).sessionRefCounts.get('late-join-actual')).toBe(1);
      expect(
        mockTerminalHandler.releaseSessionTerminals.mock.calls.filter(([id]) => id === 'late-join-actual'),
      ).toHaveLength(0);

      defaultsGate.resolve({});
      await expect(Promise.all([firstLoad, secondLoad])).resolves.toEqual([
        expect.objectContaining({ sessionId: 'late-join-actual' }),
        expect.objectContaining({ sessionId: 'late-join-actual' }),
      ]);

      await service.disposeSession('late-join-actual');
      expect(
        mockTerminalHandler.releaseSessionTerminals.mock.calls.filter(([id]) => id === 'late-join-actual'),
      ).toHaveLength(1);
    });

    it('carries early fallback joins into the rebound actual-id refcount', async () => {
      const loadGate = createDeferred<{ sessionId: string }>();
      const loadStarted = createDeferred();
      const loadSession = jest.fn(() => {
        loadStarted.resolve();
        return loadGate.promise;
      });
      const newSession = jest.fn().mockResolvedValue({ sessionId: 'early-join-actual' });
      const thread = createConnectedAcpThread({ loadSession, newSession });
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));

      const firstLoad = service.loadSessionOrNew('early-join-requested', mockAgentProcessConfig);
      await loadStarted.promise;
      const secondLoad = service.loadSessionOrNew('early-join-requested', mockAgentProcessConfig);
      loadGate.reject(new Error('session not found'));

      await expect(Promise.all([firstLoad, secondLoad])).resolves.toEqual([
        expect.objectContaining({ sessionId: 'early-join-actual' }),
        expect.objectContaining({ sessionId: 'early-join-actual' }),
      ]);
      expect((service as any).sessionRefCounts.get('early-join-actual')).toBe(2);

      await service.disposeSession('early-join-actual');
      expect((service as any).sessions.get('early-join-actual')).toBe(thread);
      expect((service as any).sessionRefCounts.get('early-join-actual')).toBe(1);
      await service.disposeSession('early-join-actual');
      expect(
        mockTerminalHandler.releaseSessionTerminals.mock.calls.filter(([id]) => id === 'early-join-actual'),
      ).toHaveLength(1);
    });

    it('holds a live-create retirement fence until its blocked cleanup completes', async () => {
      const defaultsGate = createDeferred<Record<string, never>>();
      const defaultsStarted = createDeferred();
      const newSession = jest.fn().mockResolvedValue({
        sessionId: 'blocked-create-session',
        configOptions: [{ id: 'permission', type: 'boolean' }],
      });
      const setSessionConfigOption = jest.fn(() => {
        defaultsStarted.resolve();
        return defaultsGate.promise;
      });
      const creatingThread = createConnectedAcpThread({ newSession, setSessionConfigOption });
      const replacementThread = createConnectedAcpThread({
        loadSession: jest.fn().mockResolvedValue({ sessionId: 'replacement-session' }),
      });
      const factory = jest.fn().mockReturnValueOnce(creatingThread).mockReturnValueOnce(replacementThread);
      const service = setupServiceWithMockFactory(factory);
      const config = { ...mockAgentProcessConfig, defaultConfigOptions: { permission: true } };

      const createOutcome = service.createSession(config).then(
        (result) => result,
        (error) => error as Error,
      );
      await defaultsStarted.promise;

      let disposalSettled = false;
      const disposal = service.disposeSession('blocked-create-session').then(() => {
        disposalSettled = true;
      });
      await flushAsyncWork();
      expect(disposalSettled).toBe(false);

      const replacement = await service.loadSession('replacement-session', mockAgentProcessConfig);
      expect(replacement.processId).toBe(replacementThread.threadId);

      defaultsGate.resolve({});
      expect(await createOutcome).toBeInstanceOf(Error);
      await disposal;

      expect((service as any).sessions.get('replacement-session')).toBe(replacementThread);
      expect(replacementThread.sessionId).toBe('replacement-session');
      expect(
        mockTerminalHandler.releaseSessionTerminals.mock.calls.filter(([id]) => id === 'blocked-create-session'),
      ).toHaveLength(1);
    });

    it('bounds a stuck thread process kill without losing the retirement operation', async () => {
      const processKillGate = createDeferred();
      const thread = createMockThread({ dispose: jest.fn(() => processKillGate.promise) });
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));
      (service as any).stopLeaseMs = 20;
      (service as any).threadPool.push(thread);

      const stopOutcome = await service.stopAgent().then(
        () => undefined,
        (error) => error as AggregateError,
      );
      expect(stopOutcome).toBeInstanceOf(AggregateError);
      expect(thread.dispose).toHaveBeenCalledTimes(1);
      expect((service as any).pendingRetirementOperations.size).toBe(1);

      processKillGate.resolve();
      await flushAsyncWork();
      expect((service as any).pendingRetirementOperations.size).toBe(0);
      await service.stopAgent();

      expect(thread.dispose).toHaveBeenCalledTimes(1);
      expect((service as any).stopping).toBe(false);
    });

    it('ends active attachments before disposing their session thread', async () => {
      expect.hasAssertions();
      const lifecycle: string[] = [];
      const threadDisposal = createDeferred();
      const attachmentSubscription = {
        dispose: jest.fn(() => {
          lifecycle.push('attachment-dispose');
        }),
      };
      const thread = createMockThread({
        dispose: jest.fn(async () => {
          lifecycle.push('thread-dispose');
          await threadDisposal.promise;
        }),
        onEvent: jest.fn(() => attachmentSubscription),
      });
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));
      (service as any).threadPool.push(thread);
      (service as any).sessions.set('attached-session', thread);

      const attachment = service.attachSession('attached-session');
      const attachmentEnd = jest.fn();
      attachment.onEnd(attachmentEnd);

      const stop = service.stopAgent();
      await flushAsyncWork();

      expect(attachmentEnd).toHaveBeenCalledTimes(1);
      expect(attachmentSubscription.dispose).toHaveBeenCalledTimes(1);
      expect(lifecycle).toEqual(['attachment-dispose', 'thread-dispose']);

      const rejectedErrors: Error[] = [];
      service.attachSession('attached-session').onError((error) => rejectedErrors.push(error));
      await flushAsyncWork();
      expect(rejectedErrors).toHaveLength(1);
      expect(rejectedErrors[0].name).toBe('AcpAgentServiceStoppingError');

      threadDisposal.resolve();
      await stop;
    });

    it('releases every session terminal and still clears threads when one release fails', async () => {
      expect.hasAssertions();
      const firstThread = createMockThread();
      const secondThread = createMockThread();
      const service = setupServiceWithMockFactory(jest.fn());
      (service as any).threadPool.push(firstThread, secondThread);
      (service as any).sessions.set('first-session', firstThread);
      (service as any).sessions.set('second-session', secondThread);
      const eventEmitterDisposal = jest.spyOn((service as any)._onThreadStatusChange, 'dispose');
      const releaseError = new Error('terminal cleanup failed');
      mockTerminalHandler.releaseSessionTerminals.mockImplementation(async (sessionId: string) => {
        if (sessionId === 'first-session') {
          throw releaseError;
        }
      });

      const outcome = await service.dispose().then(
        () => undefined,
        (error) => error as Error,
      );

      expect(outcome).toBeInstanceOf(AggregateError);
      expect((outcome as AggregateError).errors).toEqual([releaseError]);
      expect(mockTerminalHandler.releaseSessionTerminals).toHaveBeenCalledTimes(3);
      expect(mockTerminalHandler.releaseSessionTerminals).toHaveBeenCalledWith('first-session');
      expect(mockTerminalHandler.releaseSessionTerminals).toHaveBeenCalledWith('second-session');
      expect(firstThread.dispose).toHaveBeenCalledTimes(1);
      expect(secondThread.dispose).toHaveBeenCalledTimes(1);
      expect(eventEmitterDisposal).toHaveBeenCalledTimes(1);
      expect((service as any).sessions.size).toBe(0);
      expect((service as any).threadPool).toHaveLength(0);
    });

    it('retains a failed terminal release for the next stop without clearing a newer session', async () => {
      const releaseError = new Error('retry terminal cleanup');
      mockTerminalHandler.releaseSessionTerminals.mockRejectedValueOnce(releaseError).mockResolvedValue(undefined);
      const oldThread = createMockThread();
      const newThread = createMockThread();
      newThread.newSession.mockImplementation(async () => {
        newThread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'new-session',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
        return { sessionId: 'new-session' };
      });
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(newThread));
      (service as any).threadPool.push(oldThread);
      (service as any).sessions.set('old-session', oldThread);

      const firstOutcome = await service.stopAgent().then(
        () => undefined,
        (error) => error as AggregateError,
      );

      expect(firstOutcome).toBeInstanceOf(AggregateError);
      expect(firstOutcome?.errors).toEqual([releaseError]);
      expect((service as any).pendingTerminalReleaseIds).toEqual(new Set(['old-session']));
      expect((service as any).stopping).toBe(false);

      const created = await service.createSession(mockAgentProcessConfig);
      expect(created.sessionId).toBe('new-session');
      expect((service as any).sessions.get('new-session')).toBe(newThread);

      await service.stopAgent();

      expect(
        mockTerminalHandler.releaseSessionTerminals.mock.calls.filter(([id]) => id === 'old-session'),
      ).toHaveLength(2);
      expect(
        mockTerminalHandler.releaseSessionTerminals.mock.calls.filter(([id]) => id === 'new-session'),
      ).toHaveLength(1);
      expect((service as any).pendingTerminalReleaseIds.size).toBe(0);
      expect((service as any).sessions.size).toBe(0);
    });

    it('reuses an in-flight terminal release after a stop timeout instead of releasing twice', async () => {
      const terminalGate = createDeferred();
      mockTerminalHandler.releaseSessionTerminals.mockReturnValue(terminalGate.promise);
      const thread = createMockThread();
      const service = setupServiceWithMockFactory(jest.fn().mockReturnValue(thread));
      (service as any).stopLeaseMs = 20;
      (service as any).threadPool.push(thread);
      (service as any).sessions.set('slow-terminal-session', thread);

      const firstOutcome = await service.stopAgent().then(
        () => undefined,
        (error) => error as AggregateError,
      );
      expect(firstOutcome).toBeInstanceOf(AggregateError);
      expect((service as any).stopping).toBe(true);
      expect(mockTerminalHandler.releaseSessionTerminals).toHaveBeenCalledTimes(1);

      const retry = service.stopAgent();
      await flushAsyncWork();
      expect(mockTerminalHandler.releaseSessionTerminals).toHaveBeenCalledTimes(1);

      terminalGate.resolve();
      await retry;

      expect(mockTerminalHandler.releaseSessionTerminals).toHaveBeenCalledTimes(1);
      expect((service as any).stopping).toBe(false);
      expect((service as any).pendingTerminalReleaseIds.size).toBe(0);
    });

    it('does not create an incompatible warmup replacement after shutdown begins', async () => {
      const initializeGate = createDeferred<any>();
      const warmingThread = createMockThread();
      warmingThread.initialize.mockImplementation(async () => {
        await initializeGate.promise;
        warmingThread.initialized = true;
        return { protocolVersion: 1, agentCapabilities: {} };
      });
      const replacementThread = createMockThread();
      const mockFactory = jest.fn().mockReturnValueOnce(warmingThread).mockReturnValueOnce(replacementThread);
      const service = setupServiceWithMockFactory(mockFactory);
      const warmupConfig = { ...mockAgentProcessConfig, cwd: '/workspace-a', threadPoolSize: 1 };
      const foregroundConfig = { ...mockAgentProcessConfig, cwd: '/workspace-b', threadPoolSize: 1 };

      const warmup = service.warmUpAgentPool(warmupConfig);
      const createOutcome = service.createSession(foregroundConfig).then(
        (result) => result,
        (error) => error as Error,
      );
      await flushAsyncWork();
      expect((service as any).reservedThreads.has(warmingThread)).toBe(true);

      const stop = service.stopAgent();
      await flushAsyncWork();

      expect(mockFactory).toHaveBeenCalledTimes(1);
      expect(warmingThread.dispose).toHaveBeenCalledTimes(1);

      initializeGate.resolve({ protocolVersion: 1, agentCapabilities: {} });
      const [, outcome] = await Promise.all([warmup, createOutcome, stop]);

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).name).toBe('AcpAgentServiceStoppingError');
      expect(mockFactory).toHaveBeenCalledTimes(1);
      expect(replacementThread.initialize).not.toHaveBeenCalled();
      expect(replacementThread.dispose).not.toHaveBeenCalled();
      expect(warmingThread.dispose).toHaveBeenCalledTimes(1);
      expect((service as any).threadPool).toHaveLength(0);
    });
  });

  // -----------------------------------------------------------------------
  // dispose
  // -----------------------------------------------------------------------

  describe('dispose()', () => {
    it('should call stopAgent and clean up', async () => {
      const { service, thread } = createServiceWithAutoEvents();

      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      await service.createSession(mockAgentProcessConfig);
      await service.dispose();

      expect(thread.dispose).toHaveBeenCalled();
    });

    it('should share one disposal when the lifecycle contribution and container both stop it', async () => {
      const { service } = createService();
      const stopAgent = jest.spyOn(service, 'stopAgent').mockResolvedValue(undefined);

      const contributionDisposal = service.dispose();
      const containerDisposal = service.dispose();

      expect(containerDisposal).toBe(contributionDisposal);
      await Promise.all([contributionDisposal, containerDisposal]);
      expect(stopAgent).toHaveBeenCalledTimes(1);
    });

    it('should reject new session acquisition after terminal disposal', async () => {
      const { service, mockFactory } = createService();

      await service.dispose();

      await expect(service.createSession(mockAgentProcessConfig)).rejects.toMatchObject({
        name: 'AcpAgentServiceDisposedError',
        message: 'ACP Agent service is disposed',
      });
      expect(mockFactory).not.toHaveBeenCalled();
    });

    it('should dispose the container-owned agent service during application shutdown', async () => {
      const agentService = { dispose: jest.fn().mockResolvedValue(undefined) };
      const contribution = new AcpAgentLifecycleContribution();
      Object.defineProperty(contribution, 'agentService', { value: agentService });

      await contribution.onStop();

      expect(agentService.dispose).toHaveBeenCalledTimes(1);
    });
  });

  // -----------------------------------------------------------------------
  // getSessionInfo
  // -----------------------------------------------------------------------

  describe('getSessionInfo()', () => {
    it('should return null initially (no sessionId)', () => {
      const { service } = createService();
      expect(service.getSessionInfo()).toBeNull();
    });

    it('should return null for unknown sessionId', () => {
      const { service } = createService();
      expect(service.getSessionInfo('unknown')).toBeNull();
    });

    it('should return session info for active session', async () => {
      const { service, thread } = createServiceWithAutoEvents();

      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      const result = await service.createSession(mockAgentProcessConfig);
      const info = service.getSessionInfo(result.sessionId);

      expect(info).not.toBeNull();
      expect(info?.sessionId).toBe(result.sessionId);
      expect(info?.processId).toBe(thread.threadId);
      expect(info?.status).toBe('ready');
    });
  });

  // -----------------------------------------------------------------------
  // listSessions
  // -----------------------------------------------------------------------

  describe('listSessions()', () => {
    it('should return all active sessions', async () => {
      const { service } = createServiceWithAutoEvents();

      for (let i = 0; i < 2; i++) {
        const t = createMockThread({
          newSession: jest.fn().mockResolvedValue({ sessionId: `session-${i}` }),
          listSessions: jest.fn().mockResolvedValue({
            sessions: [{ sessionId: `session-${i}`, cwd: mockAgentProcessConfig.cwd, title: `Session ${i}` }],
          }),
          onEvent: jest.fn((cb: any) => {
            setTimeout(() => {
              cb({
                type: 'session_notification',
                notification: {
                  sessionId: `session-${i}`,
                  update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
                },
              });
            }, 10);
            return { dispose: jest.fn() };
          }),
        });
        (service as any).threadFactory.mockReturnValueOnce(t);
        await service.createSession(mockAgentProcessConfig);
      }

      const result = await service.listSessions();

      expect(result.sessions).toHaveLength(2);
      expect(result.nextCursor).toBeUndefined();
    });

    it('should initialize an idle thread to list sessions when no sessions are active', async () => {
      const { service, mockFactory, thread } = createService();
      thread.listSessions.mockResolvedValue({
        sessions: [{ sessionId: 'history-session', cwd: mockAgentProcessConfig.cwd, title: 'History Session' }],
        nextCursor: 'cursor-1',
      });

      const result = await service.listSessions({ cwd: mockAgentProcessConfig.cwd }, mockAgentProcessConfig);

      expect(mockFactory).toHaveBeenCalledTimes(1);
      expect(thread.initialize).toHaveBeenCalledWith(expect.objectContaining(mockAgentProcessConfig));
      expect(thread.listSessions).toHaveBeenCalledWith({ cwd: mockAgentProcessConfig.cwd });
      expect(result).toEqual({
        sessions: [{ sessionId: 'history-session', cwd: mockAgentProcessConfig.cwd, title: 'History Session' }],
        nextCursor: 'cursor-1',
      });
      expect((service as any).sessions.size).toBe(0);
      expect((service as any).reservedThreads.has(thread)).toBe(false);
    });

    it('显式配置列会话时应忽略不兼容的活跃线程并查询匹配配置', async () => {
      const { service, mockFactory, thread: activeThread } = createServiceWithAutoEvents();

      setTimeout(() => {
        activeThread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'new-session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);
      await service.createSession(mockAgentProcessConfig);

      const requestedConfig = {
        ...mockAgentProcessConfig,
        agentId: 'history-agent',
        args: ['test/bdd/fixtures/acp-agent/mock-acp-agent.ts', '--fixture=history'],
      };
      const requestedThread = createMockThread({
        listSessions: jest.fn().mockResolvedValue({
          sessions: [{ sessionId: 'history-session', cwd: requestedConfig.cwd, title: 'History Session' }],
          nextCursor: 'history-cursor',
        }),
      });
      mockFactory.mockReturnValueOnce(requestedThread);

      const result = await service.listSessions({ cwd: requestedConfig.cwd }, requestedConfig);

      expect(activeThread.listSessions).not.toHaveBeenCalled();
      expect(requestedThread.initialize).toHaveBeenCalledWith(expect.objectContaining(requestedConfig));
      expect(requestedThread.listSessions).toHaveBeenCalledWith({ cwd: requestedConfig.cwd });
      expect(result).toEqual({
        sessions: [{ sessionId: 'history-session', cwd: requestedConfig.cwd, title: 'History Session' }],
        nextCursor: 'history-cursor',
      });
      expect((service as any).reservedThreads.has(requestedThread)).toBe(false);
    });
  });

  // -----------------------------------------------------------------------
  // setSessionMode
  // -----------------------------------------------------------------------

  describe('setSessionMode()', () => {
    it('should log but not throw for existing session', async () => {
      const { service, thread } = createServiceWithAutoEvents();

      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      const result = await service.createSession(mockAgentProcessConfig);
      await service.setSessionMode({ sessionId: result.sessionId, modeId: 'code' });

      expect(mockLogger.log).toHaveBeenCalled();
    });

    it('should throw if session not found', async () => {
      const { service } = createService();
      await expect(service.setSessionMode({ sessionId: 'nonexistent', modeId: 'code' })).rejects.toThrow(
        'No active session',
      );
    });
  });

  // -----------------------------------------------------------------------
  // getAvailableModes
  // -----------------------------------------------------------------------

  describe('getAvailableModes()', () => {
    it('should return null (not implemented yet)', async () => {
      const { service } = createService();
      const result = await service.getAvailableModes();
      expect(result).toBeNull();
    });
  });

  // -----------------------------------------------------------------------
  // Thread pool semantics
  // -----------------------------------------------------------------------

  describe('Thread pool semantics', () => {
    it('should reuse idle threads for new sessions', async () => {
      const { service, mockFactory, thread } = createServiceWithAutoEvents();

      // After first session, mark thread as needing reset (simulating bound session)
      thread.needsReset = true;

      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-1',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      // Create first session
      const result1 = await service.createSession(mockAgentProcessConfig);
      expect(mockFactory).toHaveBeenCalledTimes(1);

      // Dispose session (thread returns to pool as idle, but still needsReset=true)
      await service.disposeSession(result1.sessionId);

      // Reset the mock factory for next call tracking
      mockFactory.mockClear();
      mockFactory.mockReturnValue(thread); // Return same thread

      // Create second session - should reuse idle thread
      setTimeout(() => {
        thread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'session-2',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);

      const result2 = await service.createSession(mockAgentProcessConfig);
      expect(mockFactory).toHaveBeenCalledTimes(0); // No new thread created

      // The thread should have been reset (needsReset was true, so reset was called)
      expect(thread.reset).toHaveBeenCalled();
    });

    it('should dispose incompatible idle threads instead of reusing them for different agent process configs', async () => {
      const firstThread = createMockThread({
        newSession: jest.fn().mockResolvedValue({ sessionId: 'fixture-a-session' }),
      });
      const secondThread = createMockThread({
        newSession: jest.fn().mockResolvedValue({ sessionId: 'fixture-b-session' }),
      });
      const mockFactory = jest.fn().mockReturnValueOnce(firstThread).mockReturnValueOnce(secondThread);
      const service = setupServiceWithMockFactory(mockFactory);
      const configA = {
        ...mockAgentProcessConfig,
        args: ['mock-acp-agent.ts', '--fixture=load-failure'],
        env: [{ name: 'OPENSUMI_ACP_BDD_FIXTURE', value: 'load-failure' }],
        threadPoolSize: 1,
      };
      const configB = {
        ...mockAgentProcessConfig,
        args: ['mock-acp-agent.ts', '--fixture=history'],
        env: [{ name: 'OPENSUMI_ACP_BDD_FIXTURE', value: 'history' }],
        threadPoolSize: 1,
      };

      setTimeout(() => {
        firstThread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'fixture-a-session',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);
      const result1 = await service.createSession(configA);

      await service.disposeSession(result1.sessionId);

      setTimeout(() => {
        secondThread._fireEvent({
          type: 'session_notification',
          notification: {
            sessionId: 'fixture-b-session',
            update: { sessionUpdate: 'available_commands_update', availableCommands: [] },
          },
        });
      }, 10);
      const result2 = await service.createSession(configB);

      expect(result2.sessionId).toBe('fixture-b-session');
      expect(mockFactory).toHaveBeenCalledTimes(2);
      expect(firstThread.dispose).toHaveBeenCalledTimes(1);
      expect(firstThread.reset).not.toHaveBeenCalled();
      expect(secondThread.initialize).toHaveBeenCalledWith(
        expect.objectContaining({ args: configB.args, env: configB.env }),
      );
    });

    it('should track maxPoolSize correctly', async () => {
      const { service } = createService();
      expect((service as any).maxPoolSize).toBe(DEFAULT_ACP_THREAD_POOL_SIZE);
    });

    it('should apply configured maxPoolSize from agent process config', async () => {
      const { service } = createService();
      (service as any).syncMaxPoolSize({ ...mockAgentProcessConfig, threadPoolSize: 4 });
      expect((service as any).maxPoolSize).toBe(4);
    });
  });

  // -----------------------------------------------------------------------
  // parseDataUrl
  // -----------------------------------------------------------------------

  describe('parseDataUrl()', () => {
    it('should extract mimeType and base64Data from data URLs', () => {
      const { service } = createService();
      const result = (service as any).parseDataUrl('data:image/png;base64,helloWorld');
      expect(result).toEqual({ mimeType: 'image/png', base64Data: 'helloWorld' });
    });

    it('should return default mimeType for non-data URLs', () => {
      const { service } = createService();
      const result = (service as any).parseDataUrl('not-a-data-url');
      expect(result).toEqual({ mimeType: 'image/jpeg', base64Data: 'not-a-data-url' });
    });
  });
});
