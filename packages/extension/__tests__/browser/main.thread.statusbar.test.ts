import { CommandRegistry, CommandRegistryImpl } from '@opensumi/ide-core-common';
import { createBrowserInjector } from '@opensumi/ide-dev-tool/browser';
import { createMockPairRPCProtocol } from '@opensumi/ide-dev-tool/mocks/extension-rpc';
import { IStatusBarService } from '@opensumi/ide-status-bar';
import { StatusBarService } from '@opensumi/ide-status-bar/service';

import { mockExtensionDescription } from '../../__mocks__/extensions';
import { MainThreadStatusBar } from '../../src/browser/vscode/api/main.thread.statusbar';
import { ExtHostAPIIdentifier, MainThreadAPIIdentifier } from '../../src/common/vscode';
import { StatusBarAlignment } from '../../src/common/vscode/ext-types';
import { ExtHostStatusBar } from '../../src/hosted/api/vscode/ext.host.statusbar';

const { rpcProtocolExt, rpcProtocolMain } = createMockPairRPCProtocol();

describe('MainThreadStatusBar API Test Suites', () => {
  const injector = createBrowserInjector([]);
  let extHostStatusBar: ExtHostStatusBar;
  let mainthreadStatusbar: MainThreadStatusBar;
  let statusbarService: IStatusBarService;

  injector.addProviders(
    ...[
      {
        token: IStatusBarService,
        useClass: StatusBarService,
      },
      {
        token: CommandRegistry,
        useClass: CommandRegistryImpl,
      },
    ],
  );
  beforeAll((done) => {
    mainthreadStatusbar = injector.get(MainThreadStatusBar, [rpcProtocolMain]);
    rpcProtocolMain.set<MainThreadStatusBar>(MainThreadAPIIdentifier.MainThreadStatusBar, mainthreadStatusbar);
    extHostStatusBar = rpcProtocolExt.set(ExtHostAPIIdentifier.ExtHostStatusBar, new ExtHostStatusBar(rpcProtocolExt));
    statusbarService = injector.get(IStatusBarService);
    done();
  });

  it('should can create statusbar item', async () => {
    const statusbar = extHostStatusBar.createStatusBarItem(
      mockExtensionDescription,
      'test',
      StatusBarAlignment.Left,
      1,
    );
    statusbar.show();
    statusbar.text = 'test';
    expect(statusbar).toBeDefined();
    statusbar.dispose();
  });

  it('should update statusbar', (done) => {
    const statusbar = extHostStatusBar.createStatusBarItem(
      mockExtensionDescription,
      'test',
      StatusBarAlignment.Right,
      1,
    );
    statusbar.show();
    statusbar.text = 'test1';
    statusbar.color = '#ff004f';
    statusbar.command = 'test:command';
    statusbar.tooltip = 'testtooltip';

    setTimeout(() => {
      expect(statusbarService.rightEntries.get().length).toBe(1);
      const mainthreadStatusbarItem = statusbarService.rightEntries.get()[0];
      expect(mainthreadStatusbarItem.text).toBe('test1');
      expect(mainthreadStatusbarItem.alignment).toBe(1);
      expect(mainthreadStatusbarItem.color).toBe('#ff004f');
      expect(mainthreadStatusbarItem.command).toBe('test:command');
      expect(mainthreadStatusbarItem.tooltip).toBe('testtooltip');
      statusbar.dispose();
      done();
    }, 50);
  });

  it('can execute command via statusbar', (done) => {
    const commandRegistry = injector.get<CommandRegistry>(CommandRegistry);
    commandRegistry.registerCommand(
      { id: 'test:statusbar' },
      {
        execute: () => {
          done();
        },
      },
    );
    const statusbar = extHostStatusBar.createStatusBarItem(
      mockExtensionDescription,
      'test',
      StatusBarAlignment.Left,
      1,
    );
    statusbar.command = 'test:statusbar';
    statusbar.show();
    setTimeout(() => {
      const mainthreadStatusbarItem = statusbarService.leftEntries.get()[0];
      if (mainthreadStatusbarItem.onClick) {
        mainthreadStatusbarItem.onClick({});
      }
    }, 40);
  });
});
