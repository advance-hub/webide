import { Autowired } from '@opensumi/di';
import { getIcon } from '@opensumi/ide-components';
import { LabelService } from '@opensumi/ide-core-browser';
import { IMenuRegistry, MenuContribution, MenuId } from '@opensumi/ide-core-browser/menu';
import { Domain, URI, localize } from '@opensumi/ide-core-common';
import {
  BrowserEditorContribution,
  EditorComponentRegistry,
  EditorComponentRenderMode,
  IResource,
  ResourceService,
} from '@opensumi/ide-editor/types';
import { IconService } from '@opensumi/ide-theme/browser';
import { IWorkspaceService } from '@opensumi/ide-workspace';

import { MCPConfigView } from './components/mcp-config.view';
import { MCPConfigCommands, MCP_CONFIG_COMPONENTS_SCHEME_ID } from './mcp-config.constants';

const COMPONENTS_ID = 'opensumi-mcp-config-viewer';
export { MCP_CONFIG_COMPONENTS_SCHEME_ID } from './mcp-config.constants';

export type IMCPConfigResource = IResource<{ configType: string }>;

@Domain(BrowserEditorContribution, MenuContribution)
export class MCPConfigContribution implements BrowserEditorContribution, MenuContribution {
  @Autowired(IWorkspaceService)
  protected readonly workspaceService: IWorkspaceService;

  @Autowired(IconService)
  protected readonly iconService: IconService;

  @Autowired()
  labelService: LabelService;

  registerEditorComponent(registry: EditorComponentRegistry) {
    registry.registerEditorComponent({
      uid: COMPONENTS_ID,
      scheme: MCP_CONFIG_COMPONENTS_SCHEME_ID,
      component: MCPConfigView,
      renderMode: EditorComponentRenderMode.ONE_PER_WORKBENCH,
    });

    registry.registerEditorComponentResolver(MCP_CONFIG_COMPONENTS_SCHEME_ID, (resource, results) => {
      results.push({
        type: 'component',
        componentId: COMPONENTS_ID,
      });
    });
  }

  registerResource(service: ResourceService) {
    service.registerResourceProvider({
      scheme: MCP_CONFIG_COMPONENTS_SCHEME_ID,
      provideResource: async (uri: URI): Promise<IMCPConfigResource> => {
        const { configType } = uri.getParsedQuery();

        return {
          uri,
          name: localize('ai.native.mcp.config.title'),
          icon: getIcon('mcp'),
          metadata: {
            configType,
          },
        };
      },
    });
  }

  registerMenus(menus: IMenuRegistry) {
    menus.registerMenuItem(MenuId.EditorTitle, {
      command: MCPConfigCommands.OPEN_MCP_CONFIG_FILE.id,
      iconClass: getIcon('open'),
      group: 'navigation',
      order: 4,
      when: `resourceScheme == ${MCP_CONFIG_COMPONENTS_SCHEME_ID}`,
    });

    menus.registerMenuItem(MenuId.EditorTitle, {
      command: MCPConfigCommands.OPEN_MCP_CONFIG.id,
      iconClass: getIcon('open'),
      group: 'navigation',
      order: 4,
      when: 'resourceFilename =~ /mcp.json/',
    });
  }
}
