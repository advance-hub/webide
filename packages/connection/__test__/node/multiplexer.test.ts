import { MessageChannel } from 'worker_threads';

import { createMainContextProxyIdentifier } from '@opensumi/ide-connection/rpc-contracts';
import { Emitter, Uri } from '@opensumi/ide-core-common';
import { createMockPairRPCProtocol } from '@opensumi/ide-dev-tool/mocks/extension-rpc';

import { ProxyIdentifier } from '../../src';
import { NodeMessagePortConnection } from '../../src/common/connection/drivers/node-message-port';
import { SimpleConnection } from '../../src/common/connection/drivers/simple';
import { SumiConnectionMultiplexer } from '../../src/common/rpc/multiplexer';

describe('connection', () => {
  it('calls a service registered through the shared contract from the legacy package entry', async () => {
    expect.hasAssertions();
    const { port1, port2 } = new MessageChannel();
    const server = new SumiConnectionMultiplexer(new NodeMessagePortConnection(port1));
    const client = new SumiConnectionMultiplexer(new NodeMessagePortConnection(port2));
    try {
      const id = createMainContextProxyIdentifier<{ $read(path: string): string }>('@test/files');
      server.set(id, { $read: (path: string) => `content:${path}` });
      const proxy = client.getProxy(ProxyIdentifier.for('@test/files'));
      await expect(proxy.$read('/README.md')).resolves.toBe('content:/README.md');
    } finally {
      server.dispose();
      client.dispose();
      port1.close();
      port2.close();
    }
  });

  it('RPCProtocol', async () => {
    const { rpcProtocolExt: aProtocol, rpcProtocolMain: bProtocol } = createMockPairRPCProtocol();

    const testMainIdentifier = ProxyIdentifier.for('testIendifier');
    const mockMainIndetifierMethod = jest.fn();
    const mockUriTestFn = jest.fn((uri) => uri);
    const mockErrorFn = jest.fn(() => {
      throw new Error('custom error');
    });

    aProtocol.set(testMainIdentifier, {
      $test: mockMainIndetifierMethod,
      $getUri: mockUriTestFn,
      $errorFunction: mockErrorFn,
    });

    function errorFunction() {
      return bProtocol.getProxy(testMainIdentifier).$errorFunction();
    }

    const testUri = Uri.file('/workspace/README.md');
    await bProtocol.getProxy(testMainIdentifier).$test();
    await bProtocol.getProxy(testMainIdentifier).$getUri(testUri);
    expect(mockMainIndetifierMethod.mock.calls.length).toBe(1);
    expect(mockUriTestFn.mock.results[0].value).toBeInstanceOf(Uri);
    expect(mockUriTestFn.mock.results[0].value.toString()).toBe(testUri.toString());
    await expect(errorFunction()).rejects.toThrow(new Error('custom error'));
  });

  it('RPCProtocol Timeout', async () => {
    const emitterTimeoutA = new Emitter<any>();
    const emitterTimeoutB = new Emitter<any>();
    const emitterTimeoutC = new Emitter<any>();

    const mockClientTA = {
      onMessage: emitterTimeoutA.event,
      send: (msg) => emitterTimeoutB.fire(msg),
    };
    const mockClientTB = {
      onMessage: emitterTimeoutB.event,
      send: (msg) => emitterTimeoutA.fire(msg),
    };
    const mockClientTC = {
      onMessage: emitterTimeoutC.event,
      send: (msg) => emitterTimeoutA.fire(msg),
    };

    const timeoutAProtocol = new SumiConnectionMultiplexer(new SimpleConnection(mockClientTA));
    const timeoutBProtocol = new SumiConnectionMultiplexer(new SimpleConnection(mockClientTB));
    const timeoutCProtocol = new SumiConnectionMultiplexer(new SimpleConnection(mockClientTC), {
      timeout: 1000,
    });

    const testTimeoutIdentifier = ProxyIdentifier.for('@opensumi/runner');
    timeoutAProtocol.set(testTimeoutIdentifier, {
      $test: jest.fn(),
    });

    await expect(timeoutBProtocol.getProxy(testTimeoutIdentifier).$test()).resolves.toBe(undefined);

    await expect(timeoutCProtocol.getProxy(testTimeoutIdentifier).$test()).rejects.toThrowErrorMatchingInlineSnapshot(
      '"method @opensumi_runner/$test timeout"',
    );
  });
  it('multiplexer rpc id can have slash', async () => {
    const { rpcProtocolExt, rpcProtocolMain } = createMockPairRPCProtocol();

    const rpcId = '@opensumi/runner';
    const method = '$fetchConfigurations';

    rpcProtocolMain.set(ProxyIdentifier.for(rpcId), {
      [method]: () => 'mock',
    });

    const runner = rpcProtocolExt.getProxy(ProxyIdentifier.for(rpcId));

    const result = await runner.$fetchConfigurations();
    expect(result).toBe('mock');
  });
});
