import type { IEventSubscriber } from './event-subscriber';
import type { MenuNode } from './menu-node';
import type { Event, IDisposable } from '@opensumi/ide-utils';

export interface INativeMenuTemplate {
  id?: string;
  label?: string;
  type?: 'separator' | 'checkbox';
  submenu?: INativeMenuTemplate[];
  accelerator?: string;
  disabled?: boolean;
  selected?: boolean;
  action?: boolean;
  role?: string;
  checked?: boolean;
}

export interface IElectronMainMenuService extends IEventSubscriber<'menuClick' | 'menuClose'> {
  showContextMenu(template: INativeMenuTemplate, webContentsId: number): Promise<void>;
  setApplicationMenu(template: INativeMenuTemplate, windowId: number): Promise<void>;
  on(event: 'menuClick', listener: (targetId: string, menuId: string) => void): IDisposable;
  on(event: 'menuClose', listener: (targetId: string, contextMenuId: string) => void): IDisposable;
  runNativeRoleAction(actionName: string): Promise<void>;
}

export const IElectronMainMenuService = 'IElectronMainMenuService';

export interface ISumiMenuExtendInfo {
  command: string;
  extraDesc?: string;
}

export { MenuNode } from './menu-node';
export type { IMenuAction, IMenuActionDisplayType } from './menu-node';

export type TupleMenuNodeResult = [MenuNode[], MenuNode[]];

export interface IContextMenu extends IDisposable {
  /**
   * menu-id
   */
  menuId: string;
  /**
   * menu 重新生成后事件，监听即可拿到最新的 menu
   */
  readonly onDidChange: Event<string>;

  /**
   * 获得已分好组并合并的 MenuNodes 列表
   */
  getMergedMenuNodes(): MenuNode[];

  /**
   * 获得已分好组的 MenuNodes 列表
   */
  getGroupedMenuNodes(): TupleMenuNodeResult;
}

export interface IMenuNodeOptions {
  /**
   * 固定参数可从这里传入
   */
  args?: any[];
  contextDom?: HTMLElement;
}

export type IMenuSeparator = 'navigation' | 'inline';

export interface IMenuConfig extends IMenuNodeOptions {
  separator?: IMenuSeparator;
  withAlt?: boolean; // 尚未支持
}

export interface IMenu<TNode extends MenuNode = MenuNode> extends IDisposable {
  /**
   * menu-id
   */
  menuId: string;
  readonly onDidChange: Event<IMenu<TNode> | undefined>;
  getMenuNodes(options?: IMenuNodeOptions): Array<[string, TNode[]]>;
  onDispose: Event<void>;
}
