import { Injectable, Provider } from '@opensumi/di';
import { BrowserModule, IStatusBarService } from '@opensumi/ide-core-browser';

import { StatusBarContribution } from './status-bar.contribution';
// import { IStatusBarService } from '../common';
import { StatusBarService } from './status-bar.service';

@Injectable()
export class StatusBarModule extends BrowserModule {
  providers: Provider[] = [
    {
      token: IStatusBarService,
      useClass: StatusBarService,
    },
    StatusBarContribution,
  ];
}
