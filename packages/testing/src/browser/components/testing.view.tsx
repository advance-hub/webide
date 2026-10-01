import React, { useEffect, useState } from 'react';

import { ViewContextKeyRegistry, localize, useInjectable } from '@opensumi/ide-core-browser';
import { InlineMenuBar } from '@opensumi/ide-core-browser/components/actions';
import { LayoutViewSizeConfig } from '@opensumi/ide-core-browser/layout';
import { AbstractContextMenuService, IContextMenu, MenuId } from '@opensumi/ide-core-browser/menu';
import { TitleBar } from '@opensumi/ide-main-layout/accordion/titlebar';

import { Testing } from '../../common/constants';

import { TestingExplorerTree } from './testing.explorer.tree';
import styles from './testing.module.less';

export const TestingView = () => {
  const menuService = useInjectable<AbstractContextMenuService>(AbstractContextMenuService);
  const viewContextKeyRegistry = useInjectable<ViewContextKeyRegistry>(ViewContextKeyRegistry);
  const layoutViewSize = useInjectable<LayoutViewSizeConfig>(LayoutViewSizeConfig);

  const [menus, setMenus] = useState<IContextMenu>();

  useEffect(() => {
    const menu = menuService.createMenu({
      id: MenuId.ViewTitle,
      contextKeyService: viewContextKeyRegistry.getContextKeyService(Testing.ExplorerViewId),
    });
    setMenus(menu);
  }, []);

  return (
    <div className={styles.testing_container}>
      <TitleBar
        title={localize('test.title')}
        height={layoutViewSize.panelTitleBarHeight}
        menubar={menus ? <InlineMenuBar menus={menus}></InlineMenuBar> : null}
      />
      {/* 筛选器暂时先不搞 */}
      {/* <Input placeholder={'Filter (e.g. text, !exclude, @tag)'} addonAfter={<Icon icon='filter' />} /> */}
      <TestingExplorerTree />
    </div>
  );
};
