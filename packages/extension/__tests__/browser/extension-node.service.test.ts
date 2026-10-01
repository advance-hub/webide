import { Deferred } from '@opensumi/ide-core-browser';

import { NodeExtProcessService } from '../../src/browser/extension-node.service';

interface FakeHost {
  $updateExtHostData: jest.Mock<Promise<void>, []>;
  $activateExtension: jest.Mock<Promise<void>, [string]>;
  $fireChangeEvent: jest.Mock<void, []>;
  $getActivatedExtensions: jest.Mock<Promise<never[]>, []>;
}

function createHost(): FakeHost {
  return {
    $updateExtHostData: jest.fn().mockResolvedValue(undefined),
    $activateExtension: jest.fn().mockResolvedValue(undefined),
    $fireChangeEvent: jest.fn(),
    $getActivatedExtensions: jest.fn().mockResolvedValue([]),
  };
}

function createProtocol(host: FakeHost) {
  return {
    getProxy: jest.fn(() => host),
    get: jest.fn(),
    set: jest.fn(),
    dispose: jest.fn(),
  };
}

function createChannel() {
  return {
    createConnection: jest.fn(() => ({})),
    dispose: jest.fn(),
  };
}

function createService() {
  const service = new NodeExtProcessService();
  const extensionNodeClient = {
    createProcess: jest.fn().mockResolvedValue(undefined),
    disposeClientExtProcess: jest.fn().mockResolvedValue(undefined),
  };
  const channelHandler = {
    openChannel: jest.fn(),
  };

  Object.defineProperties(service, {
    appConfig: {
      value: {
        noExtHost: false,
        rpcMessageTimeout: 30_000,
      },
    },
    applicationService: {
      value: {
        clientId: 'browser-client',
      },
    },
    extensionNodeClient: {
      value: extensionNodeClient,
    },
    channelHandler: {
      value: channelHandler,
    },
  });
  jest.spyOn(service as any, 'createBrowserMainThreadAPI').mockResolvedValue(undefined);

  return { channelHandler, extensionNodeClient, service };
}

describe('NodeExtProcessService generations', () => {
  it('coalesces concurrent activate calls into one generation', async () => {
    expect.hasAssertions();
    const { channelHandler, extensionNodeClient, service } = createService();
    const createProcessGate = new Deferred<void>();
    extensionNodeClient.createProcess.mockReturnValueOnce(createProcessGate.promise);
    const host = createHost();
    const protocol = createProtocol(host);
    const channel = createChannel();
    channelHandler.openChannel.mockResolvedValueOnce(channel);
    jest.spyOn(service as any, 'createProtocol').mockReturnValueOnce(protocol);

    const ready = service.ready.promise;
    const first = service.activate();
    const second = service.activate();

    expect(second).toBe(first);
    await Promise.resolve();
    expect(extensionNodeClient.createProcess).toHaveBeenCalledTimes(1);

    createProcessGate.resolve();
    await expect(Promise.all([first, second])).resolves.toEqual([protocol, protocol]);
    await expect(ready).resolves.toBeUndefined();
    expect(channelHandler.openChannel).toHaveBeenCalledTimes(1);
    expect(host.$updateExtHostData).toHaveBeenCalledTimes(1);
    expect(service.protocol).toBe(protocol);
  });

  it('moves the stable ready barrier and Browser resources to the restart generation', async () => {
    expect.hasAssertions();
    const { channelHandler, service } = createService();
    const firstHost = createHost();
    const firstProtocol = createProtocol(firstHost);
    const firstChannel = createChannel();
    const secondHost = createHost();
    const secondProtocol = createProtocol(secondHost);
    const secondChannel = createChannel();
    channelHandler.openChannel.mockResolvedValueOnce(firstChannel).mockResolvedValueOnce(secondChannel);
    jest
      .spyOn(service as any, 'createProtocol')
      .mockReturnValueOnce(firstProtocol)
      .mockReturnValueOnce(secondProtocol);

    const publicReady = service.ready;
    const firstReady = publicReady.promise;
    await service.activate();
    await expect(firstReady).resolves.toBeUndefined();

    const disposing = service.disposeProcess();
    const secondReady = publicReady.promise;
    expect(service.ready).toBe(publicReady);
    expect(secondReady).not.toBe(firstReady);
    expect(service.protocol).toBeUndefined();
    expect(firstChannel.dispose).toHaveBeenCalledTimes(1);
    expect(firstProtocol.dispose).toHaveBeenCalledTimes(1);
    await disposing;

    await expect(service.activate()).resolves.toBe(secondProtocol);
    await expect(secondReady).resolves.toBeUndefined();
    expect(service.protocol).toBe(secondProtocol);
    expect(secondChannel.dispose).not.toHaveBeenCalled();
    expect(secondProtocol.dispose).not.toHaveBeenCalled();
  });

  it('does not expose an old ready protocol when a newer generation fails', async () => {
    expect.hasAssertions();
    const { channelHandler, extensionNodeClient, service } = createService();
    const oldHost = createHost();
    const oldProtocol = createProtocol(oldHost);
    const oldChannel = createChannel();
    channelHandler.openChannel.mockResolvedValueOnce(oldChannel);
    jest.spyOn(service as any, 'createProtocol').mockReturnValueOnce(oldProtocol);
    await service.activate();

    const failure = new Error('new Extension Host failed to start');
    extensionNodeClient.createProcess.mockRejectedValueOnce(failure);
    const failedActivation = service.activate();
    const failedReady = service.ready.promise;

    expect(service.protocol).toBeUndefined();
    expect(oldChannel.dispose).toHaveBeenCalledTimes(1);
    expect(oldProtocol.dispose).toHaveBeenCalledTimes(1);
    await expect(failedActivation).rejects.toBe(failure);
    await expect(failedReady).rejects.toBe(failure);
    await expect(service.getProxy()).rejects.toBe(failure);
    expect(channelHandler.openChannel).toHaveBeenCalledTimes(1);
  });

  it('waits for the current generation data update before activating an extension', async () => {
    expect.hasAssertions();
    const { channelHandler, service } = createService();
    const firstHost = createHost();
    const firstProtocol = createProtocol(firstHost);
    const firstChannel = createChannel();
    const secondHost = createHost();
    const secondUpdateGate = new Deferred<void>();
    secondHost.$updateExtHostData.mockReturnValueOnce(secondUpdateGate.promise);
    const secondProtocol = createProtocol(secondHost);
    const secondChannel = createChannel();
    channelHandler.openChannel.mockResolvedValueOnce(firstChannel).mockResolvedValueOnce(secondChannel);
    jest
      .spyOn(service as any, 'createProtocol')
      .mockReturnValueOnce(firstProtocol)
      .mockReturnValueOnce(secondProtocol);

    await service.activate();
    await service.disposeProcess();
    const activation = service.activate();
    const activateExtension = service.activeExtension({ id: 'publisher.extension' } as any, false);
    await Promise.resolve();

    expect(firstHost.$activateExtension).not.toHaveBeenCalled();
    expect(secondHost.$activateExtension).not.toHaveBeenCalled();

    secondUpdateGate.resolve();
    await activation;
    await activateExtension;
    expect(secondHost.$activateExtension).toHaveBeenCalledTimes(1);
    expect(secondHost.$activateExtension).toHaveBeenCalledWith('publisher.extension');
  });
});
