export * from './portal';
export * from './resize/resize';
export * from './layout';
export { Select as NativeSelect } from './select';

/**
 * re exports from ide-components
 */
export * from '@opensumi/ide-components/button';
export * from '@opensumi/ide-components/badge';
export { TextArea, Input, VALIDATE_TYPE, ValidateInput, bindInputElement, InputNumber } from '@opensumi/ide-components';
export type {
  InputSelection,
  IInputBaseProps,
  ValidateMessage,
  ValidateInputProp,
  ProxiedInputProp,
  InputNumberProps,
} from '@opensumi/ide-components';
export * from '@opensumi/ide-components/checkbox';
export * from '@opensumi/ide-components/select';
export * from '@opensumi/ide-components/tabs';
export * from '@opensumi/ide-components/overlay';
export * from '@opensumi/ide-components/dialog';
export {
  createFromIconfontCN,
  IconContextProvider,
  IconContext,
  _InternalIcon,
  Icon,
  updateIconMap,
  getIconShapeClxList,
  getIcon,
  ROTATE_TYPE,
  ANIM_TYPE,
  getKaitianIcon,
  updateKaitianIconMap,
} from '@opensumi/ide-components';
export type {
  DefaultIconKeys,
  IIconResourceOptions,
  IiconContext,
  IconBaseProps,
  IconProps,
  IIconShapeOptions,
} from '@opensumi/ide-components';
export * from '@opensumi/ide-components/notification';
export * from '@opensumi/ide-components/popover';
export * from '@opensumi/ide-components/message';
export * from '@opensumi/ide-components/tooltip';
export * from '@opensumi/ide-components/recycle-list';

// re export `Scroll` for backward compatibility
export { Scrollbars, Scrollbars as Scroll } from '@opensumi/ide-components/scrollbars';
