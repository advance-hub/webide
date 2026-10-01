import { Autowired } from '@opensumi/di';
import { Domain } from '@opensumi/ide-core-common';
import { IHashCalculateService } from '@opensumi/ide-core-common/hash';

import { ClientAppContribution } from '../common/common.define';

@Domain(ClientAppContribution)
export class HashCalculateContribution implements ClientAppContribution {
  @Autowired(IHashCalculateService)
  private readonly hashCalculateService: IHashCalculateService;

  async initialize() {
    try {
      await this.hashCalculateService.initialize();
    } catch (err) {
      throw new Error(`hashCalculateService init fail: \n ${err.message}`, { cause: err });
    }
  }
}
