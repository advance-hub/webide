import * as React from 'react';

import { useInjectable } from '@opensumi/ide-core-browser';
import { LayoutViewSizeConfig, VIEW_CONTAINERS } from '@opensumi/ide-core-browser/layout';
import { MenuBar } from '@opensumi/ide-menu-bar/view';

import styles from './menu-bar.module.less';

/**
 * Custom menu bar component.
 * Add a logo in here, and keep
 * opensumi's original menubar.
 */
export const MenuBarView = () => {
  const layoutViewSize = useInjectable<LayoutViewSizeConfig>(LayoutViewSizeConfig);

  return (
    <div id={VIEW_CONTAINERS.MENUBAR} className={styles.menu_bar_view} style={{ height: layoutViewSize.menubarHeight }}>
      <span className={styles.menu_bar_logo} />
      <MenuBar />
    </div>
  );
};
