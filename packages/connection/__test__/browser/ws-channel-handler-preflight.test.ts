import { WSChannelHandler, WSChannelPreflight } from '../../src/browser/ws-channel-handler';
import { ChannelMessage } from '../../src/common/channel/types';
import { IRuntimeSocketConnection } from '../../src/common/connection';
import { ISerializer } from '../../src/common/serializer';

const identitySerializer: ISerializer<ChannelMessage, ChannelMessage> = {
  deserialize: (message) => message,
  serialize: (message) => message,
};

function createDeferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let index = 0; index < 20 && !predicate(); index++) {
    await Promise.resolve();
  }
  expect(predicate()).toBe(true);
}

class TestRuntimeConnection implements IRuntimeSocketConnection<ChannelMessage> {
  private open = true;
  private readonly messageListeners = new Set<(message: ChannelMessage) => void>();
  private readonly openListeners = new Set<() => void>();
  private readonly closeListeners = new Set<(code?: number, reason?: string) => void>();
  private readonly errorListeners = new Set<(error: Error) => void>();

  readonly sentMessages: ChannelMessage[] = [];
  onSend?: (message: ChannelMessage) => void;

  isOpen(): boolean {
    return this.open;
  }

  send(message: ChannelMessage): void {
    this.sentMessages.push(message);
    this.onSend?.(message);
  }

  onMessage(listener: (message: ChannelMessage) => void) {
    this.messageListeners.add(listener);
    return { dispose: () => this.messageListeners.delete(listener) };
  }

  onceClose(listener: (code?: number, reason?: string) => void) {
    const once = (code?: number, reason?: string) => {
      this.closeListeners.delete(once);
      listener(code, reason);
    };
    this.closeListeners.add(once);
    return { dispose: () => this.closeListeners.delete(once) };
  }

  onOpen(listener: () => void) {
    this.openListeners.add(listener);
    return { dispose: () => this.openListeners.delete(listener) };
  }

  onClose(listener: (code?: number, reason?: string) => void) {
    this.closeListeners.add(listener);
    return { dispose: () => this.closeListeners.delete(listener) };
  }

  onError(listener: (error: Error) => void) {
    this.errorListeners.add(listener);
    return { dispose: () => this.errorListeners.delete(listener) };
  }

  emitMessage(message: ChannelMessage): void {
    for (const listener of this.messageListeners) {
      listener(message);
    }
  }

  emitClose(code = 1006, reason = 'transport lost'): void {
    this.open = false;
    for (const listener of Array.from(this.closeListeners)) {
      listener(code, reason);
    }
  }

  emitOpen(): void {
    this.open = true;
    for (const listener of this.openListeners) {
      listener();
    }
  }

  dispose(): void {
    this.open = false;
  }
}

function createHandler(connection: TestRuntimeConnection, preflight: WSChannelPreflight, logger = createLogger()) {
  return new WSChannelHandler(connection as unknown as IRuntimeSocketConnection<Uint8Array>, 'preflight-client', {
    logger,
    preflight,
    serializer: identitySerializer,
  });
}

function createLogger() {
  return { error: jest.fn(), log: jest.fn(), warn: jest.fn() };
}

function respondServerReady(
  connection: TestRuntimeConnection,
  message: Extract<ChannelMessage, { kind: 'open' }>,
): void {
  queueMicrotask(() => {
    connection.emitMessage({
      id: message.id,
      kind: 'server-ready',
      traceId: message.traceId ?? '',
    });
  });
}

