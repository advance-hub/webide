import { replaceLocalizePlaceholder } from './localize';

import type { ButtonType } from './action-types';

/**
 * 这里的 MenuAction 的展示类型拓展为支持 Button 组件的类型以及 checkbox
 * 由于 Comment 模块的默认用的 Menu 的展示类型为 Button 类型
 * 同时从设计角度更完善的展示 checked 属性，额外拓展了 checkbox 类型
 * 用在 button 类型时 checked 状态的展示
 */
export type IMenuActionDisplayType = ButtonType | 'checkbox';

export interface IMenuAction {
  /**
   * command id
   */
  readonly id: string;
  label: string;
  /**
   * 标准的 vscode icon 是分两种主题的
   */
  icon?: string;
  tooltip?: string;
  className?: string;
  /**
   * 快捷键描述
   */
  keybinding?: string;
  rawKeybinding?: string;
  /**
   * 是否为组合键
   */
  isKeyCombination?: boolean;
  /**
   * disable 状态的 menu
   */
  disabled?: boolean;
  /**
   * checked 状态 通过 toggledWhen 实现
   */
  checked?: boolean;
  /**
   * electron menu 使用
   */
  nativeRole?: string;
  execute?: (...args: any[]) => any;
  /**
   * 默认值为 'icon'
   */
  type?: IMenuActionDisplayType;
  /**
   * menu 子项最右侧的额外描述信息
   */
  extraDesc?: string;
}

/**
 * base 类
 */
export class MenuNode implements IMenuAction {
  readonly id: string;
  label: string;
  icon?: string;
  tooltip?: string;
  className?: string;
  keybinding: string;
  rawKeybinding: string;
  isKeyCombination: boolean;
  disabled: boolean;
  checked: boolean;
  nativeRole: string;
  extraDesc: string;
  children: MenuNode[];
  type?: IMenuActionDisplayType;
  protected _actionCallback?: (...args: any[]) => any;

  constructor(props: IMenuAction) {
    this.id = props.id;
    this.label = replaceLocalizePlaceholder(props.label)!;
    this.className = props.className || '';
    this.icon = props.icon || '';
    this.keybinding = props.keybinding || '';
    this.rawKeybinding = props.rawKeybinding || '';
    this.isKeyCombination = Boolean(props.isKeyCombination);
    this.disabled = Boolean(props.disabled);
    this.checked = Boolean(props.checked);
    this.nativeRole = props.nativeRole || '';
    this.type = props.type;
    this.extraDesc = props.extraDesc || '';
    this._actionCallback = props.execute;
  }

  getExecuteArgs(...args: any[]): any[] {
    return args;
  }

  execute(...args: any[]): any {
    const runArgs = this.getExecuteArgs(args);
    if (this._actionCallback) {
      return this._actionCallback(...runArgs);
    }

    return Promise.resolve(true);
  }

  updateLabel(newLabel: string): void {
    this.label = newLabel;
  }
}
