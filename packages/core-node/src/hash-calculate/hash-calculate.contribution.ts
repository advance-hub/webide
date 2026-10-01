import { Autowired } from '@opensumi/di';
import { Domain } from '@opensumi/ide-core-common';
import { IHashCalculateService } from '@opensumi/ide-core-common/hash';

import { ServerAppContribution } from '../types';

@Domain(ServerAppContribution)
export class HashCalculateContribution implements ServerAppContribution {
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
