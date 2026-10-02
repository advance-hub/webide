import { Button, Tabs } from '@arco-design/web-react';
import { useEffect, useRef } from 'react';

import { type Project } from '../../shared/contracts';
import { request } from '../api/client';
import { BaselineActions } from '../components/baseline';
import { Branch, Callout, Definition, Empty, ProjectMark, Status } from '../components/common';
import { EnvironmentPanel } from '../components/environment';
import { ArrowIcon, BackIcon, CopyIcon } from '../components/icons';
import { date, projectHref, repository } from '../domain/presentation';

import { GitConnectionForm } from './connection';
import { Repository } from './repository';

import type { Navigation } from '../routing/use-route';
import type { Workbench } from '../state/use-workbench';

export function ProjectDetail({
  project,
  wb,
  route,
  navigate,
  onPrepare,
  back,
}: {
  project?: Project;
  wb: Workbench;
  route: URL;
  navigate: Navigation;
  onPrepare: (p: Project) => void;
  back: string;
}) {
  const heading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, [project?.id]);
  if (!project) {
    return (
      <Empty title='项目不存在或无权访问' action={<Button onClick={() => navigate('/projects')}>返回项目</Button>}>
        检查当前账号，或从项目列表重新进入。
      </Empty>
    );
  }
  const p = project;
  const mine = wb.workspaces.filter((w) => w.projectId === p.id);
  const rawTab = route.searchParams.get('tab') || 'workspace';
  const tab =
    rawTab === 'activity' ? 'info' : ['workspace', 'code', 'commits', 'info'].includes(rawTab) ? rawTab : 'workspace';
  return (
    <>
      <Button
        className='back-link'
        type='text'
        icon={<BackIcon />}
        aria-label='返回全部项目'
        onClick={() => navigate(back)}
      >
        全部项目
      </Button>
      <header className='project-detail-heading'>
        <ProjectMark name={p.name} />
        <div className='detail-identity'>
          <div className='title-with-status'>
            <h1 ref={heading} tabIndex={-1}>
              {p.name}
            </h1>
            <Status state={p.status}>{p.status === 'ready' ? '基线就绪' : undefined}</Status>
          </div>
          <p>{repository(p.url)}</p>
        </div>
        <div className='project-detail-actions'>
          {p.status === 'ready' ? (
            <Button type={mine.length ? 'default' : 'primary'} onClick={() => onPrepare(p)}>
              {mine.length ? '选择其他分支' : '创建工作区'}
            </Button>
          ) : (
            <Button disabled>等待仓库导入</Button>
          )}
        </div>
      </header>
      <Tabs
        activeTab={tab}
        onChange={(key) => navigate(projectHref(p.id, String(key)))}
        className='detail-tabs'
        aria-label='项目详情'
      >
        <Tabs.TabPane key='workspace' title={`工作区 ${mine.length || ''}`} />
        <Tabs.TabPane key='code' title='代码基线' />
        <Tabs.TabPane key='commits' title='提交记录' />
        <Tabs.TabPane key='info' title='项目资料' />
      </Tabs>
      {p.error && (
        <Callout
          title='项目导入未完成'
          tone='warning'
          action={
            <Button
              loading={wb.pending === p.id}
              disabled={!!wb.pending}
              onClick={() =>
                void wb.act(p.id, async () => {
                  await request(`/projects/${p.id}/retry`, {});
                  await wb.refresh();
                })
              }
            >
              重新拉取
            </Button>
          }
        >
          {p.error}
        </Callout>
      )}
      {p.baselineError && (
        <Callout tone='warning' title='基线变更未完成，原基线已保留'>
          {p.baselineError}
        </Callout>
      )}
      {tab === 'code' || tab === 'commits' ? (
        <Repository project={p} wb={wb} route={route} navigate={navigate} commits={tab === 'commits'} />
      ) : tab === 'workspace' ? (
        <div className='workspace-list'>
          {mine.length ? (
            <>
              {mine.map((w) => (
                <EnvironmentPanel workspace={w} wb={wb} key={w.id} />
              ))}
            </>
          ) : (
            <Empty
              title='还没有工作区'
              action={
                <Button type='primary' onClick={() => onPrepare(p)}>
                  从基线分支创建
                </Button>
              }
            >
              每个分支使用独立工作目录；同一账号的项目与分支复用一台个人开发机。
            </Empty>
          )}
        </div>
      ) : (
        <div className='settings-body'>
          <div className='section-heading'>
            <h2>仓库信息</h2>
            <Button type='text' href={p.url.replace(/\.git$/, '')} target='_blank' rel='noopener noreferrer'>
              打开远端仓库
              {<ArrowIcon />}
            </Button>
          </div>
          <Definition
            entries={[
              [
                '仓库地址',
                <div className='copy-field'>
                  <span className='break-text'>{p.url}</span>
                  <Button
                    type='text'
                    icon={<CopyIcon />}
                    aria-label='复制仓库地址'
                    onClick={() =>
                      void wb.act('copy', async () => {
                        await navigator.clipboard.writeText(p.url);
                        wb.setNotice('仓库地址已复制');
                      })
                    }
                  />
                </div>,
              ],
              ['基线分支', <Branch value={p.branch} />],
              ['基线提交', <code className='break-text'>{p.sha || '等待拉取'}</code>],
              ['导入时间', date(p.createdAt)],
              ['归属账号', wb.user?.name || '当前账号'],
              ['项目标识', <code className='break-text'>{p.id}</code>],
            ]}
          />
          <div className='settings-section'>
            <h2>基线与开发内容</h2>
            <p>代码基线可更新或重置；已有工作区保留创建时固定的分支和提交，互不影响。</p>
            <BaselineActions project={p} wb={wb} />
          </div>
          <div className='settings-section'>
            <GitConnectionForm wb={wb} project={p} />
          </div>
        </div>
      )}
    </>
  );
}
