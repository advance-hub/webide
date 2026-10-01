import { Autowired } from '@opensumi/di';
import { ClientAppContribution, Domain, Schemes } from '@opensumi/ide-core-browser';
import { IFileServiceClient } from '@opensumi/ide-file-service';
import { FileServiceClient } from '@opensumi/ide-file-service/browser/client';

import { IUserStorageService } from '../../common';

@Domain(ClientAppContribution)
export class UserStorageContribution implements ClientAppContribution {
  @Autowired(IUserStorageService)
  private readonly userStorageService: IUserStorageService;

  @Autowired(IFileServiceClient)
  protected readonly fileSystem: FileServiceClient;

  initialize() {
    this.fileSystem.registerProvider(Schemes.userStorage, this.userStorageService);
  }
}
