import { Button, Input } from '@arco-design/web-react';
import { useCallback, useEffect, useState } from 'react';

import { Callout, Empty, PageHeader } from '../components/common';
import { Modal } from '../components/overlays';
import { type SandboxRecord, date, request } from '../domain';
import { RefreshIcon } from '../icons';

import type { Workbench } from '../use-workbench';

// Sandbox management redesigned: every sandbox shows its workspace context
// (owner, project, branch), its lifecycle state, and inline actions. The
// platform chain is visible at a glance: image → sandbox → workspace.
const stateLabels: Record<string, string> = {
  Running: '运行中',
  Paused: '已暂停',
  Pausing: '暂停中',
  Pending: '等待资源',
  Stopping: '停止中',
  Terminated: '已终止',
  Failed: '失败',
};

export function SandboxAdmin({ wb }: { wb: Workbench }) {
  const [records, setRecords] = useState<SandboxRecord[]>();
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [detail, setDetail] = useState<SandboxRecord>();
  const [confirm, setConfirm] = useState<{ action: string; id: string; name: string }>();
  const [execTarget, setExecTarget] = useState<SandboxRecord>();
  const [execCmd, setExecCmd] = useState('');
  const [execOutput, setExecOutput] = useState('');

  const load = useCallback(async () => {
    setError('');
    try {
      const result = await request<{ items: SandboxRecord[] }>('/sandboxes');
      setRecords(result.items);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const run = (action: string, id: string, message: string) =>
    void wb.act(`sandbox:${id}:${action}`, async () => {
      try {
        await request(`/sandboxes/${id}/${action}`, {});
        wb.setNotice(message);
        await load();
        setConfirm(undefined);
        setDetail(undefined);
      } catch (e) {
        setError((e as Error).message);
        throw e;
      }
    });

  const execCommand = () => {
    if (!execTarget || !execCmd.trim()) {
      return;
    }
    void wb.act(`exec:${execTarget.id}`, async () => {
      try {
        const result = await request<{ output: string; error?: string }>(`/sandboxes/${execTarget.id}/exec`, {
          command: execCmd,
        });
        setExecOutput(result.output || result.error || '(empty)');
      } catch (e) {
        setExecOutput(String((e as Error).message));
      }
    });
  };
  const items = (records || []).filter((r) =>
    `${r.name || ''} ${r.id} ${r.workspaceOwner || ''} ${r.projectName || ''} ${r.status}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  const confirmLabel = confirm?.action === 'delete' ? '删除' : confirm?.action === 'restart' ? '重启' : '暂停';

  return (
    <>
      <PageHeader
        title='沙箱管理'
        description='查看个人开发机与旧沙箱的运行状态。新工作区复用个人开发机。'
        action={
          <Button
            icon={<RefreshIcon />}
            loading={wb.pending === 'sandbox-refresh'}
            disabled={!!wb.pending}
            onClick={() => void wb.act('sandbox-refresh', load)}
          >
            刷新
          </Button>
        }
      />
      {error && (
        <div className='inline-error' role='alert'>
          {error}
        </div>
      )}
      <div className='collection-toolbar'>
        <Input.Search
          className='resource-search'
          aria-label='搜索沙箱'
          placeholder='搜索名称、用户、项目、状态'
          value={query}
          onChange={(e) => setQuery(e)}
          allowClear
        />
        <span className='subtle'>
          {items.filter((r) => r.status === 'Running').length} 运行中 / 共 {items.length}
        </span>
      </div>

      {items.length ? (
        <div className='workspace-list'>
          {items.map((record) => (
            <div className='env-card' key={record.id}>
              <div className='env-head'>
                <span
                  className={`env-dot ${record.status === 'Running' ? 'env-dot-on' : record.status === 'Failed' ? 'env-dot-off' : 'env-dot-idle'}`}
                />
                <Button type='text' size='small' className='env-branch sandbox-name' onClick={() => setDetail(record)}>
                  {record.workspaceBranch
                    ? `${record.workspaceOwner} · ${record.projectName} · ${record.workspaceBranch}`
                    : record.name || record.id.slice(0, 12)}
                </Button>
                <span className='env-meta'>
                  {stateLabels[record.status] || record.status}
                  {record.expiresAt ? ` · ${date(record.expiresAt)} 到期` : ' · 不过期'}
                </span>
                <span className='env-actions'>
                  <Button size='small' disabled={!!wb.pending} onClick={() => setDetail(record)}>
                    详情
                  </Button>
                </span>
              </div>
              {record.imageName && (
                <div className='image-tag-list'>
                  <code className='image-tag'>{record.imageName}</code>
                </div>
              )}
            </div>
          ))}
        </div>
      ) : records ? (
        <Empty title='没有沙箱'>从项目创建工作区后，沙箱会自动创建。</Empty>
      ) : (
        <div className='loading-skeleton' role='status' aria-label='正在读取沙箱'>
          <span />
          <div />
        </div>
      )}

      <Modal
        visible={!!detail}
        title={detail?.workspaceBranch || detail?.name || detail?.id?.slice(0, 12) || '沙箱详情'}
        width={640}

        alignCenter
        closable
        focusLock

        onCancel={() => setDetail(undefined)}

        footer={
          <div className='drawer-actions'>
            <Button disabled={!!wb.pending} onClick={() => detail && run('snapshots', detail.id, '快照创建已提交')}>
              创建快照
            </Button>
            <Button onClick={() => setDetail(undefined)}>关闭</Button>
          </div>
        }
      >
        {detail && (
          <>
            {detail.workspaceBranch ? (
              <Callout>
                绑定工作区：{detail.workspaceOwner} · {detail.projectName} · {detail.workspaceBranch}
              </Callout>
            ) : (
              <Callout tone='warning'>未绑定工作台工作区（可能是手动创建的或已解绑）</Callout>
            )}
            <div className='sandbox-detail-grid'>
              <div>
                <dt>沙箱 ID</dt>
                <dd>
                  <code className='break-text'>{detail.id}</code>
                </dd>
              </div>
              <div>
                <dt>状态</dt>
                <dd>
                  {stateLabels[detail.status] || detail.status}
                  {detail.statusMessage ? ` · ${detail.statusMessage}` : ''}
                </dd>
              </div>
              <div>
                <dt>镜像</dt>
                <dd>
                  <code className='break-text'>{detail.imageName || detail.snapshotId || '—'}</code>
                </dd>
              </div>
              <div>
                <dt>创建时间</dt>
                <dd>{date(detail.createdAt)}</dd>
              </div>
              <div>
                <dt>到期时间</dt>
                <dd>{detail.expiresAt ? date(detail.expiresAt) : '不过期'}</dd>
              </div>
            </div>
            {Object.keys(detail.metadata || {}).length > 0 && (
              <>
                <div className='section-heading'>
                  <h3>元数据</h3>
                </div>
                <div className='sandbox-metadata'>
                  {Object.entries(detail.metadata!).map(([key, value]) => (
                    <div key={key}>
                      <dt>{key}</dt>
                      <dd className='break-text'>{value}</dd>
                    </div>
                  ))}
                </div>
              </>
            )}
            <div className='sandbox-detail-operations'>
              <h3>实例操作</h3>
              <div>
                <Button
                  size='small'
                  disabled={!!wb.pending}
                  onClick={() => {
                    setExecTarget(detail);
                    setDetail(undefined);
                  }}
                >
                  终端
                </Button>
                <Button size='small' disabled={!!wb.pending} onClick={() => run('renew', detail.id, '已续期 30 分钟')}>
                  续期
                </Button>
                {detail.status === 'Running' && (
                  <Button
                    size='small'
                    disabled={!!wb.pending}
                    onClick={() => {
                      setConfirm({ action: 'pause', id: detail.id, name: detail.name || detail.id.slice(8) });
                      setDetail(undefined);
                    }}
                  >
                    暂停
                  </Button>
                )}
                {detail.status === 'Paused' && (
                  <Button size='small' disabled={!!wb.pending} onClick={() => run('resume', detail.id, '恢复已提交')}>
                    恢复
                  </Button>
                )}
                <Button
                  type='text'
                  size='small'
                  status='danger'
                  disabled={!!wb.pending}
                  onClick={() => {
                    setConfirm({ action: 'delete', id: detail.id, name: detail.name || detail.id.slice(8) });
                    setDetail(undefined);
                  }}
                >
                  删除沙箱
                </Button>
              </div>
            </div>
          </>
        )}
      </Modal>

      <Modal
        visible={!!execTarget}
        title={`终端 · ${execTarget?.name || execTarget?.workspaceBranch || execTarget?.id?.slice(0, 12)}`}
        width={640}

        alignCenter
        closable
        focusLock

        onCancel={() => {
          setExecTarget(undefined);
          setExecOutput('');
          setExecCmd('');
        }}

        footer={
          <div className='drawer-actions'>
            <Button
              onClick={() => {
                setExecTarget(undefined);
                setExecOutput('');
                setExecCmd('');
              }}
            >
              关闭
            </Button>
          </div>
        }
      >
        <div className='exec-console'>
          <div className='exec-input-row'>
            <Input
              value={execCmd}
              onChange={(e) => setExecCmd(e)}
              onPressEnter={execCommand}
              placeholder='输入命令，如 ls -la /workspace'
              aria-label='执行命令'
            />
            <Button
              type='primary'
              size='small'
              loading={wb.pending?.startsWith('exec:')}
              disabled={!!wb.pending}
              onClick={execCommand}
            >
              执行
            </Button>
          </div>
          {execOutput && <pre className='exec-output'>{execOutput}</pre>}
        </div>
      </Modal>

      <Modal
        visible={!!confirm}
        title={`${confirmLabel}沙箱`}
        width={520}

        alignCenter
        closable
        escToExit={!wb.pending}
        onCancel={() => !wb.pending && setConfirm(undefined)}

        footer={
          <div className='drawer-actions'>
            <Button disabled={!!wb.pending} onClick={() => setConfirm(undefined)}>
              取消
            </Button>
            <Button
              type='primary'
              status={confirm?.action === 'delete' ? 'danger' : 'default'}
              loading={!!confirm && wb.pending === `sandbox:${confirm.id}:${confirm.action}`}
              disabled={!!wb.pending}
              onClick={() => confirm && run(confirm.action, confirm.id, `${confirmLabel}已提交`)}
            >
              确认
            </Button>
          </div>
        }
      >
        {confirm?.action === 'delete' ? (
          <Callout tone='warning' title='此操作不可恢复'>
            将删除沙箱 <code>{confirm.name}</code>
            {confirm.action === 'delete' && ' 及其全部文件。绑定工作区的沙箱建议从工作区删除以同时回收工作卷。'}
          </Callout>
        ) : confirm?.action === 'restart' ? (
          <Callout>重启会中断当前终端和 IDE 连接；工作区文件仍保留。</Callout>
        ) : (
          <Callout>暂停会冻结沙箱进程并保留文件；恢复后 IDE 需重新启动。</Callout>
        )}
      </Modal>
    </>
  );
}
