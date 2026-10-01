import { Button, Input } from '@arco-design/web-react';

import { Branch, Empty, PageHeader, ProjectMark, Status } from '../components/common';
import { VirtualTable } from '../components/virtual-collection';
import { type Project, type Workspace, date, projectHref, repository } from '../domain';
import { AddIcon, CodeIcon, RefreshIcon } from '../icons';

import type { Navigation, Workbench } from '../use-workbench';

export function Projects({
  wb,
  route,
  filter,
  navigate,
  onPrepare,
}: {
  wb: Workbench;
  route: URL;
  filter: (key: string, value: string) => void;
  navigate: Navigation;
  onPrepare: (project: Project) => void;
}) {
  const query = route.searchParams.get('q') || '';
  const projects = wb.projects
    .filter((p) => `${p.name} ${p.url} ${p.branch}`.toLowerCase().includes(query.toLowerCase()))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const workspaceByProject = new Map<string, Workspace>();
  for (const workspace of wb.workspaces) {
    if (workspace.archived) {
      continue;
    }
    const current = workspaceByProject.get(workspace.projectId);
    if (
      !current ||
      (current.status !== 'ready' && workspace.status === 'ready') ||
      (current.status === workspace.status && workspace.updatedAt > current.updatedAt)
    ) {
      workspaceByProject.set(workspace.projectId, workspace);
    }
  }
  const action = (project: Project) => {
    const workspace = workspaceByProject.get(project.id);
    return (
      <div className='project-row-actions'>
        {workspace?.status === 'ready' && (
          <Button
            type='text'
            size='small'
            icon={<CodeIcon />}
            disabled={!!wb.pending}
            onClick={() => void wb.enter(workspace)}
          >
            进入 IDE
          </Button>
        )}
        <Button size='small' disabled={project.status !== 'ready'} onClick={() => onPrepare(project)}>
          选择分支
        </Button>
      </div>
    );
  };

  return (
    <>
      <PageHeader
        title='项目管理'
        description='选择仓库和分支创建工作区；已有工作区可直接进入 IDE。'
        action={
          <Button type='primary' icon={<AddIcon />} onClick={() => navigate('/import')}>
            导入项目
          </Button>
        }
      />
      <div className='collection-toolbar project-toolbar'>
        <div className='project-search'>
          <Input.Search
            aria-label='搜索项目'
            placeholder='搜索项目名称、仓库或分支'
            value={query}
            onChange={(event) => filter('q', event)}
            allowClear
          />
        </div>
        <Button
          type='text'
          aria-label='刷新项目'
          icon={<RefreshIcon />}
          loading={wb.pending === 'refresh'}
          disabled={!!wb.pending}
          onClick={() => void wb.act('refresh', wb.refresh)}
        />
      </div>
      {projects.length ? (
        <>
          <VirtualTable<Project>
            resetKey={query}
            className='resource-table'
            data={projects}
            rowKey='id'
            pagination={false}
            scroll={{ x: 720 }}
            columns={[
              {
                title: '项目',
                key: 'name',
                width: '40%',
                render: (_, project) => (
                  <div className='table-identity'>
                    <ProjectMark name={project.name} small />
                    <div>
                      <a href={`#${projectHref(project.id)}`}>{project.name}</a>
                      <span className='subtle'>
                        {repository(project.url)} · {date(project.createdAt)} 导入
                      </span>
                    </div>
                  </div>
                ),
              },
              {
                title: '仓库基线',
                key: 'baseline',
                width: '22%',
                render: (_, project) => (
                  <div className='workspace-baseline'>
                    <Branch value={project.branch} />
                    <Status state={project.status} />
                  </div>
                ),
              },
              {
                title: '工作区',
                key: 'workspace',
                width: '16%',
                render: (_, project) => <Status state={workspaceByProject.get(project.id)?.status} />,
              },
              { title: '操作', key: 'actions', width: 230, render: (_, project) => action(project) },
            ]}
          />
          <div className='mobile-resource-list project-mobile-list'>
            {projects.map((project) => (
              <article className='mobile-resource-row' key={project.id}>
                <div className='mobile-resource-heading'>
                  <ProjectMark name={project.name} small />
                  <div>
                    <a href={`#${projectHref(project.id)}`}>{project.name}</a>
                    <span className='subtle'>{repository(project.url)}</span>
                  </div>
                  <Status state={project.status} />
                </div>
                <div className='mobile-resource-meta'>
                  <Branch value={project.branch} />
                  <span>{date(project.createdAt)} 导入</span>
                </div>
                <div className='mobile-resource-actions'>{action(project)}</div>
              </article>
            ))}
          </div>
        </>
      ) : (
        <Empty
          title={wb.projects.length ? '没有找到匹配的项目' : '添加你的第一个项目'}
          action={
            <Button
              type={wb.projects.length ? 'default' : 'primary'}
              onClick={() => (wb.projects.length ? filter('q', '') : navigate('/import'))}
            >
              {wb.projects.length ? '清除搜索' : '导入项目'}
            </Button>
          }
        >
          {wb.projects.length ? '试试其他关键词。' : '导入仓库，再选择分支创建工作区。'}
        </Empty>
      )}
      <div className='collection-summary'>共 {projects.length} 个项目</div>
    </>
  );
}
