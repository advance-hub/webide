import { Avatar, Breadcrumb, Button, Input, Layout, Menu, Tag, Tooltip } from '@arco-design/web-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';

import { projectHref } from '../domain/presentation';

import {
  AppsIcon,
  CloudIcon,
  CodeIcon,
  DashboardIcon,
  ExpandSidebarIcon,
  FoldSidebarIcon,
  MenuIcon,
  ProjectsIcon,
  SearchIcon,
  SettingsIcon,
  StorageIcon,
  WorkspaceIcon,
} from './icons';
import { Drawer, Modal } from './overlays';

import type { Navigation } from '../routing/use-route';
import type { Workbench } from '../state/use-workbench';
import type { RefInputType } from '@arco-design/web-react/es/Input';

const groups = [
  {
    title: '研发工作台',
    items: [
      { href: '/dashboard', name: '开发总览', icon: <DashboardIcon /> },
      { href: '/projects', name: '项目管理', icon: <ProjectsIcon /> },
      { href: '/workspaces', name: '工作区', icon: <WorkspaceIcon /> },
    ],
  },
  {
    title: '资源与配置',
    items: [
      { href: '/development-resources', name: '开发资源', icon: <StorageIcon /> },
      { href: '/connection', name: '代码源', icon: <CodeIcon /> },
      { href: '/environment', name: '开发环境', icon: <SettingsIcon /> },
    ],
  },
  {
    title: '平台管理',
    items: [
      { href: '/images', name: '开发镜像', icon: <AppsIcon /> },
      { href: '/sandbox-admin', name: '沙箱管理', icon: <CloudIcon /> },
    ],
  },
];
const pages = groups.flatMap((group) => group.items);

