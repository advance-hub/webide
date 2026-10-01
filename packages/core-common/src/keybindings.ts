import type { ContextKeyExpression } from '@opensumi/monaco-editor-core/esm/vs/platform/contextkey/common/contextkey';

export enum KeybindingScope {
  DEFAULT,
  USER,
  WORKSPACE,
  END,
}

// ref: https://github.com/Microsoft/vscode/blob/97fc588e65bedcb1113baeddd2f67237e52c8c63/src/vs/platform/keybinding/common/keybindingsRegistry.ts#L56
// 快捷键第一优先级，将对该值 * 100 作为快捷键的优先级参数 priority
export enum KeybindingWeight {
  Default = 0, // 不传入 priority 则默认为 0
  EditorCore = 1,
  EditorContrib = 100,
  WorkbenchContrib = 200,
  BuiltinExtension = 300,
  ExternalExtension = 400,
}

export namespace KeybindingScope {
  export const length = KeybindingScope.END - KeybindingScope.DEFAULT;
}

export namespace Keybinding {
  /**
   * 返回带有绑定的字符串表达式
   * 仅序列化关键的快捷键及command
   * 在快捷时被使用
   *
   * @param binding 按键绑定的字符串表达式.
   */
  export function stringify(binding: Keybinding): string {
    const copy: Keybinding = {
      command: binding.command,
      keybinding: binding.keybinding,
    };
    return JSON.stringify(copy);
  }

  // 判断一个对象是否为Keybinding对象
  export function is(arg: Keybinding | any): arg is Keybinding {
    return !!arg && arg === Object(arg) && 'command' in arg && 'keybinding' in arg;
  }
}

export namespace KeybindingsResultCollection {
  export class KeybindingsResult {
    public full: Keybinding[] = [];
    public partial: Keybinding[] = [];
    public shadow: Keybinding[] = [];

    /**
     * 合并KeybindingsResult至this
     *
     * @param other
     * @return this
     */
    public merge(other: KeybindingsResult): KeybindingsResult {
      this.full.push(...other.full);
      this.partial.push(...other.partial);
      this.shadow.push(...other.shadow);
      return this;
    }

    /**
     * 返回一个新的过滤后的 KeybindingsResult
     *
     * @param fn 过滤函数
     * @return KeybindingsResult
     */
    public filter(fn: (binding: Keybinding) => boolean): KeybindingsResult {
      const result = new KeybindingsResult();
      result.full = this.full.filter(fn);
      result.partial = this.partial.filter(fn);
      result.shadow = this.shadow.filter(fn);
      return result;
    }
  }
}

export interface Keybinding {
  // 命令ID
  command: string;

  // 快捷键字符串
  keybinding: string;

  /**
   * https://code.visualstudio.com/docs/getstarted/keybindings#_when-clause-contexts
   */
  when?: string | ContextKeyExpression;

  // Command执行参数
  args?: any;

  // 快捷键匹配的优先级
  priority?: number;
}
