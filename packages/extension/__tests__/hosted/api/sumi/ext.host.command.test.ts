import { IRPCProtocol } from '@opensumi/ide-connection';
import { mockService } from '@opensumi/ide-dev-tool/injector';

import { IMainThreadCommands, MainThreadAPIIdentifier } from '../../../../src/common/vscode';
import { createCommandsApiFactory } from '../../../../src/hosted/api/sumi/ext.host.command';
import { ExtHostCommands } from '../../../../src/hosted/api/vscode/ext.host.command';

describe('extension/__tests__/hosted/api/sumi/ext.host.command.test.ts', () => {
  let sumiCommand;
  let extCommand: ExtHostCommands;
  let mainService: IMainThreadCommands;
  const map = new Map();
  const rpcProtocol: IRPCProtocol = {
    getProxy: (key) => map.get(key),
    set: (key, value) => {
      map.set(key, value);
      return value;
    },
    get: (r) => map.get(r),
  };

  beforeEach(() => {
    mainService = mockService({});
    const editorService = mockService({});
    const extension = mockService({
      id: 'vscode.vim',
      extensionId: 'cloud-ide.vim',
      isBuiltin: false,
    });
    rpcProtocol.set(MainThreadAPIIdentifier.MainThreadCommands, mainService);
    extCommand = new ExtHostCommands(rpcProtocol);
    sumiCommand = createCommandsApiFactory(extCommand, editorService, extension);
  });

  describe('sumi api command', () => {
    it('execute a not allow command', async () => {
      const extTest = jest.fn();
      const commandId = 'ext.test';
      sumiCommand.registerCommandWithPermit(commandId, extTest, (extension) => extension.isBuiltin);
      await expect(sumiCommand.executeCommand(commandId)).rejects.toThrow(
        new Error(`Extension vscode.vim has not permit to execute ${commandId}`),
      );
      // 实际命令执行注册一次
      expect(extTest).toHaveBeenCalledTimes(0);
    });

    it('execute a allow command', async () => {
      const extTest = jest.fn();
      const commandId = 'ext.test';
      sumiCommand.registerCommandWithPermit(commandId, extTest, (extension) => !extension.isBuiltin);
      await sumiCommand.executeCommand(commandId);
      // 实际命令执行注册一次
      expect(extTest).toHaveBeenCalledTimes(1);
    });
  });
});
