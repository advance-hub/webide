import type { IViewportRange } from '@xterm/xterm';

export interface ILinkHoverTargetOptions {
  readonly viewportRange: IViewportRange;
  readonly cellDimensions: {
    width: number;
    height: number;
  };
  readonly terminalDimensions: {
    width: number;
    height: number;
  };
  readonly boundingClientRect: {
    bottom: number;
    height: number;
    left: number;
    right: number;
    top: number;
    width: number;
    x: number;
    y: number;
  };
  readonly modifierDownCallback?: () => void;
  readonly modifierUpCallback?: () => void;
}
