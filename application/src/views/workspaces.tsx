import { Button, Input, Tabs } from '@arco-design/web-react';

import { Branch, Empty, PageHeader, ProjectMark, Status } from '../components/common';
import { EnvironmentPanel } from '../components/environment';
import { PersonalMachine } from '../components/personal-machine';
import { VirtualTable } from '../components/virtual-collection';
import { type Project, type Workspace, date, driverLabels, projectHref } from '../domain';
import { AddIcon, CodeIcon, RefreshIcon } from '../icons';

import type { Navigation, Workbench } from '../use-workbench';

export function Workspaces({
  wb,
  route,
  filter,
  navigate,
}: {
  wb: Workbench;
  route: URL;
  filter: (key: string, value: string) => void;
  navigate: Navigation;
}) {
  const projectById = new Map(wb.projects.map((p) => [p.id, p]));
  const scope = route.searchParams.get('status') || 'all';
  const query = route.searchParams.get('q') || '';
  const items = wb.workspaces.filter(
    (w) =>
      (scope === 'all' ||
        (scope === 'attention' ? w.status === 'failed' || !!w.startup?.development.error : w.status === scope)) &&
      `${w.projectName || projectById.get(w.projectId)?.name || ''} ${w.branch} ${w.ownerName || ''}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <>
      <PageHeader
        title='工作区'
        description='每人一台持久开发机，项目与分支使用独立工作目录，共享依赖缓存。'
        action={
          <Button type='primary' icon={<AddIcon />} onClick={() => navigate('/projects')}>
            从项目创建
          </Button>
        }
      />
      <PersonalMachine wb={wb} />
      <Tabs
        className='collection-tabs'

        aria-label='工作区状态'
        activeTab={scope}
        onChange={(key) => filter('status', String(key))}
      >
        <Tabs.TabPane key='all' title={`全部工作区 ${wb.workspaces.length}`} />
        <Tabs.TabPane key='ready' title='IDE 可用' />
        <Tabs.TabPane key='attention' title='需要处理' />
        <Tabs.TabPane key='stopped' title='已停止' />
      </Tabs>
      <div className='collection-toolbar'>
        <Input.Search
          className='resource-search'
          aria-label='搜索工作区'
          placeholder='搜索所属项目'
          value={query}
          onChange={(e) => filter('q', e)}
          allowClear
        />
        <Button
          type='text'
          aria-label='刷新工作区'
          icon={<RefreshIcon />}
          loading={wb.pending === 'refresh'}
          disabled={!!wb.pending}
          onClick={() => void wb.act('refresh', wb.refresh)}
        />
      </div>
      {items.length ? (
        <>
          <VirtualTable<Workspace>
            resetKey={`${scope}:${query}`}
            data={items}
            rowKey='id'
            pagination={false}
            scroll={{ x: 720 }}
            columns={[
              {
                title: '项目 / 分支',
                key: 'name',
                width: '36%',
                render: (_, w) => {
                  const p = projectById.get(w.projectId);
                  const name = p?.name || w.projectName || '项目不可用';
                  return (
                    <div className='table-identity'>
                      <ProjectMark name={name} small />
                      <div>
                        <a href={`#${projectHref(w.projectId, 'workspace')}`}>{name}</a>
                        <span className='subtle workspace-row-branch'>
                          <Branch value={w.branch || '—'} />
                          {w.ownerName ? ` · ${w.ownerName} 共享` : ''}
                        </span>
                      </div>
                    </div>
                  );
                },
              },
              {
                title: '状态',
                key: 'status',
                width: '20%',
                render: (_, w) => (
                  <Status state={w.status === 'ready' && w.startup?.development.error ? 'failed' : w.status}>
                    {w.status === 'ready'
                      ? w.startup?.development.error
                        ? '项目启动需处理'
                        : w.startup?.development.ready
                          ? '应用可预览'
                          : 'IDE 已就绪'
                      : undefined}
                  </Status>
                ),
              },
              {
                title: '最近活动',
                key: 'updated',
                width: '16%',
                render: (_, w) => (
                  <span className='workspace-row-activity'>
                    <span>{date(w.updatedAt)}</span>
                    <span>{driverLabels[w.driver || wb.config?.driver || 'sandbox']}</span>
                  </span>
                ),
              },
              {
                title: '操作',
                key: 'actions',
                width: 240,
                render: (_, w) => (
                  <div className='actions'>
                    {w.status === 'ready' ? (
                      <Button
                        type='text'
                        size='small'
                        icon={<CodeIcon />}
                        disabled={!!wb.pending}
                        onClick={() => void wb.enter(w)}
                      >
                        进入 IDE
                      </Button>
                    ) : null}
                    <EnvironmentPanel workspace={w} wb={wb} compact />
                    {projectById.get(w.projectId) && (
                      <Button type='text' size='small' href={`#${projectHref(w.projectId, 'workspace')}`}>
                        详情
                      </Button>
                    )}
                  </div>
                ),
              },
            ]}
          />
          <div className='mobile-resource-list workspace-mobile-list'>
            {items.map((w) => {
              const name = projectById.get(w.projectId)?.name || w.projectName || '项目不可用';
              return (
                <article className='mobile-resource-row' key={w.id}>
                  <div className='mobile-resource-heading'>
                    <ProjectMark name={name} small />
                    <div>
                      <a href={`#${projectHref(w.projectId, 'workspace')}`}>{name}</a>
                      <span className='subtle'>
                        <Branch value={w.branch || '—'} />
                      </span>
                    </div>
                  </div>
                  <div className='mobile-resource-meta'>
                    <Status state={w.status} />
                    <span>
                      {date(w.updatedAt)} · {driverLabels[w.driver || wb.config?.driver || 'sandbox']}
                    </span>
                  </div>
                  <div className='mobile-resource-actions'>
                    {w.status === 'ready' && (
                      <Button
                        type='text'
                        size='small'
                        icon={<CodeIcon />}
                        disabled={!!wb.pending}
                        onClick={() => void wb.enter(w)}
                      >
                        进入 IDE
                      </Button>
                    )}
                    <EnvironmentPanel workspace={w} wb={wb} compact />
                    <Button type='text' size='small' href={`#${projectHref(w.projectId, 'workspace')}`}>
                      详情
                    </Button>
                  </div>
                </article>
              );
            })}
          </div>
        </>
      ) : (
        <Empty
          title={wb.workspaces.length ? '没有匹配的工作区' : '还没有个人工作区'}
          action={
            <Button onClick={() => navigate(wb.workspaces.length ? '/workspaces' : '/projects')}>
              {wb.workspaces.length ? '清除筛选' : '选择项目'}
            </Button>
          }
        >
          {wb.workspaces.length ? '调整筛选条件后再试。' : '选择已导入的项目，在个人开发机中创建工作区。'}
        </Empty>
      )}
      <div className='collection-summary'>共 {items.length} 个工作区</div>
    </>
  );
}