describe('WSChannelHandler preflight', () => {
  it('ignores duplicate readiness acknowledgements while still reopening after a real transport close', async () => {
    expect.hasAssertions();
    const connection = new TestRuntimeConnection();
    connection.onSend = (message) => {
      if (message.kind === 'open') {
        respondServerReady(connection, message);
      }
    };
    const handler = createHandler(connection, {
      channelPath: 'preflight',
      run: async (_channel, open) => open(),
    });

    try {
      await handler.initHandler();
      const channel = await handler.openChannel('RPCService');
      const reopened = jest.fn();
      channel.onReopen(reopened);
      const originalOpen = connection.sentMessages.find(
        (message): message is Extract<ChannelMessage, { kind: 'open' }> =>
          message.kind === 'open' && message.path === 'RPCService',
      )!;
      connection.emitMessage({ kind: 'server-ready', id: channel.id, traceId: originalOpen.traceId });
      expect(reopened).not.toHaveBeenCalled();

      connection.emitClose();
      connection.emitOpen();
      await waitFor(() => reopened.mock.calls.length === 1);
      expect(handler.getChannel('RPCService')).toBe(channel);
    } finally {
      handler.dispose();
    }
  });

  it('runs before the first normal open and can capture data sent before server-ready', async () => {
    expect.hasAssertions();
    const connection = new TestRuntimeConnection();
    const events: string[] = [];
    connection.onSend = (message) => {
      if (message.kind !== 'open') {
        return;
      }
      events.push(`open:${message.path}`);
      if (message.path === 'preflight') {
        // The server may synchronously send protocol data from its path
        // handler before BaseCommonChannelHandler emits server-ready.
        connection.emitMessage({ id: message.id, kind: 'data', content: 'profile-before-ready' });
        connection.emitMessage({
          id: message.id,
          kind: 'server-ready',
          traceId: message.traceId ?? '',
        });
        return;
      }
      respondServerReady(connection, message);
    };
    const handler = createHandler(connection, {
      channelPath: 'preflight',
      run: async (channel, open) => {
        events.push('preflight:run');
        channel.onMessage((message) => events.push(`preflight:data:${message}`));
        await open();
        events.push('preflight:ready');
      },
    });

    try {
      await handler.initHandler();
      await handler.openChannel('RPCService');

      expect(events).toEqual([
        'preflight:run',
        'open:preflight',
        'preflight:data:profile-before-ready',
        'preflight:ready',
        'open:RPCService',
      ]);
    } finally {
      handler.dispose();
    }
  });

  it('shares one preflight run across concurrent initial opens', async () => {
    expect.hasAssertions();
    const connection = new TestRuntimeConnection();
    const releasePreflight = createDeferred();
    const openedPaths: string[] = [];
    const run = jest.fn(async (_channel, open: () => Promise<void>) => {
      await open();
      await releasePreflight.promise;
    });
    connection.onSend = (message) => {
      if (message.kind === 'open') {
        openedPaths.push(message.path);
        respondServerReady(connection, message);
      }
    };
    const handler = createHandler(connection, { channelPath: 'preflight', run });

    try {
      await handler.initHandler();
      const first = handler.openChannel('first');
      const second = handler.openChannel('second');
      await waitFor(() => run.mock.calls.length === 1);

      expect(openedPaths).toEqual(['preflight']);
      releasePreflight.resolve();
      await Promise.all([first, second]);

      expect(run).toHaveBeenCalledTimes(1);
      expect(openedPaths).toEqual(['preflight', 'first', 'second']);
    } finally {
      handler.dispose();
    }
  });

  it('rejects direct opens of the reserved preflight channel', async () => {
    expect.hasAssertions();
    const connection = new TestRuntimeConnection();
    const run = jest.fn(async () => undefined);
    const handler = createHandler(connection, { channelPath: 'preflight', run });

    try {
      await handler.initHandler();

      await expect(handler.openChannel('preflight')).rejects.toThrow(
        'Logical channel preflight is reserved for connection preflight',
      );
      expect(run).not.toHaveBeenCalled();
    } finally {
      handler.dispose();
    }
  });

  it('still shares preflight when concurrent opens arrive during an otherwise empty reconnect', async () => {
    expect.hasAssertions();
    const connection = new TestRuntimeConnection();
    const releasePreflight = createDeferred();
    const openedPaths: string[] = [];
    const run = jest.fn(async (_channel, open: () => Promise<void>) => {
      await open();
      await releasePreflight.promise;
    });
    connection.onSend = (message) => {
      if (message.kind === 'open') {
        openedPaths.push(message.path);
        respondServerReady(connection, message);
      }
    };
    const handler = createHandler(connection, { channelPath: 'preflight', run });

    try {
      await handler.initHandler();
      connection.emitClose();
      connection.emitOpen();
      const first = handler.openChannel('first-after-reconnect');
      const second = handler.openChannel('second-after-reconnect');
      await waitFor(() => run.mock.calls.length === 1);

      expect(openedPaths).toEqual(['preflight']);
      releasePreflight.resolve();
      await Promise.all([first, second]);

      expect(run).toHaveBeenCalledTimes(1);
      expect(openedPaths).toEqual(['preflight', 'first-after-reconnect', 'second-after-reconnect']);
    } finally {
      handler.dispose();
    }
  });

  it('awaits preflight and then reopens existing channels sequentially in insertion order', async () => {
    expect.hasAssertions();
    const connection = new TestRuntimeConnection();
    const reconnectOpens: Array<Extract<ChannelMessage, { kind: 'open' }>> = [];
    let reconnecting = false;
    connection.onSend = (message) => {
      if (message.kind !== 'open') {
        return;
      }
      if (!reconnecting) {
        respondServerReady(connection, message);
        return;
      }
      reconnectOpens.push(message);
      if (message.path === 'preflight') {
        respondServerReady(connection, message);
      }
    };
    const handler = createHandler(connection, {
      channelPath: 'preflight',
      run: async (_channel, open) => open(),
    });

    try {
      await handler.initHandler();
      await handler.openChannel('first');
      const secondChannel = await handler.openChannel('second');
      const secondReopened = createDeferred();
      secondChannel.onReopen(() => secondReopened.resolve());

      reconnecting = true;
      connection.emitClose();
      connection.emitOpen();
      await waitFor(() => reconnectOpens.some((message) => message.path === 'first'));

      expect(reconnectOpens.map((message) => message.path)).toEqual(['preflight', 'first']);
      const firstOpen = reconnectOpens.find((message) => message.path === 'first')!;
      connection.emitMessage({ id: firstOpen.id, kind: 'server-ready', traceId: firstOpen.traceId ?? '' });
      await waitFor(() => reconnectOpens.some((message) => message.path === 'second'));
      expect(reconnectOpens.map((message) => message.path)).toEqual(['preflight', 'first', 'second']);

      const secondOpen = reconnectOpens.find((message) => message.path === 'second')!;
      connection.emitMessage({ id: secondOpen.id, kind: 'server-ready', traceId: secondOpen.traceId ?? '' });
      await secondReopened.promise;
    } finally {
      handler.dispose();
    }
  });

  it('does not reopen normal channels when the reconnect preflight fails', async () => {
    expect.hasAssertions();
    const connection = new TestRuntimeConnection();
    const logger = createLogger();
    const reconnectPaths: string[] = [];
    let runCount = 0;
    let reconnecting = false;
    connection.onSend = (message) => {
      if (message.kind === 'open') {
        if (reconnecting) {
          reconnectPaths.push(message.path);
        }
        respondServerReady(connection, message);
      }
    };
    const preflightError = new Error('preflight handshake failed');
    const handler = createHandler(
      connection,
      {
        channelPath: 'preflight',
        run: async (_channel, open) => {
          runCount++;
          await open();
          if (runCount === 2) {
            throw preflightError;
          }
        },
      },
      logger,
    );

    try {
      await handler.initHandler();
      await handler.openChannel('RPCService');

      reconnecting = true;
      connection.emitClose();
      connection.emitOpen();
      await waitFor(() => logger.error.mock.calls.length > 0);

      expect(reconnectPaths).toEqual(['preflight']);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('WSChannelHandler'),
        'failed to restore logical channels',
        preflightError,
      );
    } finally {
      handler.dispose();
    }
  });

  it('never lets a stale preflight epoch release normal channel reopen', async () => {
    expect.hasAssertions();
    const connection = new TestRuntimeConnection();
    const epochTwo = createDeferred();
    const epochThree = createDeferred();
    const reconnectPaths: string[] = [];
    const epochSignals: AbortSignal[] = [];
    let runCount = 0;
    let reconnecting = false;
    connection.onSend = (message) => {
      if (message.kind === 'open') {
        if (reconnecting) {
          reconnectPaths.push(message.path);
        }
        respondServerReady(connection, message);
      }
    };
    const handler = createHandler(connection, {
      channelPath: 'preflight',
      run: async (_channel, open, signal) => {
        if (!signal) {
          throw new Error('Physical connection preflight is missing its epoch AbortSignal');
        }
        epochSignals.push(signal);
        runCount++;
        await open();
        if (runCount === 2) {
          await epochTwo.promise;
        } else if (runCount === 3) {
          await epochThree.promise;
        }
      },
    });

    try {
      await handler.initHandler();
      await handler.openChannel('RPCService');
      expect(epochSignals).toHaveLength(1);
      expect(epochSignals[0].aborted).toBe(false);

      reconnecting = true;
      connection.emitClose();
      expect(epochSignals[0]).toMatchObject({
        aborted: true,
        reason: expect.objectContaining({ name: 'PhysicalConnectionEpochStaleError', epochId: 1 }),
      });
      connection.emitOpen();
      await waitFor(() => runCount === 2);
      expect(epochSignals).toHaveLength(2);
      expect(epochSignals[1]).not.toBe(epochSignals[0]);
      expect(epochSignals[1].aborted).toBe(false);

      connection.emitClose();
      expect(epochSignals[1]).toMatchObject({
        aborted: true,
        reason: expect.objectContaining({ name: 'PhysicalConnectionEpochStaleError', epochId: 2 }),
      });
      connection.emitOpen();
      await waitFor(() => runCount === 3);
      expect(epochSignals).toHaveLength(3);
      expect(new Set(epochSignals).size).toBe(3);
      expect(epochSignals[2].aborted).toBe(false);
      expect(reconnectPaths).toEqual(['preflight', 'preflight']);

      epochTwo.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(reconnectPaths).toEqual(['preflight', 'preflight']);

      epochThree.resolve();
      await waitFor(() => reconnectPaths.includes('RPCService'));
      expect(reconnectPaths).toEqual(['preflight', 'preflight', 'RPCService']);
    } finally {
      handler.dispose();
    }
  });
});
