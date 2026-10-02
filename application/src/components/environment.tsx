import { Button, Dropdown, Input, Menu } from '@arco-design/web-react';
import { useState } from 'react';

import { type Workspace } from '../../shared/contracts';
import { request } from '../api/client';
import { busyStates, date, driverLabels } from '../domain/presentation';

import { Callout, Status } from './common';
import { CodeIcon, MoreIcon, PeopleIcon } from './icons';
import { MavenPanel } from './maven';
import { Modal } from './overlays';
import { WorkspaceTools } from './workspace-tools';

import type { Workbench } from '../state/use-workbench';

// 每个工作区只有一个运行环境，卡片用单行展示
// 分支、基线和驱动信息，并区分主操作、
// 次要操作以及右侧的危险操作。
// 成员以紧凑标签展示，避免共享信息占据独立区域。
export function EnvironmentPanel({
  workspace: w,
  wb,
  compact = false,
}: {
  workspace: Workspace;
  wb: Workbench;
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [phase, setPhase] = useState<string>();
  const [checking, setChecking] = useState(false);
  const [memberName, setMemberName] = useState('');
  const [adding, setAdding] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [mrTitle, setMrTitle] = useState('');
  const [targetBranch, setTargetBranch] = useState('');
  const active = busyStates.has(w.status);
  const own = !w.ownerName;
  const members = w.memberNames || [];
  const project = wb.projects.find((item) => item.id === w.projectId);
  const defaultTarget = w.baseBranch && w.baseBranch !== w.branch ? w.baseBranch : project?.branch || '';
  const openPublish = () => {
    setTargetBranch(defaultTarget);
    setMrTitle(`${w.branch} → ${defaultTarget}`);
    setError('');
    setPublishOpen(true);
  };
  const publish = () => {
    void wb.act(`publish:${w.id}`, async () => {
      try {
        const result = await request<{ sha: string; mergeRequestUrl: string }>(`/workspaces/${w.id}/publish`, {
          targetBranch: targetBranch.trim(),
          title: mrTitle.trim(),
        });
        await wb.refresh();
        setPublishOpen(false);
        wb.setNotice(`已推送 ${result.sha.slice(0, 8)} 并创建 MR`);
      } catch (e) {
        setError((e as Error).message);
        throw e;
      }
    });
  };

  const inspect = async () => {
    setChecking(true);
    setError('');
    try {
      const info = await request<{ exists?: boolean; phase?: string }>(`/workspaces/${w.id}/environment`);
      setPhase(info.exists ? info.phase || '—' : '未创建');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  };
  const act = (action: string, message: string) =>
    void wb.act(`env:${w.id}`, async () => {
      try {
        await request(`/workspaces/${w.id}/${action}`, {});
        await wb.refresh();
        setConfirm('');
        wb.setNotice(message);
      } catch (e) {
        setError((e as Error).message);
        await wb.refresh();
        throw e;
      }
    });
  const confirmAction = (action: string, expected: string | null) => {
    if (expected && typed.trim() !== expected) {
      setError(`请输入 ${expected} 以确认`);
      return;
    }
    act(action, '操作已提交。');
  };
  const invite = (username: string, remove: boolean) => {
    if (!username.trim()) {
      return;
    }
    void wb.act(`member:${w.id}`, async () => {
      try {
        await request(`/workspaces/${w.id}/members`, { username: username.trim(), remove });
        await wb.refresh();
        setMemberName('');
        setAdding(false);
        setError('');
      } catch (e) {
        setError((e as Error).message);
        throw e;
      }
    });
  };
  const ask = (action: 'reset' | 'delete') => {
    setTyped('');
    setError('');
    setConfirm(action);
  };

  const driver = driverLabels[w.driver || wb.config?.driver || 'sandbox'];
  const meta = [
    (w.sha || '').slice(0, 8) || '基线待固定',
    w.archived ? '归档' : w.machineId ? '个人开发机' : driver,
    `更新 ${date(w.updatedAt)}`,
  ].join(' · ');

  const card = (
    <div className='env-card'>
      <div className='env-head'>
        <span
          className={`env-dot env-dot-${w.status === 'ready' ? 'on' : busyStates.has(w.status) ? 'busy' : w.status === 'failed' ? 'off' : 'idle'}`}
        />
        <span className='env-branch'>{w.branch}</span>
        <Status state={w.status} />
        <span className='env-meta'>{meta}</span>
        <span className='env-actions'>
          {own && w.machineId && <WorkspaceTools workspace={w} wb={wb} />}
          {w.status === 'ready' && (
            <Button
              type='primary'
              size='small'
              icon={<CodeIcon />}
              aria-label={`进入 ${w.branch} 的 IDE`}
              disabled={!!wb.pending}
              onClick={() => void wb.enter(w)}
            >
              进入 IDE
            </Button>
          )}
          {w.status === 'ready' && w.startup?.development.ready && (
            <Button size='small' disabled={!!wb.pending} onClick={() => void wb.enter(w, 'preview')}>
              打开预览
            </Button>
          )}
          {own && (w.status === 'stopped' || w.status === 'failed') && (
            <Button
              type='primary'
              size='small'
              disabled={active || !!wb.pending}
              onClick={() => act('start', '启动已提交。')}
            >
              启动 IDE
            </Button>
          )}
          {own && w.status === 'ready' && defaultTarget && defaultTarget !== w.branch && (
            <Button type='text' size='small' disabled={active || !!wb.pending} onClick={openPublish}>
              {w.mergeRequestUrl ? '更新 MR' : '提交 MR'}
            </Button>
          )}
          {phase && (
            <span className='env-live' title='运行环境实时状态'>
              {phase}
            </span>
          )}
          <Button type='text' size='small' loading={checking} disabled={!!wb.pending} onClick={() => void inspect()}>
            状态
          </Button>
        </span>
      </div>

      {(w.error || (error && !confirm && !publishOpen)) && (
        <div className='env-error' role='alert'>
          {w.error || error}
        </div>
      )}
      {w.archived && <div className='env-note'>由旧版历史沙箱迁移而来；可启动继续使用，或删除以释放资源。</div>}
      {w.mergeRequestUrl && (
        <div className='env-note'>
          已发布 {(w.publishedSha || '').slice(0, 8)} ·{' '}
          <a href={w.mergeRequestUrl} target='_blank' rel='noopener noreferrer'>
            查看合并请求
          </a>
        </div>
      )}
      {w.startup && (
        <details className='env-startup'>
          <summary>
            {active
              ? '正在准备开发环境'
              : w.startup.development.error
                ? 'IDE 可用，项目启动需处理'
                : w.status !== 'ready'
                  ? '查看最近启动记录'
                  : w.startup.development.ready
                    ? '应用可预览'
                    : 'IDE 已就绪'}
            {w.startup.development.cached && <span> · 已复用依赖初始化结果</span>}
          </summary>
          <ol>
            {w.startup.steps.map((step, i) => (
              <li key={`${step.id}-${i}`}>
                <span>
                  {(
                    {
                      baseline: '固定代码版本',
                      sandbox: '创建或恢复环境',
                      runtime: '校验开发运行时',
                      git: '连接代码仓库',
                      files: '准备项目文件',
                      maven: '检查 Maven 环境',
                      'editor-connections': '预置编辑器数据连接',
                      ide: '启动 IDE',
                      dependencies: '初始化项目依赖',
                      application: '启动应用并检查预览',
                    } as Record<string, string>
                  )[step.id] || step.id}
                </span>
                <span>
                  {step.status === 'done' ? '完成' : step.status === 'failed' ? '失败' : active ? '进行中' : '已中断'}
                  {step.finishedAt
                    ? ` · ${Math.max(0, (Date.parse(step.finishedAt) - Date.parse(step.startedAt)) / 1000).toFixed(1)} 秒`
                    : ''}
                </span>
                {step.error && <div className='env-error'>{step.error}</div>}
              </li>
            ))}
          </ol>
          {w.startup.runtime.source && <p>运行环境：{w.startup.runtime.source}</p>}
          {w.startup.development.error ? (
            <p role='alert'>请进入 IDE 查看项目上级目录中的 .platform/development.log，修复后重启工作区。</p>
          ) : (
            w.status === 'ready' &&
            !w.startup.development.configured && (
              <p>
                在项目中添加 .opensumi/development.json，配置依赖初始化和应用启动命令后重启，即可启用自动启动与预览。
              </p>
            )
          )}
        </details>
      )}

      {w.startup?.editorConnections &&
        (w.startup.editorConnections.mysql ||
          w.startup.editorConnections.redis ||
          w.startup.editorConnections.error) && (
          <div className='env-note'>
            编辑器数据连接：
            {w.startup.editorConnections.mysql && ' MySQL 已预置'}
            {w.startup.editorConnections.redis && ' Redis 已预置'}
            {w.startup.editorConnections.error && ` · ${w.startup.editorConnections.error}`}
            {' · 可在 IDE 插件中修改或新增'}
          </div>
        )}

      {(w.startup?.maven?.detected || w.startup?.maven?.error) && <MavenPanel workspace={w} wb={wb} />}

      {own && (
        <div className='env-ops'>
          <span className='env-ops-spacer' />
          {!w.machineId && (
            <Button
              type='text'
              size='small'
              aria-label={`管理 ${w.branch} 的成员`}
              disabled={active || !!wb.pending}
              onClick={() => {
                setAdding(!adding);
                setMemberName('');
              }}
            >
              <PeopleIcon /> 成员{members.length ? ` ${members.length}` : ''}
            </Button>
          )}
          <Dropdown
            trigger='click'
            position='br'
            droplist={
              <Menu
                onClickMenuItem={(key) => {
                  if (key === 'stop') {
                    act('stop', '停止已提交。');
                  }
                  if (key === 'restart') {
                    act('restart', '重启已提交。');
                  }
                  if (key === 'reset') {
                    ask('reset');
                  }
                  if (key === 'update-runtime') {
                    act(
                      'update-runtime',
                      w.machineId
                        ? '开发机运行时更新中，同一开发机的 IDE 将依次恢复，已保存文件会保留。'
                        : 'IDE 运行时更新中，已保存文件会保留。',
                    );
                  }
                  if (key === 'delete') {
                    ask('delete');
                  }
                }}
              >
                {w.status === 'ready' && <Menu.Item key='stop'>停止 IDE</Menu.Item>}
                {w.status === 'ready' && <Menu.Item key='restart'>重启 IDE</Menu.Item>}
                {!w.archived && ['ready', 'stopped', 'failed'].includes(w.status) && (
                  <Menu.Item key='reset'>重置文件</Menu.Item>
                )}
                {!w.archived &&
                  ['ready', 'failed'].includes(w.status) &&
                  (w.driver === 'sandbox' || w.driver === undefined) && (
                    <Menu.Item key='update-runtime'>{w.machineId ? '更新开发机运行时' : '更新 IDE 运行时'}</Menu.Item>
                  )}
                <Menu.Item key='delete'>删除工作区</Menu.Item>
              </Menu>
            }
          >
            <Button
              type='text'
              size='small'
              icon={<MoreIcon />}
              aria-label={`${w.branch} 更多操作`}
              disabled={active || !!wb.pending}
            >
              更多操作
            </Button>
          </Dropdown>
        </div>
      )}

      {own && !w.machineId && (adding || members.length > 0) && (
        <div className='env-members'>
          {members.map((name) => (
            <span className='member-chip' key={name}>
              {name}
              <Button
                type='text'
                size='mini'
                aria-label={`移除成员 ${name}`}
                disabled={!!wb.pending}
                onClick={() => invite(name, true)}
              >
                ×
              </Button>
            </span>
          ))}
          {adding && (
            <span className='member-add'>
              <Input
                size='small'
                aria-label='成员用户名'
                placeholder='登录用户名，回车添加'
                value={memberName}
                onChange={(e) => setMemberName(e)}
                onPressEnter={() => invite(memberName, false)}
              />
              <Button
                size='small'
                disabled={!!wb.pending || !memberName.trim()}
                onClick={() => invite(memberName, false)}
              >
                添加
              </Button>
              <Button type='text' size='small' onClick={() => setAdding(false)}>
                取消
              </Button>
            </span>
          )}
          {members.length === 0 && !adding && (
            <span className='env-members-hint'>默认不共享；成员与你编辑同一份实时文件。</span>
          )}
        </div>
      )}
    </div>
  );

  const resetDialog = (
    <Modal
      visible={confirm === 'reset'}
      title='重置文件'
      width={520}

      alignCenter
      closable
      focusLock

      escToExit={!wb.pending}
      onCancel={() => !wb.pending && setConfirm('')}

      footer={
        <div className='drawer-actions'>
          <Button disabled={!!wb.pending} onClick={() => setConfirm('')}>
            取消
          </Button>
          <Button
            type='primary'
            status='danger'
            loading={wb.pending === `env:${w.id}`}
            disabled={!!wb.pending}
            onClick={() => confirmAction('reset', w.branch)}
          >
            确认重置
          </Button>
        </div>
      }
    >
      <Callout tone='warning' title='将丢弃此工作区的全部未提交修改'>
        工作目录会从创建时固定的基线（{w.branch} · {(w.sha || '').slice(0, 8)}）重新初始化，随后 IDE
        自动重启；其他分支的工作区不受影响。
      </Callout>
      <p className='dialog-confirm-hint'>
        输入 <code>{w.branch}</code> 以确认
      </p>
      <Input value={typed} onChange={(e) => setTyped(e)} placeholder={w.branch} aria-label='确认分支名' />
      {error && (
        <div className='inline-error' role='alert'>
          {error}
        </div>
      )}
    </Modal>
  );
  const deleteDialog = (
    <Modal
      visible={confirm === 'delete'}
      title='删除工作区'
      width={520}

      alignCenter
      closable
      focusLock

      escToExit={!wb.pending}
      onCancel={() => !wb.pending && setConfirm('')}

      footer={
        <div className='drawer-actions'>
          <Button disabled={!!wb.pending} onClick={() => setConfirm('')}>
            取消
          </Button>
          <Button
            type='primary'
            status='danger'
            loading={wb.pending === `env:${w.id}`}
            disabled={!!wb.pending}
            onClick={() => confirmAction('delete', 'delete')}
          >
            确认删除
          </Button>
        </div>
      }
    >
      <Callout tone='warning' title='此操作不可恢复'>
        {w.machineId
          ? '将删除此分支的工作目录与工作区记录。个人开发机、其他项目和共享依赖缓存会保留。'
          : '将删除此旧工作区的沙箱、文件与记录；其他工作区不受影响。'}
      </Callout>
      <p className='dialog-confirm-hint'>
        输入 <code>delete</code> 以确认
      </p>
      <Input value={typed} onChange={(e) => setTyped(e)} placeholder='delete' aria-label='确认删除' />
      {error && (
        <div className='inline-error' role='alert'>
          {error}
        </div>
      )}
    </Modal>
  );
  const publishDialog = (
    <Modal
      visible={publishOpen}
      title='推送提交并创建 MR'
      width={520}

      alignCenter
      closable
      focusLock

      escToExit={!wb.pending}
      onCancel={() => !wb.pending && setPublishOpen(false)}

      footer={
        <div className='drawer-actions'>
          <Button disabled={!!wb.pending} onClick={() => setPublishOpen(false)}>
            取消
          </Button>
          <Button
            type='primary'
            loading={wb.pending === `publish:${w.id}`}
            disabled={!!wb.pending || !targetBranch.trim() || targetBranch.trim() === w.branch}
            onClick={publish}
          >
            推送并创建 MR
          </Button>
        </div>
      }
    >
      <p className='muted'>先在 IDE 中提交修改。工作台会推送当前分支的提交，再创建或更新合并请求。</p>
      <label className='field-label' htmlFor={`mr-target-${w.id}`}>
        目标分支
      </label>
      <Input id={`mr-target-${w.id}`} value={targetBranch} onChange={(e) => setTargetBranch(e)} />
      <label className='field-label' htmlFor={`mr-title-${w.id}`}>
        MR 标题
      </label>
      <Input id={`mr-title-${w.id}`} value={mrTitle} onChange={(e) => setMrTitle(e)} />
      {error && (
        <div className='inline-error' role='alert'>
          {error}
        </div>
      )}
    </Modal>
  );

  if (compact) {
    return (
      <>
        <Button
          type='text'
          size='small'
          onClick={() => {
            setOpen(true);
            void inspect();
          }}
        >
          管理
        </Button>
        <Modal
          visible={open}
          title={`工作区 · ${w.branch}`}
          width={640}

          alignCenter
          closable
          focusLock

          onCancel={() => setOpen(false)}

          footer={<Button onClick={() => setOpen(false)}>关闭</Button>}
        >
          {card}
        </Modal>
        {resetDialog}
        {deleteDialog}
        {publishDialog}
      </>
    );
  }
  return (
    <>
      {card}
      {resetDialog}
      {deleteDialog}
      {publishDialog}
    </>
  );
}
