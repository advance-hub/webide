import { Button, Input, Select, Tabs } from '@arco-design/web-react';
import { useState } from 'react';

import { type Workspace } from '../../shared/contracts';
import { request } from '../api/client';

import { Callout } from './common';
import { Drawer } from './overlays';

import type { Workbench } from '../state/use-workbench';

interface GitState {
  branch: string;
  sha: string;
  dirty: boolean;
  files: string[];
  conflicts: string[];
  branches: string[];
  operation?: string;
  success?: boolean;
  message?: string;
}
interface Service {
  name: string;
  ready: boolean;
  running: boolean;
  port: number;
  error?: string;
}
interface Services {
  services: Service[];
  text: string;
  revision: string;
}
export function WorkspaceTools({ workspace: ws, wb }: { workspace: Workspace; wb: Workbench }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('git');
  const [error, setError] = useState('');
  const [pending, setPending] = useState('');
  const [git, setGit] = useState<GitState>();
  const [branch, setBranch] = useState(ws.baseBranch || ws.branch);
  const [services, setServices] = useState<Services>();
  const [config, setConfig] = useState('');
  const [log, setLog] = useState('');
  const [logName, setLogName] = useState('');
  const run = async (key: string, fn: () => Promise<void>) => {
    if (pending) {
      return;
    }
    setPending(key);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending('');
    }
  };
  const gitAction = (action: string) =>
    run(action, async () => {
      const result = await request<GitState>(`/workspaces/${ws.id}/git`, { action, branch });
      setGit(result);
    });
  const serviceAction = (action: string, name?: string) =>
    run(action, async () => {
      if (action === 'log') {
        const result = await request<{ text: string }>(`/workspaces/${ws.id}/services`, { action, name });
        setLog(result.text);
        setLogName(name || '');
        return;
      }
      const result = await request<Services>(`/workspaces/${ws.id}/services`, {
        action,
        name,
        text: config,
        revision: services?.revision,
      });
      setServices(result);
      if (action === 'status' || action === 'save') {
        setConfig(result.text);
      }
      await wb.refresh();
    });
  const selectTab = (value: string) => {
    setTab(value);
    setError('');
    void (value === 'git' ? gitAction('status') : serviceAction('status'));
  };
  const disabled = !!pending || !!wb.pending;
  return (
    <>
      <Button
        size='small'
        disabled={ws.status !== 'ready' || !!ws.ownerName}
        onClick={() => {
          setOpen(true);
          selectTab(tab);
        }}
      >
        工作区工具
      </Button>
      <Drawer
        visible={open}
        title='工作区工具'

        width='min(800px, 100vw)'
        onCancel={() => setOpen(false)}
        focusLock

        escToExit
        closable

        footer={<Button onClick={() => setOpen(false)}>关闭</Button>}
      >
        <p className='overlay-description'>{ws.branch}</p>
        <Tabs aria-label='工作区工具分类' activeTab={tab} onChange={selectTab}>
          <Tabs.TabPane key='git' title='代码同步' disabled={disabled} />
          <Tabs.TabPane key='services' title='运行任务' disabled={disabled} />
        </Tabs>
        <div className='maven-panel tools-panel' aria-busy={!!pending}>
          {error && (
            <Callout tone='warning' title='操作未完成'>
              {error}
            </Callout>
          )}
          {tab === 'git' ? (
            <>
              <section>
                <h2>当前分支</h2>
                <p>
                  {git?.branch || ws.branch} · {(git?.sha || ws.sha || '').slice(0, 8)} ·{' '}
                  {git?.dirty ? '有未提交修改' : '工作目录干净'}
                </p>
                <p className='subtle'>IDE 和终端共用仓库授权，可直接 fetch / pull / push。合并前请先提交修改。</p>
                <div className='tool-actions'>
                  <Button disabled={disabled} loading={pending === 'fetch'} onClick={() => void gitAction('fetch')}>
                    刷新远端
                  </Button>
                  <Button disabled={disabled} onClick={() => void gitAction('status')}>
                    刷新状态
                  </Button>
                </div>
              </section>
              <section>
                <h2>同步远端分支</h2>
                <label className='field-label' htmlFor={`git-branch-${ws.id}`}>
                  来源分支
                </label>
                <Select
                  id={`git-branch-${ws.id}`}
                  style={{ width: '100%' }}
                  value={branch}
                  options={[
                    ...new Set([
                      branch,
                      ...(git?.branches || [])
                        .filter((v) => v !== 'origin/HEAD')
                        .map((v) => v.replace(/^origin\//, '')),
                    ]),
                  ].map((value) => ({ value, label: value }))}
                  onChange={(v) => setBranch(String(v))}
                />
                <div className='tool-actions'>
                  {[
                    ['pull', '快进更新'],
                    ['merge', '合并到当前分支'],
                    ['rebase', '变基到来源分支'],
                  ].map(([action, label]) => (
                    <Button
                      key={action}
                      disabled={disabled || git?.dirty || !!git?.operation}
                      loading={pending === action}
                      onClick={() => void gitAction(action)}
                    >
                      {label}
                    </Button>
                  ))}
                </div>
                {git?.message && <p role='status'>{git.message}</p>}
              </section>
              {(git?.operation || !!git?.conflicts.length) && (
                <section>
                  <h2>处理{git?.operation === 'rebase' ? '变基' : '合并'}</h2>
                  <p>在 IDE 中解决冲突并暂存文件，然后继续；中止会回到本次操作前的状态。</p>
                  <pre className='tool-log'>{git?.conflicts.join('\n') || '冲突已解决，可继续提交'}</pre>
                  <div className='tool-actions'>
                    <Button disabled={disabled} onClick={() => void gitAction('continue')}>
                      继续
                    </Button>
                    <Button disabled={disabled} onClick={() => void gitAction('abort')}>
                      中止本次操作
                    </Button>
                  </div>
                </section>
              )}
              {!!git?.files.length && (
                <section>
                  <h2>文件状态</h2>
                  <pre className='tool-log'>{git.files.join('\n')}</pre>
                </section>
              )}
            </>
          ) : (
            <>
              <section>
                <div className='tool-heading'>
                  <h2>服务进程</h2>
                  <Button
                    disabled={disabled}
                    loading={pending === 'status'}
                    onClick={() => void serviceAction('status')}
                  >
                    刷新状态
                  </Button>
                </div>
                {services?.services.length ? (
                  services.services.map((s) => (
                    <div className='service-row' key={s.name}>
                      <div>
                        <strong>{s.name}</strong>
                        <p>
                          {s.ready ? '可预览' : s.running ? '进程运行中' : '已停止'} · 端口 {s.port}
                          {s.error && ` · ${s.error}`}
                        </p>
                      </div>
                      <div className='tool-actions'>
                        <Button
                          size='small'
                          disabled={disabled}
                          onClick={() => void serviceAction(s.running ? 'restart' : 'start', s.name)}
                        >
                          {s.running ? '重启' : '启动'}
                        </Button>
                        {s.running && (
                          <Button size='small' disabled={disabled} onClick={() => void serviceAction('stop', s.name)}>
                            停止
                          </Button>
                        )}
                        <Button size='small' disabled={disabled} onClick={() => void serviceAction('log', s.name)}>
                          日志
                        </Button>
                        <Button
                          size='small'
                          disabled={disabled || !s.ready}
                          onClick={() => void wb.enter(ws, 'preview', s.port)}
                        >
                          预览
                        </Button>
                      </div>
                    </div>
                  ))
                ) : (
                  <p className='subtle'>配置服务后，可分别启动、停止并预览。最多 8 个服务。</p>
                )}
              </section>
              {logName && (
                <section>
                  <h2>{logName} · 日志</h2>
                  <pre className='tool-log' tabIndex={0}>
                    {log || '暂无日志'}
                  </pre>
                </section>
              )}
              <section>
                <h2>项目启动配置</h2>
                <p className='subtle'>
                  保存到项目 .opensumi/development.json，可随代码提交。修改前请停止当前所有服务，程序通过 PORT
                  环境变量读取分配端口。
                </p>
                <Input.TextArea
                  className='tool-editor'
                  aria-label='项目启动配置 JSON'
                  spellCheck={false}
                  value={config}
                  onChange={(e) => setConfig(e)}
                  rows={15}
                />
                <div className='tool-actions'>
                  <Button
                    disabled={disabled}
                    onClick={() =>
                      setConfig(
                        JSON.stringify(
                          {
                            version: 1,
                            init: ['npm install'],
                            services: [
                              {
                                name: 'web',
                                command: 'npm run dev -- --host 0.0.0.0 --port "$PORT"',
                                port: 3000,
                                healthPath: '/',
                              },
                              { name: 'api', cwd: 'api', command: 'npm start', port: 8080, healthPath: '/health' },
                            ],
                          },
                          null,
                          2,
                        ),
                      )
                    }
                  >
                    填入双服务示例
                  </Button>
                  <Button
                    type='primary'
                    disabled={disabled || !services || services.services.some((s) => s.running)}
                    loading={pending === 'save'}
                    onClick={() => void serviceAction('save')}
                  >
                    保存配置
                  </Button>
                </div>
              </section>
            </>
          )}
        </div>
      </Drawer>
    </>
  );
}
