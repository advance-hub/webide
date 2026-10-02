import { Button } from '@arco-design/web-react';
import { Suspense, lazy, useEffect, useRef, useState } from 'react';

import { type Project } from '../shared/contracts';

import { Callout, Empty } from './components/common';
import { Shell } from './components/shell';
import { WorkspaceDrawer } from './components/workspace';
import { useRoute } from './routing/use-route';
import { useWorkbench } from './state/use-workbench';
import { Connection } from './views/connection';
import { Projects } from './views/projects';

const ProjectDetail = lazy(() => import('./views/project-detail').then((m) => ({ default: m.ProjectDetail })));
const Workspaces = lazy(() => import('./views/workspaces').then((m) => ({ default: m.Workspaces })));
const Environment = lazy(() => import('./views/environment').then((m) => ({ default: m.Environment })));
const ImportProject = lazy(() => import('./views/import-project').then((m) => ({ default: m.ImportProject })));
const Dashboard = lazy(() => import('./views/dashboard').then((m) => ({ default: m.Dashboard })));
const Images = lazy(() => import('./views/images').then((m) => ({ default: m.Images })));
const DevelopmentResources = lazy(() =>
  import('./views/development-resources').then((m) => ({ default: m.DevelopmentResources })),
);
const SandboxAdmin = lazy(() => import('./views/sandbox-admin').then((m) => ({ default: m.SandboxAdmin })));

export function App() {
  const wb = useWorkbench();
  const router = useRoute();
  const path = router.route.pathname;
  const [preparing, setPreparing] = useState<Project>();
  const projectBack = useRef('/projects');
  if (path === '/projects') {
    projectBack.current = path + router.route.search;
  }
  const navigate = (to: string, replace?: boolean) => {
    wb.setError('');
    wb.setNotice('');
    router.navigate(to, replace);
  };
  useEffect(() => {
    wb.setError('');
  }, [path]);
  useEffect(() => {
    setPreparing(undefined);
    if (!wb.loading) {
      window.scrollTo(0, 0);
      document.querySelector<HTMLElement>('main h1')?.focus({ preventScroll: true });
    }
  }, [path, wb.loading]);
  return (
    <Shell wb={wb} route={router.route} navigate={navigate}>
      <div className='feedback' aria-live='polite'>
        {wb.error && (
          <div>
            <Callout
              tone='warning'
              title='操作未完成'
              action={
                <Button type='text' onClick={() => wb.setError('')}>
                  关闭
                </Button>
              }
            >
              {wb.error}
            </Callout>
          </div>
        )}
        {wb.notice && <Callout tone='success'>{wb.notice}</Callout>}
      </div>
      <div className='route-surface'>
        <Suspense
          fallback={
            <div className='loading-skeleton' role='status' aria-label='正在加载页面'>
              <span />
              <div />
            </div>
          }
        >
          {wb.loading ? (
            <div className='loading-skeleton' role='status' aria-label='正在读取工作台'>
              <span />
              <span />
              <div />
              <div />
            </div>
          ) : !wb.config ? (
            <Empty title='工作台暂时无法连接' action={<Button onClick={() => void wb.boot()}>重新连接</Button>}>
              请检查服务是否运行，项目数据不会被清除。
            </Empty>
          ) : !wb.user ? (
            <Connection wb={wb} navigate={navigate} />
          ) : path === '/' || path === '/dashboard' ? (
            <Dashboard wb={wb} navigate={navigate} onPrepare={setPreparing} />
          ) : path === '/images' ? (
            <Images wb={wb} />
          ) : path === '/development-resources' ? (
            <DevelopmentResources wb={wb} />
          ) : path === '/projects' ? (
            <Projects wb={wb} {...router} navigate={navigate} onPrepare={setPreparing} />
          ) : path.startsWith('/projects/') ? (
            <ProjectDetail
              project={wb.projects.find((p) => p.id === path.split('/')[2])}
              wb={wb}
              route={router.route}
              navigate={navigate}
              onPrepare={setPreparing}
              back={projectBack.current}
            />
          ) : path === '/workspaces' ? (
            <Workspaces wb={wb} {...router} navigate={navigate} />
          ) : path === '/environment' ? (
            <Environment wb={wb} navigate={navigate} />
          ) : path === '/sandbox-admin' ? (
            wb.config?.sandboxAdmin ? (
              <SandboxAdmin wb={wb} />
            ) : (
              <Empty title='沙箱管理未启用' action={<Button onClick={() => navigate('/projects')}>返回项目</Button>}>
                设置 OPEN_SANDBOX_URL 后，这里可以查看和管理平台沙箱。
              </Empty>
            )
          ) : path === '/connection' ? (
            <Connection wb={wb} navigate={navigate} />
          ) : path === '/import' ? (
            <ImportProject wb={wb} navigate={navigate} />
          ) : (
            <Empty title='页面不存在' action={<Button onClick={() => navigate('/projects')}>返回项目</Button>}>
              从左侧导航继续使用工作台。
            </Empty>
          )}
        </Suspense>
      </div>
      <WorkspaceDrawer
        project={preparing && wb.projects.find((p) => p.id === preparing.id)}
        wb={wb}
        onClose={() => setPreparing(undefined)}
        navigate={navigate}
      />
    </Shell>
  );
}
