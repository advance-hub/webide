import { Button, Input, Select, Tabs } from '@arco-design/web-react';
import { useEffect, useState } from 'react';

import { type Project, driverLabels, request } from '../domain';
import { CloudIcon, CodeIcon, LockIcon } from '../icons';

import { Branch, Callout, Definition, ProjectMark, Status } from './common';
import { Drawer } from './overlays';

import type { Navigation, Workbench } from '../use-workbench';

// Each branch gets a separate directory and IDE on the personal development
// machine. Existing workspaces of the project are listed so a
// second visit opens another branch instead of overwriting the first.
export function WorkspaceDrawer({
  project,
  wb,
  onClose,
  navigate,
}: {
  project?: Project;
  wb: Workbench;
  onClose: () => void;
  navigate: Navigation;
}) {
  const existing = wb.workspaces.filter((w) => w.projectId === project?.id && !w.archived);
  const [branch, setBranch] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [mode, setMode] = useState<'existing' | 'new'>('existing');
  const [branches, setBranches] = useState<string[]>([]);
  const [branchesTruncated, setBranchesTruncated] = useState(false);
  const [manualBranch, setManualBranch] = useState(false);
  const [branchError, setBranchError] = useState('');
  const [formError, setFormError] = useState('');
  useEffect(() => {
    setBranch('');
    setBaseBranch('');
    setMode('existing');
    setFormError('');
    setBranchError('');
    setBranches([]);
    setBranchesTruncated(false);
    setManualBranch(false);
    if (!project || project.status !== 'ready') {
      return;
    }
    let alive = true;
    void request<{ branches: string[]; truncated: boolean }>(`/projects/${project.id}/branches`)
      .then((result) => {
        if (alive) {
          setBranches(result.branches);
          setBranchesTruncated(result.truncated);
        }
      })
      .catch((e: Error) => {
        if (alive) {
          setBranchError(e.message);
        }
      });
    return () => {
      alive = false;
    };
  }, [project?.id, project?.status]);
  const sandbox = wb.catalog?.environment.driver !== 'local';
  const blockedByImage = sandbox && !wb.catalog?.environment.imageConfigured;
  const create = () => {
    if (!project) {
      return;
    }
    const selectedBranch = branch.trim() || project.branch;
    if (mode === 'new' && (!branch.trim() || branch.trim() === (baseBranch.trim() || project.branch))) {
      setFormError('请输入与起点分支不同的新开发分支名');
      return;
    }
    setFormError('');
    void wb.act('prepare', async () => {
      const payload: { projectId: string; branch: string; baseBranch?: string } = {
        projectId: project.id,
        branch: selectedBranch,
      };
      if (mode === 'new') {
        payload.baseBranch = baseBranch.trim() || project.branch;
      }
      await request('/workspaces', payload);
      await wb.refresh();
      onClose();
    });
  };
  return (
    <Drawer
      visible={!!project}
      title={existing.length ? '项目工作区' : '创建个人工作区'}

      width='min(560px, 100vw)'
      focusLock

      escToExit
      closable

      onCancel={onClose}
      unmountOnExit
      footer={
        <div className='drawer-actions'>
          <Button onClick={onClose}>返回</Button>
          {project?.status === 'ready' && !blockedByImage && (
            <Button
              type='primary'
              icon={<CodeIcon />}
              loading={wb.pending === 'prepare'}
              disabled={!!wb.pending}
              onClick={create}
            >
              创建并启动
            </Button>
          )}
        </div>
      }
    >
      <p className='overlay-description'>{'选择分支，在个人开发机中创建工作目录'}</p>
      {project && (
        <>
          <div className='drawer-project'>
            <ProjectMark name={project.name} />
            <div>
              <h2>{project.name}</h2>
              <Branch value={project.branch} />
            </div>
            <Status state={project.status}>{project.status === 'ready' ? '基线已就绪' : undefined}</Status>
          </div>
          {(wb.error || formError) && (
            <div className='inline-error' role='alert'>
              {formError || wb.error}
            </div>
          )}
          {blockedByImage && (
            <Callout
              title='先完成开发镜像配置'
              tone='warning'
              action={
                <Button
                  size='small'
                  onClick={() => {
                    onClose();
                    navigate('/environment');
                  }}
                >
                  查看环境配置
                </Button>
              }
            >
              当前使用 OpenSandbox 沙箱驱动，需要先配置开发镜像。
            </Callout>
          )}
          {existing.length ? (
            <>
              <div className='section-heading'>
                <h3>已有工作区</h3>
                <span className='subtle'>点击进入对应分支的 IDE</span>
              </div>
              <div className='drawer-workspaces'>
                {existing.map((w) => (
                  <div className='drawer-workspace-row' key={w.id}>
                    <Branch value={w.branch} />
                    <span className='subtle'>{(w.sha || '').slice(0, 8) || '基线待固定'}</span>
                    <Status state={w.status} />
                    {w.status === 'ready' && (
                      <Button size='small' icon={<CodeIcon />} disabled={!!wb.pending} onClick={() => void wb.enter(w)}>
                        进入
                      </Button>
                    )}
                  </div>
                ))}
              </div>
              <div className='section-heading'>
                <h3>在其他分支上新建</h3>
              </div>
            </>
          ) : null}
          {project.status === 'ready' && (
            <>
              <Tabs
                activeTab={mode}
                onChange={(key) => {
                  setMode(key as 'existing' | 'new');
                  setBranch('');
                  setManualBranch(false);
                  setFormError('');
                }}
                aria-label='工作区分支类型'
              >
                <Tabs.TabPane key='existing' title='从已有分支开发' />
                <Tabs.TabPane key='new' title='从起点创建新分支' />
              </Tabs>
              {mode === 'new' && (
                <>
                  <label className='field-label' htmlFor='workspace-base-branch'>
                    起点分支
                  </label>
                  {branches.length ? (
                    <Select
                      id='workspace-base-branch'
                      aria-label='起点分支'
                      value={baseBranch || project.branch}
                      options={[...new Set([project.branch, ...branches])].map((value) => ({ value, label: value }))}
                      onChange={(value) => setBaseBranch(String(value))}
                    />
                  ) : (
                    <Input
                      id='workspace-base-branch'
                      value={baseBranch}
                      placeholder={project.branch}
                      onChange={(e) => setBaseBranch(e)}
                    />
                  )}
                </>
              )}
              <label className='field-label' htmlFor='workspace-branch'>
                {mode === 'new' ? '新开发分支' : '远端分支'}
              </label>
              {mode === 'existing' && branches.length && !manualBranch ? (
                <Select
                  id='workspace-branch'
                  aria-label='远端分支'
                  value={branch || project.branch}
                  options={[...new Set([project.branch, ...branches])].map((value) => ({ value, label: value }))}
                  onChange={(value) => setBranch(String(value))}
                />
              ) : (
                <Input
                  id='workspace-branch'
                  placeholder={mode === 'existing' ? project.branch : 'feature/my-change'}
                  value={branch}
                  onChange={(e) => setBranch(e)}
                  onPressEnter={create}
                />
              )}
              {mode === 'existing' && branches.length > 0 && (
                <Button
                  type='text'
                  size='small'
                  onClick={() => {
                    if (manualBranch) {setBranch('');}
                    setManualBranch((value) => !value);
                  }}
                >
                  {manualBranch ? '从列表选择' : '手动输入分支'}
                </Button>
              )}
              {mode === 'existing' && branchesTruncated && (
                <p className='muted'>分支较多，列表仅显示前 200 个；其余分支可手动输入。</p>
              )}
              {branchError && (
                <p className='muted' role='status'>
                  远端分支列表暂不可用，可手动输入：{branchError}
                </p>
              )}
              <p className='muted'>
                {mode === 'new'
                  ? `创建时拉取 ${baseBranch.trim() || project.branch} 的最新提交，在独立工作区建立新分支；提交后可推送并创建 MR。`
                  : `创建时拉取 ${branch.trim() || project.branch} 的远端最新提交。同一分支已有工作区时直接打开原工作区。`}
              </p>
              <div className='runtime-spec'>
                <CloudIcon />
                <div>
                  <strong>默认开发环境</strong>
                  <p>
                    {wb.catalog
                      ? wb.catalog.environment.driver === 'local'
                        ? '本地直连 · 与服务同机运行'
                        : `${driverLabels[wb.catalog.environment.driver]} · ${wb.catalog.environment.cpu} CPU · ${wb.catalog.environment.memory} 内存`
                      : '等待环境配置'}
                  </p>
                </div>
              </div>
              <div className='isolation-note'>
                <LockIcon />
                <span>文件、终端与 Git 状态属于这个工作区；首次启动初始化代码，再次进入保留修改。</span>
              </div>
            </>
          )}
        </>
      )}
    </Drawer>
  );
}
