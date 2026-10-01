import { getExternalIcon } from '@opensumi/ide-core-common/icon-names';
import { SymbolKind as SymbolKindEnum } from '@opensumi/monaco-editor-core/esm/vs/editor/common/languages';

import { IDE_CODICONS_CN_CSS, IDE_ICONFONT_CN_CSS, IDE_OCTICONS_CN_CSS } from './ide-iconfont';

export { updateIconMap, getIcon } from '@opensumi/ide-components/icon-utils';
export {
  getOctIcon,
  CODICON_OWNER,
  KTICON_OWNER,
  getExternalIcon,
  asClassNameArrayWrapper,
} from '@opensumi/ide-core-common/icon-names';

export const DEFAULT_CDN_ICON = IDE_ICONFONT_CN_CSS;
export { IDE_OCTICONS_CN_CSS, IDE_CODICONS_CN_CSS };

/**
 * @internal
 */
export const getSymbolIcon = (() => {
  const _fromMapping: { [n: number]: string } = Object.create(null);
  _fromMapping[SymbolKindEnum.File] = 'file';
  _fromMapping[SymbolKindEnum.Module] = 'module';
  _fromMapping[SymbolKindEnum.Namespace] = 'namespace';
  _fromMapping[SymbolKindEnum.Package] = 'package';
  _fromMapping[SymbolKindEnum.Class] = 'class';
  _fromMapping[SymbolKindEnum.Method] = 'method';
  _fromMapping[SymbolKindEnum.Property] = 'property';
  _fromMapping[SymbolKindEnum.Field] = 'field';
  _fromMapping[SymbolKindEnum.Constructor] = 'constructor';
  _fromMapping[SymbolKindEnum.Enum] = 'enum';
  _fromMapping[SymbolKindEnum.Interface] = 'interface';
  _fromMapping[SymbolKindEnum.Function] = 'function';
  _fromMapping[SymbolKindEnum.Variable] = 'variable';
  _fromMapping[SymbolKindEnum.Constant] = 'constant';
  _fromMapping[SymbolKindEnum.String] = 'string';
  _fromMapping[SymbolKindEnum.Number] = 'number';
  _fromMapping[SymbolKindEnum.Boolean] = 'boolean';
  _fromMapping[SymbolKindEnum.Array] = 'array';
  _fromMapping[SymbolKindEnum.Object] = 'object';
  _fromMapping[SymbolKindEnum.Key] = 'key';
  _fromMapping[SymbolKindEnum.Null] = 'null';
  _fromMapping[SymbolKindEnum.EnumMember] = 'enum-member';
  _fromMapping[SymbolKindEnum.Struct] = 'struct';
  _fromMapping[SymbolKindEnum.Event] = 'event';
  _fromMapping[SymbolKindEnum.Operator] = 'operator';
  _fromMapping[SymbolKindEnum.TypeParameter] = 'type-parameter';

  return function toCssClassName(kind: SymbolKindEnum, inline?: boolean): string {
    return getExternalIcon(`symbol-${_fromMapping[kind] || 'property'}`);
  };
})();
