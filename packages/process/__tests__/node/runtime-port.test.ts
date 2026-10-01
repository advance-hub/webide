import { IProcessFactory, IProcessManage, ProcessFactoryRuntimePort, processManageServicePath } from '../../src/common';
import { ProcessModule } from '../../src/node';
import { ProcessFactory } from '../../src/node/process';

describe('ProcessFactoryRuntimePort', () => {
  it('describes the existing application-owned factory provider', () => {
    expect.hasAssertions();

    expect(ProcessFactoryRuntimePort).toEqual({
      id: 'opensumi.process.factory',
      version: 1,
      scope: 'application',
    });

    expect(new ProcessModule().providers).toContainEqual({
      token: IProcessFactory,
      useClass: ProcessFactory,
    });
  });

  it('preserves the legacy ProcessManage RPC compatibility binding', () => {
    expect.hasAssertions();

    expect(new ProcessModule().backServices).toContainEqual({
      servicePath: processManageServicePath,
      token: IProcessManage,
    });
  });
});
