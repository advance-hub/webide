import { Injectable, Provider } from '@opensumi/di';
import { BrowserModule } from '@opensumi/ide-core-browser';

import { CloudDevAIContribution } from './cloud-dev-ai.contribution';
import { CloudDevContribution } from './cloud-dev.contribution';

export { CLOUD_DEV_CONTAINER_ID } from './cloud-dev.contribution';

@Injectable()
export class CloudDevModule extends BrowserModule {
  providers: Provider[] = [CloudDevContribution, CloudDevAIContribution];
}
