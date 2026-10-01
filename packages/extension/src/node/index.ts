import { Autowired, Injectable, Provider } from '@opensumi/di';
import { Domain, INodeLogger, NodeModule, ServerAppContribution } from '@opensumi/ide-core-node';

import {
  ExtensionHostControlRuntimeBinding,
  ExtensionHostProfilerServicePath,
  ExtensionHostProfilerServiceToken,
  IExtensionHostManager,
  IExtensionNodeClientService,
  IExtensionNodeService,
} from '../common';

import {
  DefaultExtensionHostProfilerTargetSource,
  ExtensionHostProfilerCoordinator,
} from './extension-host-profiler-coordinator';
import { ExtensionHostManager } from './extension.host.manager';
import { ExtensionProfilerService } from './extension.profiler.service';
import { ExtensionNodeServiceImpl } from './extension.service';
import { ExtensionServiceClientImpl } from './extension.service.client';

export * from './extension-host-process-manager';

@Injectable()
export class ExtensionModule extends NodeModule {
  providers: Provider[] = [
    {
      token: IExtensionNodeService,
      useClass: ExtensionNodeServiceImpl,
    },
    {
      token: IExtensionNodeClientService,
      useClass: ExtensionServiceClientImpl,
    },
    {
      token: ExtensionHostProfilerServiceToken,
      useClass: ExtensionProfilerService,
    },
    DefaultExtensionHostProfilerTargetSource,
    ExtensionHostProfilerCoordinator,
    {
      token: IExtensionHostManager,
      useClass: ExtensionHostManager,
    },
    ExtensionContribution,
  ];
  backServices = [
    {
      servicePath: ExtensionHostControlRuntimeBinding.servicePath,
      token: IExtensionNodeClientService,
    },
    {
      servicePath: ExtensionHostProfilerServicePath,
      token: ExtensionHostProfilerServiceToken,
    },
  ];
}

@Domain(ServerAppContribution)
export class ExtensionContribution implements ServerAppContribution {
  @Autowired(IExtensionNodeService)
  extensionNodeService: IExtensionNodeService;

  @Autowired(INodeLogger)
  logger: INodeLogger;

  async initialize() {
    await this.extensionNodeService.initialize();
    this.logger.verbose('Extension server initialized');
  }

  async onStop() {
    await this.extensionNodeService.disposeAllClientExtProcess();
    this.logger.warn('All extension process exit by server stop');
  }
}
