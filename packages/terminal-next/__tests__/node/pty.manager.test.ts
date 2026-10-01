import os from 'os';

import { Injector } from '@opensumi/di';
import { INodeLogger, getDebugLogger } from '@opensumi/ide-core-node';
import { createNodeInjector } from '@opensumi/ide-dev-tool/injector';

import { IPtyProcessProxy, IPtyProxyRPCService } from '../../src/common/pty';
import { TerminalNodePtyModule } from '../../src/node';
import { IPtyServiceManager, PtyServiceManager, PtyServiceManagerToken } from '../../src/node/pty.manager';
import { PtyServiceProxyRPCProvider } from '../../src/node/pty.proxy';

let shellPath = '';

if (os.platform() === 'win32') {
  shellPath = 'powershell';
} else if (os.platform() === 'linux' || os.platform() === 'darwin') {
  shellPath = 'bash';
}

const delay = (t: number) => new Promise((resolve) => setTimeout(resolve, t));

async function killAndWait(ptyProcess: IPtyProcessProxy) {
  await new Promise<void>((resolve) => {
    const listener = ptyProcess.onExit(() => {
      listener.dispose();
      resolve();
    });
    ptyProcess.kill();
  });
}

describe('Pty Manager Test Local', () => {
  let injector: Injector;
  let ptyServiceManager: IPtyServiceManager;

  beforeEach(() => {
    injector = createNodeInjector([TerminalNodePtyModule]);
  });

  it('pty manager create and kill', async () => {
    ptyServiceManager = injector.get(PtyServiceManager);
    const ptyService = await ptyServiceManager.spawn(shellPath, [], {}, 'fake-session-1');
    expect(ptyService.onData).toBeDefined();
    expect(ptyService).toBeDefined();
    expect(ptyService?.pid).toBeDefined();
    const process = await ptyService.getProcessDynamically();
    expect(process).toEqual(shellPath);
    ptyService.write('pwd\n');

    await killAndWait(ptyService);

    const sessionAlive = await ptyServiceManager.checkSession('fake-session-1');
    expect(sessionAlive).toBeFalsy();
  });

  it('expires an unowned persistent session after its lease', async () => {
    expect.assertions(1);
    ptyServiceManager = injector.get(PtyServiceManager);
    await ptyServiceManager.spawn(shellPath, [], {}, 'client|expiring-session');

    ptyServiceManager.scheduleSessionCleanup('client|expiring-session', 30);
    await delay(100);

    await expect(ptyServiceManager.checkSession('expiring-session')).resolves.toBe(false);
  });

  it('cancels pending cleanup when the persistent session resumes', async () => {
    expect.assertions(2);
    ptyServiceManager = injector.get(PtyServiceManager);
    const first = await ptyServiceManager.spawn(shellPath, [], {}, 'old-client|resumed-session');
    ptyServiceManager.scheduleSessionCleanup('old-client|resumed-session', 100);
    await delay(20);

    const resumed = await ptyServiceManager.spawn(shellPath, [], {}, 'new-client|resumed-session');
    expect(resumed.pid).toBe(first.pid);
    await delay(150);

    await expect(ptyServiceManager.checkSession('resumed-session')).resolves.toBe(true);
    await killAndWait(resumed);
  });

  it('tolerates a persistent pty exiting after its client callback is disposed', async () => {
    ptyServiceManager = injector.get(PtyServiceManager);
    const ptyService = await ptyServiceManager.spawn(shellPath, [], {}, 'client|disposed-callback-session');
    const exitListener = ptyService.onExit(() => undefined);
    exitListener.dispose();

    ptyService.kill();
    await delay(150);

    await expect(ptyServiceManager.checkSession('disposed-callback-session')).resolves.toBe(false);
  });
});

describe('Pty Manager Test Remote', () => {
  let injector: Injector;
  let ptyServiceManager: IPtyServiceManager;

  beforeEach(() => {
    injector = createNodeInjector([TerminalNodePtyModule]);
  });

  it('observes rejected command acknowledgements and releases failed callback registrations', async () => {
    expect.hasAssertions();
    const disconnected = new Error('RPC connection closed');
    class DisconnectedManager extends PtyServiceManager {
      protected override initLocal() {
        this.ptyServiceProxy = new Proxy({} as IPtyProxyRPCService, {
          get: () => () => Promise.reject(disconnected),
        });
        this.ptyServiceProxyDeferred.resolve();
      }

      get pendingCallbackCount() {
        return this.callbackMap.size;
      }
    }
    const warn = jest.fn();
    injector.overrideProviders({ token: INodeLogger, useValue: { ...getDebugLogger(), warn } });
    const manager = injector.get(DisconnectedManager);
    manager.onData(1, () => undefined);
    manager.onExit(1, () => undefined);
    manager.resize(1, 80, 24);
    manager.clear(1);
    manager.write(1, 'pwd\n');
    manager.kill(1);
    manager.scheduleSessionCleanup('session', 100);
    manager.pause(1);
    manager.resume(1);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(warn).toHaveBeenCalledTimes(9);
    expect(warn).toHaveBeenCalledWith('PtyServiceManager $write failed', disconnected);
    expect(manager.pendingCallbackCount).toBe(0);
    // Request/response operations still reject for their awaiting caller.
    await expect(manager.spawn(shellPath, [], {})).rejects.toBe(disconnected);
  });

  // 远程模式使用PtyService
  it('pty manager create and remote', async () => {
    // 双容器模式下，需要以本文件作为entry单独打包出一个可执行文件，运行在DEV容器中
    const proxyProvider = new PtyServiceProxyRPCProvider();
    proxyProvider.initServer();
    await delay(1000);

    injector.addProviders({
      token: PtyServiceManagerToken,
      useValue: new PtyServiceManager(),
    });

    ptyServiceManager = injector.get(PtyServiceManagerToken);
    const ptyService = await ptyServiceManager.spawn(shellPath, [], {}, 'fake-session-1');
    expect(ptyService.onData).toBeDefined();
    expect(ptyService).toBeDefined();
    expect(ptyService?.pid).toBeDefined();
    const process = await ptyService.getProcessDynamically();
    expect(typeof process).toBe('string');
    expect(process).toEqual(shellPath);
    ptyService.write('pwd\n');

    await killAndWait(ptyService);

    const sessionAlive = await ptyServiceManager.checkSession('fake-session-1');
    expect(sessionAlive).toBeFalsy();

    // close test server
    await proxyProvider.dispose();
  });
});
