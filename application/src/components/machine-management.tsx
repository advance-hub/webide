import { Button, Input, Select, Tabs } from '@arco-design/web-react';
import { useEffect, useState } from 'react';

import { request } from '../api/client';
import { date } from '../domain/presentation';

import { Callout } from './common';
import { Drawer, Modal } from './overlays';

import type { Workbench } from '../state/use-workbench';

interface Backup {
  id: string;
  name: string;
  bytes: number;
  createdAt: string;
  automatic: boolean;
}
interface Metrics {
  diskTotal: number;
  diskFree: number;
  workspaceBytes: number;
  mavenCacheBytes: number;
  memoryUsed?: number;
  memoryLimit?: number;
}
interface BackupState {
  backups: Backup[];
  job?: { status: string; action: string; error?: string; needsRecovery?: boolean };
}
const bytes = (n?: number) => (n == null ? '—' : `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`);
export function MachineManagement({ wb }: { wb: Workbench }) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState('resources');
  const [pending, setPending] = useState('');
  const [error, setError] = useState('');
  const [metrics, setMetrics] = useState<Metrics>();
  const [backups, setBackups] = useState<BackupState>({ backups: [] });
  const [name, setName] = useState('');
  const [idle, setIdle] = useState(60);
  const [interval, setInterval] = useState(24);
  const [settings, setSettings] = useState('{}');
  const [workspace, setWorkspace] = useState('');
  const [confirm, setConfirm] = useState<{ action: string; id?: string; label: string }>();
  const busy = !!pending || wb.machine?.job?.status === 'running';
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
  const loadBackups = async () => setBackups(await request<BackupState>('/machine/backups'));
  const load = (value: string) =>
    run('load', async () => {
      if (value !== 'backups' && wb.machine?.job?.status === 'running') {
        return;
      }
      if (value === 'resources') {
        setMetrics(await request<Metrics>('/machine/tools', { action: 'inspect' }));
      } else if (value === 'backups') {
        await loadBackups();
      } else {
        const r = await request<{ settings: object }>('/machine/tools', { action: 'preferences-read' });
        setSettings(JSON.stringify(r.settings, null, 2));
      }
    });
  useEffect(() => {
    if (!open) {
      return;
    }
    setIdle(wb.machine?.policy?.idleMinutes ?? 60);
    setInterval(wb.machine?.policy?.autoBackupHours ?? 24);
  }, [open, wb.machine?.policy?.idleMinutes, wb.machine?.policy?.autoBackupHours]);
  useEffect(() => {
    if (!open || tab !== 'backups' || wb.machine?.job?.status !== 'running') {
      return;
    }
    const timer = window.setInterval(() => void loadBackups().catch((e) => setError(e.message)), 3000);
    return () => clearInterval(timer);
  }, [open, tab, wb.machine?.job?.status]);
  useEffect(() => {
    if (open) {
      void load(tab);
    }
  }, [wb.machine?.job?.status]);
  const backupAction = (action: string, id?: string) =>
    run(action, async () => {
      await request('/machine/backups', { action, backupId: id, name });
      setConfirm(undefined);
      await wb.refresh();
      await loadBackups();
    });
  const savePreferences = (current = false) =>
    run('preferences', async () => {
      const r = await request<{ settings: object }>('/machine/tools', {
        action: current ? 'preferences-current' : 'preferences-save',
        workspaceId: current ? workspace : undefined,
        settings: current ? undefined : JSON.parse(settings),
      });
      setSettings(JSON.stringify(r.settings, null, 2));
      wb.setNotice('个人偏好已保存，项目中的单独修改会保留。');
    });
  return (
    <>
      <Button
        size='small'
        onClick={() => {
          setOpen(true);
          void load(tab);
        }}
      >
        管理开发机
      </Button>
      <Drawer
        visible={open}
        title='我的开发机'

        width='min(800px, 100vw)'
        onCancel={() => setOpen(false)}
        focusLock

        escToExit
        closable

        footer={<Button onClick={() => setOpen(false)}>关闭</Button>}
      >
        <p className='overlay-description'>{'资源、恢复与个人配置'}</p>
        <Tabs
          aria-label='开发机管理分类'
          activeTab={tab}
          onChange={(value) => {
            setTab(value);
            void load(value);
          }}
        >
          <Tabs.TabPane key='resources' title='资源与策略' disabled={!!pending} />
          <Tabs.TabPane key='backups' title='备份与恢复' disabled={!!pending} />
          <Tabs.TabPane key='preferences' title='个人配置' disabled={!!pending} />
        </Tabs>
        <div className='maven-panel tools-panel' aria-busy={!!pending}>
          {error && (
            <Callout tone='warning' title='操作未完成'>
              {error}
            </Callout>
          )}
          {wb.machine?.job?.status === 'running' && (
            <Callout title='开发机维护中'>
              正在执行
              {wb.machine.job.action === 'restore'
                ? '恢复'
                : wb.machine.job.action === 'runtime'
                  ? '运行时更新'
                  : '备份'}
              ，结束后自动恢复原先运行的 IDE。
            </Callout>
          )}
          {tab === 'resources' ? (
            <>
              <section>
                <div className='tool-heading'>
                  <h2>资源使用</h2>
                  <Button disabled={busy} onClick={() => void load(tab)}>
                    刷新
                  </Button>
                </div>
                <dl className='resource-metrics'>
                  <div>
                    <dt>工作区文件</dt>
                    <dd>{bytes(metrics?.workspaceBytes)}</dd>
                  </div>
                  <div>
                    <dt>Maven 缓存</dt>
                    <dd>{bytes(metrics?.mavenCacheBytes)}</dd>
                  </div>
                  <div>
                    <dt>文件系统可用 / 总量</dt>
                    <dd>
                      {bytes(metrics?.diskFree)} / {bytes(metrics?.diskTotal)}
                    </dd>
                  </div>
                  <div>
                    <dt>开发机内存 / 限额</dt>
                    <dd>
                      {bytes(metrics?.memoryUsed)} / {bytes(metrics?.memoryLimit)}
                    </dd>
                  </div>
                </dl>
                <Button disabled={busy} onClick={() => setConfirm({ action: 'clean-cache', label: '清理 Maven 缓存' })}>
                  清理 Maven 缓存
                </Button>
                <p className='subtle'>只清理可重新下载的依赖。正在构建时不可清理。</p>
              </section>
              <section>
                <h2>自动维护</h2>
                <label className='field-label' htmlFor='machine-idle'>
                  无 IDE / 预览连接后自动停止（分钟，0 关闭）
                </label>
                <Input id='machine-idle' type='number' value={String(idle)} onChange={(e) => setIdle(Number(e))} />
                <label className='field-label' htmlFor='machine-backup-hours'>
                  自动备份间隔（小时，0 关闭）
                </label>
                <Input
                  id='machine-backup-hours'
                  type='number'
                  value={String(interval)}
                  onChange={(e) => setInterval(Number(e))}
                />
                <p className='subtle'>仅在全部工作区已停止时自动备份，保留最近 7 份自动备份。手动备份独立保留。</p>
                {wb.machine?.machine?.backupError && <p role='alert'>{wb.machine.machine.backupError}</p>}
                <Button
                  type='primary'
                  disabled={busy}
                  onClick={() =>
                    void run('policy', async () => {
                      await request('/machine/tools', {
                        action: 'policy-save',
                        policy: { idleMinutes: idle, autoBackupHours: interval },
                      });
                      await wb.refresh();
                      wb.setNotice('自动维护策略已保存。');
                    })
                  }
                >
                  保存策略
                </Button>
              </section>
            </>
          ) : tab === 'backups' ? (
            <>
              <section>
                <h2>创建恢复点</h2>
                <p>
                  备份包含已保存代码、分支、个人配置与 AI 登录。操作期间短暂停止本机所有 IDE；请先保存编辑器文件。Maven
                  下载缓存不进入备份。
                </p>
                <div className='maven-pom-row'>
                  <Input
                    aria-label='备份名称'
                    placeholder='例如 发布前'
                    value={name}
                    maxLength={120}
                    onChange={(e) => setName(e)}
                  />
                  <Button type='primary' disabled={busy} onClick={() => void backupAction('backup')}>
                    立即备份
                  </Button>
                </div>
                <p className='subtle'>
                  备份存储在控制面数据目录，可配置独立备份磁盘。恢复会覆盖本机文件，并先保存当前文件的保护备份。
                </p>
              </section>
              <section>
                <div className='tool-heading'>
                  <h2>恢复点</h2>
                  <Button disabled={!!pending} onClick={() => void run('refresh', loadBackups)}>
                    刷新
                  </Button>
                </div>
                {backups.job?.error && (
                  <Callout tone='warning' title='上次维护结果'>
                    {backups.job.error}
                    {backups.job.needsRecovery && (
                      <Button disabled={busy} onClick={() => void backupAction('recover')}>
                        重试恢复收尾
                      </Button>
                    )}
                  </Callout>
                )}
                {backups.backups.map((b) => (
                  <div className='service-row' key={b.id}>
                    <div>
                      <strong>{b.name}</strong>
                      <p>
                        {date(b.createdAt)} · {bytes(b.bytes)} · {b.automatic ? '自动' : '手动'}
                      </p>
                    </div>
                    <div className='tool-actions'>
                      <Button
                        size='small'
                        disabled={busy}
                        onClick={() => setConfirm({ action: 'restore', id: b.id, label: `恢复“${b.name}”` })}
                      >
                        恢复
                      </Button>
                      <Button
                        size='small'
                        disabled={busy}
                        onClick={() => setConfirm({ action: 'delete', id: b.id, label: `删除“${b.name}”` })}
                      >
                        删除
                      </Button>
                    </div>
                  </div>
                ))}
                {!backups.backups.length && <p className='subtle'>尚无备份。</p>}
              </section>
            </>
          ) : (
            <>
              <section>
                <h2>跨项目继承</h2>
                <p>OpenCode 登录与模型设置保存在个人开发机，切换项目继续使用。项目对话仍按工作目录区分。</p>
                <p>个人编辑器偏好作为各工作区默认值；工作区已单独修改的选项会保留。</p>
                <div className='maven-pom-row'>
                  <Select
                    style={{ width: '100%' }}
                    aria-label='复制偏好的工作区'
                    placeholder='选择工作区'
                    value={workspace || undefined}
                    options={wb.workspaces
                      .filter((w) => w.machineId === wb.machine?.machine?.id)
                      .map((w) => ({ value: w.id, label: `${w.projectName || w.projectId} · ${w.branch}` }))}
                    onChange={(v) => setWorkspace(String(v))}
                  />
                  <Button disabled={busy || !workspace} onClick={() => void savePreferences(true)}>
                    使用此工作区偏好
                  </Button>
                </div>
              </section>
              <section>
                <label className='field-label' htmlFor='personal-editor-settings'>
                  编辑器默认设置 JSON
                </label>
                <Input.TextArea
                  id='personal-editor-settings'
                  className='tool-editor'
                  rows={16}
                  spellCheck={false}
                  value={settings}
                  onChange={(e) => setSettings(e)}
                />
                <p className='subtle'>支持 editor、files、workbench、general、terminal、ai.native 设置。</p>
                <Button type='primary' disabled={busy} onClick={() => void savePreferences()}>
                  保存并应用
                </Button>
              </section>
            </>
          )}
        </div>
      </Drawer>
      <Modal
        visible={!!confirm}
        title={confirm?.label}
        width={500}
        alignCenter
        closable
        focusLock

        onCancel={() => !pending && setConfirm(undefined)}

        footer={
          <div className='drawer-actions'>
            <Button disabled={!!pending} onClick={() => setConfirm(undefined)}>
              取消
            </Button>
            <Button
              type='primary'
              status='danger'
              disabled={busy}
              loading={!!pending}
              onClick={() => {
                if (!confirm) {
                  return;
                }
                if (confirm.action === 'clean-cache') {
                  void run('clean-cache', async () => {
                    setMetrics(await request<Metrics>('/machine/tools', { action: 'clean-cache' }));
                    setConfirm(undefined);
                  });
                } else {
                  void backupAction(confirm.action, confirm.id);
                }
              }}
            >
              确认
            </Button>
          </div>
        }
      >
        <p>
          {confirm?.action === 'restore'
            ? '本机所有工作区将恢复到选中时间点。当前已保存文件会先备份，未保存的编辑器内容不在备份中。'
            : confirm?.action === 'delete'
              ? '此恢复点将被永久删除，工作区文件不变。'
              : '依赖缓存会删除，下次 Maven 构建需要重新下载依赖。'}
        </p>
        {error && <p role='alert'>{error}</p>}
      </Modal>
    </>
  );
}
