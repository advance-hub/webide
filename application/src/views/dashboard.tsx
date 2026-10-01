import { Empty as ArcoEmpty, Button, Card, Progress, Statistic, Table, Tag } from '@arco-design/web-react';

import { Branch, PageHeader, ProjectMark, Status } from '../components/common';
import { type Project, type Workspace, date, projectHref, repository } from '../domain';
import {
  AddIcon,
  ArrowIcon,
  CloudIcon,
  CodeIcon,
  ProjectsIcon,
  SettingsIcon,
  StorageIcon,
  WorkspaceIcon,
} from '../icons';

import type { Navigation, Workbench } from '../use-workbench';

export function Dashboard({
  wb,
  navigate,
  onPrepare,
}: {
  wb: Workbench;
  navigate: Navigation;
  onPrepare: (project: Project) => void;
}) {
  const workspaces = wb.workspaces.filter((workspace) => !workspace.archived);
  const recent = [...workspaces].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 6);
  const ready = workspaces.filter((workspace) => workspace.status === 'ready').length;
  const attention = workspaces.filter(
    (workspace) => workspace.status === 'failed' || workspace.startup?.development.error,
  ).length;
  const projects = [...wb.projects].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 5);
  const target = wb.projects.length ? '/projects' : '/import';
  const stats = [
    { title: '已导入项目', value: wb.projects.length, icon: <ProjectsIcon />, href: '/projects' },
    { title: '个人工作区', value: workspaces.length, icon: <WorkspaceIcon />, href: '/workspaces' },
    { title: 'IDE 已就绪', value: ready, icon: <CodeIcon />, href: '/workspaces?status=ready' },
    { title: '需要处理', value: attention, icon: <CloudIcon />, href: '/workspaces?status=attention' },
  ];
  const workspaceName = (workspace: Workspace) =>
    workspace.projectName || wb.projects.find((project) => project.id === workspace.projectId)?.name || '项目不可用';
  const workspaceStatus = (workspace: Workspace) => (
    <Status state={workspace.status === 'ready' && workspace.startup?.development.error ? 'failed' : workspace.status}>
      {workspace.status === 'ready' && workspace.startup?.development.error ? '应用需处理' : undefined}
    </Status>
  );
  const workspaceAction = (workspace: Workspace) =>
    workspace.status === 'ready' ? (
      <Button
        type='text'
        size='small'
        disabled={!!wb.pending}
        loading={wb.pending === workspace.id}
        onClick={() => void wb.enter(workspace)}
      >
        进入 IDE <ArrowIcon />
      </Button>
    ) : (
      <Button type='text' size='small' onClick={() => navigate(projectHref(workspace.projectId, 'workspace'))}>
        查看状态
      </Button>
    );
  return (
    <div className='home-page'>
      <PageHeader
        title='开发总览'
        description='管理项目与开发环境，从上次的分支继续工作。'
        action={
          <Button type='primary' icon={<AddIcon />} onClick={() => navigate(target)}>
            {wb.projects.length ? '创建工作区' : '导入项目'}
          </Button>
        }
      />
      <section className='overview-metrics' aria-label='开发概况'>
        {stats.map((stat) => (
          <a key={stat.title} href={`#${stat.href}`} className='overview-metric'>
            <span className='metric-icon'>{stat.icon}</span>
            <Statistic title={stat.title} value={stat.value} />
            <ArrowIcon className='metric-arrow' />
          </a>
        ))}
      </section>
      <div className='home-layout'>
        <div className='home-main'>
          <Card
            className='home-workspaces'
            title='最近工作区'
            bordered={false}
            extra={
              <Button type='text' size='small' onClick={() => navigate('/workspaces')}>
                全部工作区 <ArrowIcon />
              </Button>
            }
          >
            <p className='section-description'>代码和未提交修改保留在个人开发机中。</p>
            <Table<Workspace>
              className={recent.length ? 'home-recent-table' : undefined}
              rowKey='id'
              border={false}
              tableLayoutFixed
              pagination={false}
              data={recent}
              scroll={{ x: 640 }}
              noDataElement={
                <ArcoEmpty
                  description={
                    <>
                      <p>{wb.projects.length ? '选择项目和分支，创建第一个工作区' : '导入仓库，开始云端开发'}</p>
                      <Button type='primary' onClick={() => navigate(target)}>
                        {wb.projects.length ? '选择项目' : '导入项目'}
                      </Button>
                    </>
                  }
                />
              }
              columns={[
                {
                  title: '项目 / 分支',
                  width: '44%',
                  render: (_, workspace) => {
                    const name = workspaceName(workspace);
                    return (
                      <div className='table-identity'>
                        <ProjectMark name={name} small />
                        <div>
                          <a href={`#${projectHref(workspace.projectId, 'workspace')}`} title={name}>
                            {name}
                          </a>
                          <span className='subtle'>
                            <Branch value={workspace.branch} />
                          </span>
                        </div>
                      </div>
                    );
                  },
                },
                {
                  title: '状态',
                  width: 132,
                  render: (_, workspace) => workspaceStatus(workspace),
                },
                {
                  title: '最近活动',
                  width: 130,
                  render: (_, workspace) => <span className='subtle'>{date(workspace.updatedAt)}</span>,
                },
                {
                  title: '操作',
                  width: 104,
                  align: 'right',
                  render: (_, workspace) => workspaceAction(workspace),
                },
              ]}
            />
            <div className='mobile-resource-list home-recent-list'>
              {recent.map((workspace) => (
                <article className='mobile-resource-row' key={workspace.id}>
                  <div className='mobile-resource-heading'>
                    <ProjectMark name={workspaceName(workspace)} small />
                    <div>
                      <a href={`#${projectHref(workspace.projectId, 'workspace')}`}>{workspaceName(workspace)}</a>
                    </div>
                    {workspaceStatus(workspace)}
                  </div>
                  <div className='mobile-resource-meta'>
                    <Branch value={workspace.branch} />
                  </div>
                  <div className='mobile-resource-actions'>
                    <span>{date(workspace.updatedAt)}</span>
                    {workspaceAction(workspace)}
                  </div>
                </article>
              ))}
            </div>
          </Card>
          <Card
            title='我的项目'
            bordered={false}
            extra={
              <Button type='text' size='small' onClick={() => navigate('/projects')}>
                项目管理 <ArrowIcon />
              </Button>
            }
          >
            <div className='home-project-list'>
              {projects.length ? (
                projects.map((project) => (
                  <div className='home-project-row' key={project.id}>
                    <ProjectMark name={project.name} small />
                    <div className='home-project-name'>
                      <a href={`#${projectHref(project.id)}`}>{project.name}</a>
                      <span>{repository(project.url)}</span>
                    </div>
                    <Branch value={project.branch} />
                    <Button size='small' disabled={project.status !== 'ready'} onClick={() => onPrepare(project)}>
                      选择分支
                    </Button>
                  </div>
                ))
              ) : (
                <ArcoEmpty description='暂无项目' />
              )}
            </div>
          </Card>
        </div>
        <aside className='home-side'>
          <Card
            title='我的开发机'
            bordered={false}
            extra={
              <Tag color={wb.machine?.machine ? 'green' : undefined}>{wb.machine?.machine ? '已分配' : '待创建'}</Tag>
            }
          >
            <div className='machine-overview'>
              <span className='machine-symbol'>
                <CloudIcon />
              </span>
              <div>
                <strong>{wb.config?.driver === 'local' ? '本地开发环境' : '持久开发沙箱'}</strong>
                <p>
                  默认规格：{wb.catalog?.environment.cpu || '—'} CPU · {wb.catalog?.environment.memory || '—'} 内存
                </p>
              </div>
            </div>
            <p className='section-description'>多个项目共享开发工具、个人配置和依赖缓存。</p>
            {wb.machine && (
              <div className='machine-capacity'>
                <div>
                  <span>平台开发机名额</span>
                  <span>
                    {wb.machine.allocated} / {wb.machine.limit}
                  </span>
                </div>
                <Progress
                  percent={wb.machine.limit ? Math.round((wb.machine.allocated / wb.machine.limit) * 100) : 0}
                  showText={false}
                />
              </div>
            )}
            <Button long onClick={() => navigate('/workspaces')}>
              管理开发机
            </Button>
          </Card>
          <Card title='快捷入口' bordered={false}>
            <div className='home-shortcuts'>
              {[
                { name: '导入项目', description: '连接 Git 仓库', icon: <ProjectsIcon />, href: '/import' },
                {
                  name: '开发资源',
                  description: '数据库、Redis 与对象存储',
                  icon: <StorageIcon />,
                  href: '/development-resources',
                },
                { name: '开发环境', description: '镜像、运行方式与配置', icon: <SettingsIcon />, href: '/environment' },
              ].map((item) => (
                <a key={item.href} href={`#${item.href}`}>
                  <span>{item.icon}</span>
                  <div>
                    <strong>{item.name}</strong>
                    <small>{item.description}</small>
                  </div>
                  <ArrowIcon />
                </a>
              ))}
            </div>
          </Card>
          <div className='workflow-note'>
            <h2>开始一次开发</h2>
            <ol>
              <li>导入仓库，选择开发分支</li>
              <li>创建工作区，进入云端 IDE</li>
              <li>开发验证，推送并创建 MR</li>
            </ol>
          </div>
        </aside>
      </div>
    </div>
  );
}
