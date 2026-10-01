import { Drawer as ArcoDrawer, Modal as ArcoModal, type DrawerProps, type ModalProps } from '@arco-design/web-react';
import { IconClose } from '@arco-design/web-react/icon';
import { type PropsWithChildren, useId, useLayoutEffect, useRef } from 'react';

const closeControl = (
  <button type='button' className='overlay-close' aria-label='关闭'>
    <IconClose />
  </button>
);

// Arco locks focus within the overlay. Restore the opener after its exit
// animation, including when one confirmation is stacked over another drawer.
function useReturnFocus(visible?: boolean) {
  const opener = useRef<HTMLElement | null>(null);
  const previous = useRef(false);
  useLayoutEffect(() => {
    if (visible && !previous.current) {opener.current = document.activeElement as HTMLElement;}
    previous.current = !!visible;
  }, [visible]);
  return () => {
    if (opener.current?.isConnected) {opener.current.focus({ preventScroll: true });}
  };
}

export function Modal({
  width = 520,
  afterClose,
  style,
  ...props
}: PropsWithChildren<ModalProps & { width?: number }>) {
  const restore = useReturnFocus(props.visible);
  return (
    <ArcoModal
      {...props}
      focusLock
      closeIcon={closeControl}
      maskClosable={false}
      style={{ width, maxWidth: 'calc(100vw - 32px)', ...style }}
      afterClose={() => {
        restore();
        afterClose?.();
      }}
    />
  );
}

export function Drawer({ afterClose, title, ...props }: DrawerProps) {
  const restore = useReturnFocus(props.visible);
  const titleId = useId();
  const accessibility = { role: 'dialog', 'aria-modal': true, 'aria-labelledby': titleId } as const;
  return (
    <ArcoDrawer
      footer={null}
      {...props}
      {...accessibility}
      title={<span id={titleId}>{title}</span>}
      closeIcon={closeControl}
      focusLock
      afterClose={() => {
        restore();
        afterClose?.();
      }}
    />
  );
}
