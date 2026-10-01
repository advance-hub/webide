import {
  ComponentContribution,
  ComponentRegistry,
  Disposable,
  IToolbarRegistry,
  ToolBarActionContribution,
} from '@opensumi/ide-core-browser';
import { Domain } from '@opensumi/ide-core-common';

import { ToolbarAction } from './toolbar-action.view';

@Domain(ComponentContribution, ToolBarActionContribution)
export class MenuBarWebContribution extends Disposable implements ComponentContribution, ToolBarActionContribution {
  registerComponent(registry: ComponentRegistry) {
    registry.register('@opensumi/ide-toolbar-action', {
      id: 'ide-toolbar-action',
      component: ToolbarAction,
    });
  }

  registerToolbarActions(registry: IToolbarRegistry) {
    registry.addLocation('menu-right');
    registry.addLocation('menu-left');
  }
}
