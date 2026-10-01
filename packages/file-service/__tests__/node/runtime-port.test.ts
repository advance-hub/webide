import { DiskFileServiceRuntimeBinding, DiskFileServiceRuntimePort, IDiskFileProvider } from '../../src/common';
import { DiskFileServiceProtocol } from '../../src/common/protocols/disk-file-service';
import { FileServiceModule } from '../../src/node';

describe('Disk File Service Node runtime port adapter', () => {
  it('keeps the Node RPC provider attached to the declared connection port', () => {
    expect.hasAssertions();
    const nodeBinding = new FileServiceModule().backServices.find(
      ({ servicePath }) => servicePath === DiskFileServiceRuntimeBinding.servicePath,
    );

    expect(DiskFileServiceRuntimeBinding.port).toBe(DiskFileServiceRuntimePort);
    expect(nodeBinding).toMatchObject({
      servicePath: DiskFileServiceRuntimeBinding.servicePath,
      token: IDiskFileProvider,
      protocol: DiskFileServiceProtocol,
    });
  });
});
