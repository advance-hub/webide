import net from 'net';

import { ExtensionHostProcessEpochLoss } from '../../src/common';
import { ExtensionHostProxyManager } from '../../src/node/extension.host.proxy.manager';

async function findLoopbackPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a TCP loopback address');
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

async function connectEventually(port: number): Promise<net.Socket> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < 20; attempt++) {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    try {
      await new Promise<void>((resolve, reject) => {
        const onConnect = () => {
          socket.off('error', onError);
          resolve();
        };
        const onError = (error: Error) => {
          socket.off('connect', onConnect);
          reject(error);
        };
        socket.once('connect', onConnect);
        socket.once('error', onError);
      });
      return socket;
    } catch (error) {
      lastError = error as Error;
      socket.destroy();
      await new Promise<void>((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError || new Error('Extension Host proxy did not accept a loopback connection');
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (condition()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Timed out waiting for the Extension Host proxy epoch transition');
}

describe('ExtensionHostProxyManager process epochs', () => {
  it('reports each current proxy epoch loss exactly once without session identifiers', async () => {
    expect.hasAssertions();
    const port = await findLoopbackPort();
    const manager = new ExtensionHostProxyManager({ host: '127.0.0.1', port });
    Object.defineProperties(manager, {
      appConfig: { value: { rpcMessageTimeout: 100 } },
      logger: {
        value: {
          error: jest.fn(),
          log: jest.fn(),
          warn: jest.fn(),
        },
      },
    });
    const losses: ExtensionHostProcessEpochLoss[] = [];
    const lossListener = manager.onDidLoseProcessEpoch?.((loss) => losses.push(loss));
    let first: net.Socket | undefined;
    let second: net.Socket | undefined;

    try {
      const initialized = manager.init();
      first = await connectEventually(port);
      await initialized;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(losses).toEqual([]);

      const firstEpochCallback = jest.fn();
      const firstEpochCallId = (manager as any).addNewCallback(101, firstEpochCallback);
      expect((manager as any).callbackMap.get(firstEpochCallId)).toBe(firstEpochCallback);

      second = await connectEventually(port);
      await waitFor(() => losses.length === 1);
      expect(losses).toEqual([{ epoch: 1, reason: 'connection-replaced' }]);
      expect((manager as any).callbackMap.has(firstEpochCallId)).toBe(false);
      expect((manager as any).processDisposeMap.size).toBe(0);

      const secondEpochCallback = jest.fn();
      const secondEpochCallId = (manager as any).addNewCallback(101, secondEpochCallback);
      expect((manager as any).callbackMap.get(secondEpochCallId)).toBe(secondEpochCallback);

      // The first connection is already retired by replacement. A duplicated,
      // late close from it must not terminate, relabel, or reclaim callbacks
      // owned by the new epoch even when the remote PID is reused.
      first.emit('close', false);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(losses).toEqual([{ epoch: 1, reason: 'connection-replaced' }]);
      expect((manager as any).callbackMap.get(secondEpochCallId)).toBe(secondEpochCallback);

      second.destroy();
      await waitFor(() => losses.length === 2);
      expect(losses).toEqual([
        { epoch: 1, reason: 'connection-replaced' },
        { epoch: 2, reason: 'connection-closed' },
      ]);
      expect((manager as any).callbackMap.size).toBe(0);
      expect((manager as any).processDisposeMap.size).toBe(0);

      second.emit('close', false);
      first.destroy();
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(losses).toHaveLength(2);
      for (const loss of losses) {
        expect(Object.keys(loss).sort()).toEqual(['epoch', 'reason']);
        expect(loss).not.toHaveProperty('pid');
        expect(loss).not.toHaveProperty('clientId');
      }
    } finally {
      lossListener?.dispose();
      first?.destroy();
      second?.destroy();
      Object.defineProperty(manager, 'extHostProxy', {
        configurable: true,
        value: { $dispose: jest.fn().mockResolvedValue(undefined) },
      });
      await manager.dispose();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  });
});
