import { FileServiceClientModule } from '../../src/browser';
import { DiskFileServiceRuntimeBinding, DiskFileServiceRuntimePort, IDiskFileProvider } from '../../src/common';
import { DiskFileServiceProtocol } from '../../src/common/protocols/disk-file-service';

describe('Disk File Service Browser runtime port adapter', () => {
  it('keeps the Browser RPC consumer attached to the declared connection port', () => {
    expect.hasAssertions();
    const browserBinding = new FileServiceClientModule().backServices.find(
      ({ servicePath }) => servicePath === DiskFileServiceRuntimeBinding.servicePath,
    );

    expect(DiskFileServiceRuntimeBinding.port).toBe(DiskFileServiceRuntimePort);
    expect(browserBinding).toMatchObject({
      servicePath: DiskFileServiceRuntimeBinding.servicePath,
      clientToken: IDiskFileProvider,
      protocol: DiskFileServiceProtocol,
    });
  });
});
