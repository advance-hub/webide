import { IOpenerService, StaticResourceService } from '@opensumi/ide-core-browser';
import {
  CancellationTokenSource,
  CommandRegistry,
  Disposable,
  Emitter,
  IEventBus,
  makeRandomHexString,
} from '@opensumi/ide-core-common';
import { createBrowserInjector } from '@opensumi/ide-dev-tool/browser';
import { mockService } from '@opensumi/ide-dev-tool/injector';
import { createMockPairRPCProtocol } from '@opensumi/ide-dev-tool/mocks/extension-rpc';
import { WorkbenchEditorService } from '@opensumi/ide-editor';
import { IMainLayoutService } from '@opensumi/ide-main-layout';
import { IIconService } from '@opensumi/ide-theme';
import { IWebview, IWebviewService } from '@opensumi/ide-webview';

import { ExtHostAPIIdentifier, IExtHostWebview, MainThreadAPIIdentifier } from '../../lib/common/vscode';
import { WebviewViewShouldShowEvent } from '../../src/browser/components/extension-webview-view';
import { MainThreadWebview, MainThreadWebviewView } from '../../src/browser/vscode/api/main.thread.api.webview';
import { ExtensionIdentifier, IExtensionDescription } from '../../src/common/vscode';
import { WebviewView, WebviewViewProvider } from '../../src/common/vscode/webview';
import { ExtHostWebviewService, ExtHostWebviewViews } from '../../src/hosted/api/vscode/ext.host.api.webview';

async function delay(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      resolve(undefined);
    }, ms);
  });
}

describe('Webview view tests', () => {
  jest.setTimeout(10 * 1000);

  let extHostWebview: IExtHostWebview;
  let extHostWebviewView: ExtHostWebviewViews;
  let mainThreadWebview: MainThreadWebview;
  const injector = createBrowserInjector([]);

  const webviews = new Map<string, IWebview>();
  const viewVisible = new Map<string, boolean>();

  injector.addProviders(
    {
      token: IWebviewService,
      useValue: mockService<IWebviewService>({
        createWebview: () => {
          const id = makeRandomHexString(5);
          const webview: IWebview = {
            id,
            appendTo: jest.fn(),
            onMessage: new Emitter().event,
            postMessage: jest.fn(),
            dispose: jest.fn(),
            setContent: jest.fn(),
            onDispose: new Emitter().event,
          } as Partial<IWebview> as any;
          webviews.set(id, webview);
          return webview;
        },
        getWebview: (id) => webviews.get(id),
      }),
    },
    {
      token: WorkbenchEditorService,
      useValue: mockService({
        onActiveResourceChange: new Emitter().event,
      }),
    },
    {
      token: IIconService,
      useValue: mockService({}),
    },
    {
      token: StaticResourceService,
      useValue: mockService({}),
    },
    {
      token: IOpenerService,
      useValue: mockService({}),
    },
    {
      token: CommandRegistry,
      useValue: mockService({}),
    },
    {
      token: IMainLayoutService,
      useValue: mockService<IMainLayoutService>({
        isViewVisible: (viewId) => !!viewVisible.get(viewId),
        getTabbarHandler: () =>
          ({
            onActivate: new Emitter().event,
            onInActivate: new Emitter().event,
          }) as any,
      }),
    },
  );

  const { rpcProtocolExt, rpcProtocolMain } = createMockPairRPCProtocol();

  beforeAll((done) => {
    extHostWebview = new ExtHostWebviewService(rpcProtocolExt);
    extHostWebviewView = new ExtHostWebviewViews(rpcProtocolExt, extHostWebview as ExtHostWebviewService);

    rpcProtocolExt.set(ExtHostAPIIdentifier.ExtHostWebview, extHostWebview);
    rpcProtocolExt.set(ExtHostAPIIdentifier.ExtHostWebviewView, extHostWebviewView);
    mainThreadWebview = rpcProtocolMain.set(
      MainThreadAPIIdentifier.MainThreadWebview,
      injector.get(MainThreadWebview, [rpcProtocolMain]),
    );
    rpcProtocolMain.set(
      MainThreadAPIIdentifier.MainThreadWebviewView,
      injector.get(MainThreadWebviewView, [rpcProtocolMain, mainThreadWebview]),
    );

    done();
  });

  it('display a webview view', async () => {
    const viewType = 'webviewViewTestViewType';

    const testProvider: WebviewViewProvider = {
      resolveWebviewView: jest.fn(async (webviewView: WebviewView) => {
        webviewView.webview.html = 'testHtmlContent';
      }),
    };

    const ext: IExtensionDescription = {
      identifier: new ExtensionIdentifier('testPublisher.testExtension'),
    } as any;

    extHostWebviewView.registerWebviewViewProvider(ext, viewType, testProvider);

    const eventBus: IEventBus = injector.get(IEventBus);

    const container = document.createElement('div');

    viewVisible.set(viewType, true);

    eventBus.fire(
      new WebviewViewShouldShowEvent({
        title: 'testTitle',
        viewType,
        container,
        cancellationToken: new CancellationTokenSource().token,
        disposer: new Disposable(),
      }),
    );

    await delay(100);
    expect(webviews.size).toBe(1);

    const webview = webviews.get(Array.from(webviews.keys())[0])!;
    expect(webview.appendTo).toHaveBeenCalledWith(container);
    expect(webview.setContent).toHaveBeenCalledWith('testHtmlContent');
  });

  afterAll(async () => {
    await injector.disposeAll();
    await Promise.all(Array.from(webviews.entries()).map(([i, w]) => w.dispose()));
  });
});