export function Shell({
  wb,
  route,
  navigate,
  children,
}: {
  wb: Workbench;
  route: URL;
  navigate: Navigation;
  children: ReactNode;
}) {
  const [search, setSearch] = useState(false);
  const [query, setQuery] = useState('');
  const [navOpen, setNavOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return localStorage.getItem('workbench-sidebar-collapsed') === '1';
    } catch {
      return false;
    }
  });
  const searchInput = useRef<RefInputType>(null);
  const path = route.pathname;
  const current =
    path === '/' ? '/dashboard' : path.startsWith('/projects/') || path === '/import' ? '/projects' : path;
  const currentGroup = groups.find((group) => group.items.some((item) => item.href === current));
  const selected = wb.projects.find((project) => path === `/projects/${project.id}`);
  const accountName = wb.user?.mode === 'demo' ? '本机管理员' : wb.user?.name || '未登录';
  const runtimeName = wb.config?.driver === 'local' ? '本机运行' : 'OpenSandbox';
  const open = (href: string) => {
    setNavOpen(false);
    setSearch(false);
    navigate(href);
  };
  const toggleSidebar = () =>
    setCollapsed((value) => {
      try {
        localStorage.setItem('workbench-sidebar-collapsed', value ? '0' : '1');
      } catch {
        /* 存储不可用时，当前会话内的偏好仍然生效。 */
      }
      return !value;
    });
  const openSearch = () => {
    setQuery('');
    setSearch(true);
    setNavOpen(false);
  };
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setQuery('');
        setNavOpen(false);
        setSearch((value) => !value);
      }
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, []);
  const availablePages = pages.filter((page) => page.href !== '/sandbox-admin' || wb.config?.sandboxAdmin);
  const results = [
    ...wb.projects
      .filter((project) => `${project.name} ${project.url}`.toLowerCase().includes(query.toLowerCase()))
      .slice(0, 8)
      .map((project) => ({ href: projectHref(project.id), name: project.name, icon: <ProjectsIcon />, type: '项目' })),
    ...availablePages.filter((page) => page.name.includes(query)).map((page) => ({ ...page, type: '功能' })),
  ];
  const navigation = (compact = false) => (
    <>
      <div className='sidebar-scroll'>
        {groups.map((group) => (
          <section key={group.title} className='sidebar-section'>
            {!compact && <div className='nav-caption'>{group.title}</div>}
            <Menu
              className='side-navigation'
              aria-label={group.title}
              collapse={compact}
              selectedKeys={[current]}
              onClickMenuItem={(key, event) => {
                if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                  return;
                }
                event.preventDefault();
                open(key);
              }}
            >
              {group.items
                .filter((item) => availablePages.includes(item))
                .map((item) => (
                  <Menu.Item key={item.href}>
                    {item.icon}
                    <a href={`#${item.href}`} tabIndex={-1} aria-current={current === item.href ? 'page' : undefined}>
                      {item.name}
                    </a>
                  </Menu.Item>
                ))}
            </Menu>
          </section>
        ))}
      </div>
      <div className='sidebar-footnote'>
        <CloudIcon />
        {!compact && <span>个人开发机 · 多项目协作</span>}
      </div>
    </>
  );

  return (
    <Layout className={`app-shell${collapsed ? ' sidebar-is-collapsed' : ''}`}>
      <header className='app-header'>
        <a className='brand' href='#/dashboard' aria-label='OpenSumi 云开发首页'>
          <span className='brand-mark'>
            <CodeIcon />
          </span>
          <span>
            OpenSumi <span className='brand-subtitle'>云开发</span>
          </span>
        </a>
        <Button
          className='desktop-collapse'
          type='text'
          aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
          icon={collapsed ? <ExpandSidebarIcon /> : <FoldSidebarIcon />}
          onClick={toggleSidebar}
        />
        <Button
          className='mobile-menu'
          type='text'
          aria-label='展开导航'
          icon={<MenuIcon />}
          onClick={() => setNavOpen(true)}
        />
        <Breadcrumb className='location-bar'>
          <Breadcrumb.Item>{currentGroup?.title || '工作台'}</Breadcrumb.Item>
          <Breadcrumb.Item>
            <a href={`#${current}`}>{pages.find((page) => page.href === current)?.name || '项目'}</a>
          </Breadcrumb.Item>
          {path === '/import' && <Breadcrumb.Item>导入项目</Breadcrumb.Item>}
          {selected && <Breadcrumb.Item>{selected.name}</Breadcrumb.Item>}
        </Breadcrumb>
        <div className='header-tools'>
          <Button
            type='secondary'
            className='header-search'
            icon={<SearchIcon />}
            onClick={openSearch}
            aria-label='搜索项目与功能'
          >
            <span>搜索项目与功能</span>
            <kbd>⌘ K</kbd>
          </Button>
          <Tag className='runtime-indicator'>{runtimeName}</Tag>
          <Tooltip content={accountName}>
            <Avatar size={30}>{accountName[0]}</Avatar>
          </Tooltip>
          <span className='account-name'>{accountName}</span>
        </div>
      </header>
      <Layout className='body-layout'>
        <Layout.Sider
          className='sidebar'
          width={220}
          collapsedWidth={64}
          collapsed={collapsed}
          trigger={null}
          aria-label='工作台导航'
        >
          {navigation(collapsed)}
        </Layout.Sider>
        <Layout.Content className='main-shell'>
          <div
            id='main-content'
            className={`stage stage-${path === '/' ? 'dashboard' : path.split('/')[1] || 'dashboard'}`}
          >
            {children}
          </div>
          <footer className='app-footer'>
            OpenSumi CloudDev <span>项目 · 工作区 · 开发资源</span>
          </footer>
        </Layout.Content>
      </Layout>
      <Drawer
        visible={navOpen}
        title='OpenSumi 云开发'
        placement='left'
        width='min(280px, 90vw)'
        onCancel={() => setNavOpen(false)}
      >
        <div className='mobile-navigation'>{navigation()}</div>
      </Drawer>
      <Modal
        visible={search}
        title='搜索项目与功能'
        footer={null}
        width={600}
        afterOpen={() => searchInput.current?.focus()}
        onCancel={() => setSearch(false)}
      >
        <Input
          ref={searchInput}
          aria-label='快捷搜索'
          placeholder='输入项目名称或功能名称'
          prefix={<SearchIcon />}
          value={query}
          allowClear
          onChange={setQuery}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && results[0]) {
              open(results[0].href);
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              document.querySelector<HTMLElement>('.search-results [role="menuitem"]')?.focus();
            }
          }}
        />
        <div className='search-results'>
          {results.length ? (
            <Menu selectable={false} onClickMenuItem={open}>
              {results.map((result) => (
                <Menu.Item key={result.href}>
                  {result.icon}
                  <span>{result.name}</span>
                  <small>{result.type}</small>
                </Menu.Item>
              ))}
            </Menu>
          ) : (
            <p className='search-empty'>没有找到项目或功能</p>
          )}
        </div>
        <div className='search-help'>
          <span>↑ ↓ 选择 · Enter 打开</span>
          <span>Esc 关闭</span>
        </div>
      </Modal>
    </Layout>
  );
}
