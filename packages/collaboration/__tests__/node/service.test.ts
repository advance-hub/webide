/* eslint-disable @typescript-eslint/ban-ts-comment */
// @ts-ignore
import { once } from 'node:events';
import http from 'node:http';

import WebSocket from 'ws';
import * as Y from 'yjs';

import { AppConfig, INodeLogger } from '@opensumi/ide-core-node';
import { MockInjector, createNodeInjector } from '@opensumi/ide-dev-tool/injector';
import { IFileService } from '@opensumi/ide-file-service';
import { FileService } from '@opensumi/ide-file-service/node';

import { ICollaborationServiceForClient, IYWebsocketServer, ROOM_NAME } from '../../src';
import { CollaborationServiceForClient } from '../../src/node/collaboration.service';
import { YWebsocketServerImpl } from '../../src/node/y-websocket-server';

describe('Collaboration node ws server test', () => {
  let injector: MockInjector;
  let server: YWebsocketServerImpl;
  let service: CollaborationServiceForClient;
  let yDoc: Y.Doc;
  let fileService: FileService;
  let resolveContentSpy: jest.SpyInstance;

  const MOCK_CONTENT = 'init mock content';

  beforeAll(() => {
    injector = createNodeInjector([]);
    injector.mockService(INodeLogger);
    injector.mockService(IFileService);
    injector.addProviders(
      {
        token: IYWebsocketServer,
        useClass: YWebsocketServerImpl,
      },
      {
        token: ICollaborationServiceForClient,
        useClass: CollaborationServiceForClient,
      },
    );

    fileService = injector.get(IFileService);
    resolveContentSpy = jest
      .spyOn(fileService, 'resolveContent')
      .mockImplementation(async () => ({ content: MOCK_CONTENT }) as any);

    server = injector.get(IYWebsocketServer);
    service = injector.get(ICollaborationServiceForClient);
  });

  it('should correctly initialize', () => {
    expect.hasAssertions();
    const spy = jest.spyOn(server, 'initialize');
    server.initialize();
    expect(spy).toHaveBeenCalled();
  });

  it('should get Y.Doc', () => {
    expect.hasAssertions();
    yDoc = server.getYDoc(ROOM_NAME);
    expect(yDoc).toBeInstanceOf(Y.Doc);
  });

  const TEST_URI = 'file://foo';

  it('should set init content correctly', async () => {
    expect.hasAssertions();
    await service.requestInitContent(TEST_URI);
    const yMap: Y.Map<Y.Text> = yDoc.getMap();
    expect(yMap.has(TEST_URI)).toBeTruthy();
    expect(yMap.get(TEST_URI)).toBeInstanceOf(Y.Text);
    expect(yMap.get(TEST_URI)!.toString()).toBe(MOCK_CONTENT);
    expect((server as any).pendingContentRequests.size).toBe(0);
  });

  it('should release content only after the last reference closes', async () => {
    expect.hasAssertions();
    await service.requestInitContent(TEST_URI);
    expect((server as any).contentReferences.get(TEST_URI)).toBe(2);

    await service.releaseContent(TEST_URI);
    expect(yDoc.getMap().has(TEST_URI)).toBeTruthy();
    expect((server as any).contentReferences.get(TEST_URI)).toBe(1);

    await service.releaseContent(TEST_URI);
    expect(yDoc.getMap().has(TEST_URI)).toBeFalsy();
    expect((server as any).contentReferences.has(TEST_URI)).toBeFalsy();
  });

  it('shares one disk read across concurrent requests while retaining each client reference', async () => {
    expect.hasAssertions();
    const uri = 'file://concurrent';
    let finishLoading!: (value: { content: string }) => void;
    const readsBefore = resolveContentSpy.mock.calls.length;
    resolveContentSpy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLoading = resolve;
        }) as any,
    );
    const first = service.requestInitContent(uri);
    const second = service.requestInitContent(uri);

    finishLoading({ content: 'shared content' });
    await Promise.all([first, second]);

    expect(resolveContentSpy.mock.calls.length - readsBefore).toBe(1);
    expect(yDoc.getMap().get(uri)!.toString()).toBe('shared content');
    await service.releaseContent(uri);
    expect(yDoc.getMap().has(uri)).toBe(true);
    await service.releaseContent(uri);
    expect(yDoc.getMap().has(uri)).toBe(false);
  });

  it('should remove Y.Text', async () => {
    expect.hasAssertions();
    await service.requestInitContent(TEST_URI);
    server.removeYText(TEST_URI);
    const yMap = yDoc.getMap();
    expect(yMap.has(TEST_URI)).toBeFalsy();
    expect((server as any).contentReferences.has(TEST_URI)).toBeFalsy();
  });

  it('should reject oversized documents without retaining pending state', async () => {
    expect.hasAssertions();
    const appConfig = (server as any).appConfig;
    appConfig.collaborationOptions = { maxDocumentBytes: 4 };
    resolveContentSpy.mockImplementationOnce(async () => ({ content: 'too large' }) as any);

    await expect(service.requestInitContent('file://oversized')).rejects.toThrow('exceeding the 4-byte limit');
    expect(yDoc.getMap().has('file://oversized')).toBeFalsy();
    expect((server as any).pendingContentRequests.size).toBe(0);

    appConfig.collaborationOptions = undefined;
  });

  it('should cancel an in-flight load without restoring a deleted file', async () => {
    expect.hasAssertions();
    const delayedUri = 'file://delayed';
    let finishLoading: ((value: { content: string }) => void) | undefined;
    resolveContentSpy.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishLoading = resolve;
        }) as any,
    );

    const initialization = service.requestInitContent(delayedUri);
    await Promise.resolve();
    server.removeYText(delayedUri);

    await expect(initialization).rejects.toThrow('File was removed while loading collaboration content');
    finishLoading!({ content: 'late content' });
    await new Promise((resolve) => setImmediate(resolve));

    expect(yDoc.getMap().has(delayedUri)).toBeFalsy();
    expect((server as any).pendingContentRequests.size).toBe(0);
  });

  it('should reclaim abandoned content after the last client is idle', async () => {
    expect.hasAssertions();
    const idleUri = 'file://idle';
    const appConfig = (server as any).appConfig;
    appConfig.collaborationOptions = { idleTimeout: 1 };
    await service.requestInitContent(idleUri);

    const abandonedDocument = server.getYDoc(ROOM_NAME);
    server['scheduleIdleCleanup']();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(yDoc.getMap().has(idleUri)).toBeFalsy();
    expect((server as any).contentReferences.has(idleUri)).toBeFalsy();
    expect(server.getYDoc(ROOM_NAME)).not.toBe(abandonedDocument);
    yDoc = server.getYDoc(ROOM_NAME);
    appConfig.collaborationOptions = undefined;
  });

  it('resets CRDT history after the shared state reaches its memory limit', async () => {
    expect.hasAssertions();
    const appConfig = (server as any).appConfig;
    appConfig.collaborationOptions = { maxStateBytes: 1 };
    const pressuredDocument = server.getYDoc(ROOM_NAME);
    pressuredDocument.getMap().set('large-update', new Y.Text('content that exceeds the state limit'));

    server['checkDocumentPressure']();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(server.getYDoc(ROOM_NAME)).not.toBe(pressuredDocument);
    expect((server as any).accumulatedUpdateBytes).toBe(0);
    yDoc = server.getYDoc(ROOM_NAME);
    appConfig.collaborationOptions = undefined;
  });

  it('should correctly dispose', () => {
    expect.hasAssertions();
    const spy = jest.spyOn(server, 'destroy');
    server.destroy();
    expect(spy).toHaveBeenCalled();
  });

  afterAll(() => {
    // @ts-ignore
    yDoc.destroy();
  });
});

