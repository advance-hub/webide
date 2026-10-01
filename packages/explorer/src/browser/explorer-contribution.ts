import { Autowired } from '@opensumi/di';
import {
  ClientAppContribution,
  ComponentContribution,
  ComponentRegistry,
  Domain,
  formatLocalize,
  getIcon,
  localize,
} from '@opensumi/ide-core-browser';
import { browserViews } from '@opensumi/ide-core-browser/contribution-schemas';
import { IExtensionsSchemaService } from '@opensumi/ide-core-common';
import { EXPLORER_CONTAINER_ID } from '@opensumi/ide-core-common/workbench';

export { EXPLORER_CONTAINER_ID };

@Domain(ClientAppContribution, ComponentContribution)
export class ExplorerContribution implements ClientAppContribution, ComponentContribution {
  @Autowired(IExtensionsSchemaService)
  protected readonly extensionsSchemaService: IExtensionsSchemaService;

  /**
   * register `explorer` component container
   */
  registerComponent(registry: ComponentRegistry) {
    registry.register('@opensumi/ide-explorer', [], {
      iconClass: getIcon('explorer'),
      title: localize('explorer.title'),
      priority: 10,
      containerId: EXPLORER_CONTAINER_ID,
      activateKeyBinding: 'ctrlcmd+shift+e',
    });
  }

  onStart() {
    this.extensionsSchemaService.appendExtensionPoint(['browserViews', 'properties'], {
      extensionPoint: EXPLORER_CONTAINER_ID,
      frameworkKind: ['opensumi'],
      jsonSchema: {
        ...browserViews.properties,
        description: formatLocalize('sumiContributes.browserViews.location.custom', localize('explorer.title')),
      },
    });
  }
}
