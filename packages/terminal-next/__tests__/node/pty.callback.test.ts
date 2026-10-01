import net from 'node:net';

import { RPCServiceCenter, initRPCService } from '@opensumi/ide-connection';
import { SumiConnection } from '@opensumi/ide-connection/rpc';
import { Deferred } from '@opensumi/ide-core-common';
import { normalizedIpcHandlerPath } from '@opensumi/ide-core-common/node/ipc';

import { PTY_SERVICE_PROXY_CALLBACK_PROTOCOL } from '../../src/common/pty';
import { PtyServiceProxyRPCProvider } from '../../src/node/pty.proxy';

test('closing a PTY callback transport before its acknowledgement does not leak a rejection', async () => {
  expect.hasAssertions();
  const socketPath = normalizedIpcHandlerPath('PTY-CALLBACK-CLOSE', true);
  const provider = new PtyServiceProxyRPCProvider({ path: socketPath });
  const received = new Deferred<number>();
  const acknowledge = new Deferred<void>();
  const center = new RPCServiceCenter();
  initRPCService(center).createRPCService(PTY_SERVICE_PROXY_CALLBACK_PROTOCOL, {
    async $callback(callId: number) {
      received.resolve(callId);
      await acknowledge.promise;
    },
  });
  provider.initServer();
  const socket = net.connect(socketPath);
  const remove = center.setSumiConnection(SumiConnection.forNetSocket(socket));
  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('connect', resolve);
      socket.once('error', reject);
    });
    const ptyProcess = await provider.$ptyServiceProxy.$spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      env: { ...process.env },
    });
    provider.$ptyServiceProxy.$onExit(42, ptyProcess.pid);
    provider.$ptyServiceProxy.$kill(ptyProcess.pid);
    expect(await received.promise).toBe(42);
    await new Promise<void>((resolve) => {
      socket.once('close', resolve);
      socket.destroy();
    });
    await provider.dispose();
    // Let both socket-close handlers and rejected RPC acknowledgements settle.
    await new Promise<void>((resolve) => setImmediate(resolve));
  } finally {
    acknowledge.resolve();
    remove.dispose();
    socket.destroy();
    await provider.dispose();
  }
}, 10_000);
