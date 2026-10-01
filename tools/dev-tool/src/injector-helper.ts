import { Injectable, Injector } from '@opensumi/di';
import { BrowserModule, IContextKeyService } from '@opensumi/ide-core-browser';
import { ClientApp } from '@opensumi/ide-core-browser/bootstrap';
import { RecentFilesManager } from '@opensumi/ide-core-browser/quick-open';
import {
  CommonServerPath,
  ConstructorOf,
  ILogServiceManager,
  ILogger,
  ILoggerManagerClient,
  LogLevel,
  LogServiceForClientPath,
  OS,
  getDebugLogger,
} from '@opensumi/ide-core-common';

import { MockInjector } from './mock-injector';
import { MockLogger, MockLoggerManageClient, MockLoggerService } from './mocks/logger';
import { MockContextKeyService } from './mocks/monaco/monaco.context-key.service';
import { useMockStorage } from './mocks/storage';

@Injectable()
class MockMainLayout extends BrowserModule {}

export interface MockClientApp extends ClientApp {
  injector: MockInjector;
}

export async function createBrowserApp(
  modules: Array<ConstructorOf<BrowserModule>>,
  inj?: MockInjector,
): Promise<MockClientApp> {
  const injector = inj || new MockInjector();
  // 需要依赖前后端模块
  injector.addProviders(
    {
      token: ILoggerManagerClient,
      useValue: {
        getLogger() {
          return getDebugLogger();
        },
      },
    },
    {
      token: CommonServerPath,
      useValue: {
        getBackendOS: jest.fn(() => OS.Type.OSX),
      },
    },
  );
  const app = new ClientApp({
    modules: [MockMainLayout, ...modules],
    injector,
    layoutConfig: {},
  } as any) as MockClientApp;
  await app.start(document.getElementById('main')!);
  return app;
}

@Injectable()
class MockLogServiceForClient {
  private level: LogLevel;

  hasDisposeAll = false;

  async setGlobalLogLevel(level) {
    this.level = level;
  }

  async getGlobalLogLevel() {
    return this.level;
  }
  async getLevel() {
    return this.level;
  }
  async setLevel(level: LogLevel) {
    this.level = level;
  }
  async verbose() {
    //
  }
  async debug() {}
  async warn() {}
  async log() {}
  async error() {}
  async critical() {}
  async disposeLogger() {}
  async disposeAll() {
    this.hasDisposeAll = true;
  }
}

function getBrowserMockInjector() {
  const injector = new MockInjector();
  useMockStorage(injector);
  injector.addProviders(
    {
      token: IContextKeyService,
      useClass: MockContextKeyService,
    },
    {
      token: RecentFilesManager,
      useValue: {
        getMostRecentlyOpenedFiles: () => [],
      },
    },
    {
      token: LogServiceForClientPath,
      useClass: MockLogServiceForClient,
    },
    {
      token: ILoggerManagerClient,
      useClass: MockLoggerManageClient,
    },
    {
      token: ILogServiceManager,
      useClass: MockLoggerService,
    },
    {
      token: ILogger,
      useClass: MockLogger,
    },
  );
  return injector;
}

export function createBrowserInjector(modules: Array<ConstructorOf<BrowserModule>>, inj?: Injector): MockInjector {
  const injector = inj || getBrowserMockInjector();
  const app = new ClientApp({ modules, injector } as any);

  return app.injector as MockInjector;
}