describe('托管工作区协同入口与连接租约', () => {
  let injector: MockInjector;
  let server: YWebsocketServerImpl;
  beforeEach(() => {
    injector = createNodeInjector([]);
    injector.mockService(INodeLogger);
    injector.mockService(IFileService);
    injector.overrideProviders({
      token: AppConfig,
      useValue: {
        collaborationOptions: {
          transport: 'shared',
          maxConnections: 5,
          authorizeConnection: (req: http.IncomingMessage) => req.headers.authorization === 'Bearer fixture',
        },
      },
    });
    injector.addProviders({ token: IYWebsocketServer, useClass: YWebsocketServerImpl });
    jest
      .spyOn(injector.get<FileService>(IFileService), 'resolveContent')
      .mockResolvedValue({ content: 'shared fixture' } as any);
    server = injector.get(IYWebsocketServer);
    server.initialize();
  });
  afterEach(() => server.destroy());

  it('仅在 IDE 原有入口接纳五个认证连接，并拒绝未认证、超额与排空期间的连接', async () => {
    expect.hasAssertions();
    const host = http.createServer();
    host.on('upgrade', (req, socket, head) => {
      if (!server.handleUpgrade(new URL(req.url!, 'http://localhost').pathname, req, socket, head)) {
        socket.destroy();
      }
    });
    host.listen(0, '127.0.0.1');
    await once(host, 'listening');
    const url = `ws://127.0.0.1:${(host.address() as { port: number }).port}/collaboration/${ROOM_NAME}`;
    const sockets: WebSocket[] = [];
    const connect = async (authorization = 'Bearer fixture') => {
      const socket = new WebSocket(url, { headers: { Authorization: authorization } });
      sockets.push(socket);
      await once(socket, 'open');
      return socket;
    };
    try {
      expect((server as any).server.listening).toBe(false);
      await expect(connect('Bearer wrong')).rejects.toThrow('401');
      for (let index = 0; index < 5; index++) {
        await connect();
      }
      await expect(connect()).rejects.toThrow('503');
      const closed = once(sockets[1], 'close');
      sockets[1].terminate();
      await closed;
      server.beginDrain();
      await expect(connect()).rejects.toThrow('503');
    } finally {
      sockets.forEach((socket) => socket.terminate());
      server.destroy();
      await new Promise<void>((resolve) => host.close(() => resolve()));
      expect((server as any).idleCleanupTimer).toBeUndefined();
    }
  });

  it('销毁客户端只释放自身文档引用，其他客户端继续持有内容', async () => {
    expect.hasAssertions();
    const create = () => {
      const client = new CollaborationServiceForClient();
      Object.defineProperty(client, 'server', { value: server });
      return client;
    };
    const first = create();
    const second = create();
    await first.requestInitContent('file:///shared.ts');
    await second.requestInitContent('file:///shared.ts');
    first.dispose();
    first.dispose();
    expect((server as any).contentReferences.get('file:///shared.ts')).toBe(1);
    expect(server.getYDoc(ROOM_NAME).getMap().has('file:///shared.ts')).toBe(true);
    await second.releaseContent('file:///shared.ts');
    expect(server.getYDoc(ROOM_NAME).getMap().has('file:///shared.ts')).toBe(false);
  });

  it('连接关闭后迟到的磁盘加载立即退租，不遗留初始化引用', async () => {
    expect.hasAssertions();
    let finish!: (value: any) => void;
    (injector.get<FileService>(IFileService).resolveContent as jest.Mock).mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const client = new CollaborationServiceForClient();
    Object.defineProperty(client, 'server', { value: server });
    const loading = client.requestInitContent('file:///late.ts');
    client.dispose();
    finish({ content: 'late' });
    await expect(loading).rejects.toThrow('closed while loading');
    expect((server as any).contentReferences.size).toBe(0);
    expect((server as any).pendingContentRequests.size).toBe(0);
  });
});
