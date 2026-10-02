import { Button, Checkbox, Input, Select } from '@arco-design/web-react';
import { useEffect, useState } from 'react';

import { type MavenOptions, type MavenReport, type Workspace } from '../../shared/contracts';
import { request } from '../api/client';
import { date } from '../domain/presentation';

import { Callout } from './common';
import { MavenConfiguration } from './maven-config';
import { Drawer } from './overlays';

import type { Workbench } from '../state/use-workbench';

const actions: Record<string, string> = {
  prepare: '准备依赖',
  build: '打包 package',
  test: '运行测试',
  verify: '完整校验 verify',
  install: '安装到本地仓库',
  tree: '查看依赖树',
};
const states: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  done: '完成',
  failed: '失败',
  cancelling: '取消中',
  cancelled: '已取消',
};
interface TaskLog {
  text: string;
  truncated: boolean;
}

export function MavenPanel({ workspace: ws, wb }: { workspace: Workspace; wb: Workbench }) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<MavenReport>(ws.startup?.maven || { detected: false });
  const [options, setOptions] = useState<MavenOptions>({ alsoMake: true, timeoutMinutes: 15 });
  const [action, setAction] = useState('build');
  const [profilesText, setProfilesText] = useState('');
  const [selectedJob, setSelectedJob] = useState('');
  const [log, setLog] = useState<TaskLog>();
  const [error, setError] = useState('');
  const [reading, setReading] = useState(false);
  const busy = ['queued', 'running', 'cancelling'].includes(ws.mavenJob?.status || '');
  const jobs = [...(ws.mavenJob ? [ws.mavenJob] : []), ...(ws.mavenHistory || [])];
  const jobId = selectedJob || ws.mavenJob?.id;
  const load = async (pom?: string) => {
    setReading(true);
    setError('');
    try {
      const result = await request<{ report: MavenReport }>(
        `/workspaces/${ws.id}/maven${pom ? `?pom=${encodeURIComponent(pom)}` : ''}`,
      );
      setReport(result.report);
      setOptions((value) => ({ ...value, pom: result.report.pom || value.pom }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setReading(false);
    }
  };
  useEffect(() => {
    if (open) {
      void load(options.pom);
    }
  }, [open, ws.id]);
  useEffect(() => {
    if (!open || !jobId) {
      setLog(undefined);
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const result = await request<{ log: TaskLog }>(`/workspaces/${ws.id}/maven?job=${encodeURIComponent(jobId)}`);
        if (active) {
          setLog(result.log);
        }
      } catch (e) {
        if (active) {
          setError((e as Error).message);
        }
      }
      if (active && busy && jobId === ws.mavenJob?.id) {
        timer = setTimeout(poll, 3000);
      }
    };
    setLog(undefined);
    void poll();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [open, ws.id, jobId, busy]);
  const run = () =>
    void wb.act(`maven:${ws.id}`, async () => {
      setError('');
      try {
        await request(`/workspaces/${ws.id}/maven`, {
          action,
          ...options,
          profiles: profilesText
            .split(',')
            .map((v) => v.trim())
            .filter(Boolean),
        });
        setSelectedJob('');
        setLog(undefined);
        await wb.refresh();
        wb.setNotice(`${actions[action]}任务已提交。`);
      } catch (e) {
        setError((e as Error).message);
        throw e;
      }
    });
  const invalid =
    (options.offline && options.updateSnapshots) || (options.skipTests && ['test', 'verify'].includes(action));
  return (
    <>
      <div className='env-maven'>
        <div className='env-maven-head'>
          <strong>Maven · {ws.startup?.maven?.pom || '项目工具'}</strong>
          <span>{ws.startup?.maven?.wrapper ? '项目 Maven Wrapper' : ws.startup?.maven?.maven}</span>
          <Button size='small' disabled={ws.status !== 'ready'} onClick={() => setOpen(true)}>
            Maven 管理
          </Button>
        </div>
        {ws.mavenJob && (
          <p>
            {actions[ws.mavenJob.action] || ws.mavenJob.action} · {states[ws.mavenJob.status] || ws.mavenJob.status}
            {ws.mavenJob.error && ` · ${ws.mavenJob.error}`}
          </p>
        )}
      </div>
      <Drawer
        visible={open}
        title='Maven 管理'

        width='min(780px, 100vw)'
        onCancel={() => setOpen(false)}
        focusLock

        escToExit
        closable

        footer={
          <div className='drawer-actions'>
            <span className='subtle'>超时可设为 1–60 分钟</span>
            <Button onClick={() => setOpen(false)}>关闭</Button>
            {busy && (
              <Button
                disabled={!!wb.pending}
                loading={wb.pending === `cancel:${ws.id}`}
                onClick={() =>
                  void wb.act(`cancel:${ws.id}`, async () => {
                    await request(`/workspaces/${ws.id}/maven-cancel`, { id: ws.mavenJob?.id });
                    await wb.refresh();
                  })
                }
              >
                取消任务
              </Button>
            )}
            <Button
              type='primary'
              loading={wb.pending === `maven:${ws.id}`}
              disabled={busy || !!wb.pending || !!ws.ownerName || !!invalid || !report.detected}
              onClick={run}
            >
              {busy ? '任务进行中' : actions[action]}
            </Button>
          </div>
        }
      >
        <p className='overlay-description'>{`${ws.branch} · 配置、依赖与构建任务`}</p>
        <div className='maven-panel'>
          {error && (
            <Callout tone='warning' title='操作未完成'>
              {error}
            </Callout>
          )}
          <section>
            <h2>运行环境</h2>
            <p>
              {report.java || '读取 JDK 中'} ·{' '}
              {report.wrapper ? '使用项目 Maven Wrapper' : report.maven || 'Maven 未识别'}
            </p>
            <p>
              settings.xml：
              {report.managedSettings ? '团队配置（COS）' : report.settings ? '项目个人配置' : '使用 Maven 默认配置'}
            </p>
            <p>
              依赖缓存：<code>{report.repository || '—'}</code>
            </p>
            {report.mirrors?.length ? (
              <p>镜像规则：{report.mirrors.map((m) => `${m.id} → ${m.mirrorOf}`).join('，')}</p>
            ) : null}
            <p className='subtle'>可以在终端修改 ~/.m2/settings.xml；手动修改后自动同步会保留你的配置。</p>
          </section>
          <section>
            <h2>本次任务</h2>
            <label className='field-label' htmlFor={`maven-pom-${ws.id}`}>
              POM（相对项目目录）
            </label>
            <div className='maven-pom-row'>
              <Input
                id={`maven-pom-${ws.id}`}
                value={options.pom || ''}
                placeholder='pom.xml'
                onChange={(e) => setOptions({ ...options, pom: e })}
              />
              <Button loading={reading} disabled={reading} onClick={() => void load(options.pom)}>
                读取模块
              </Button>
            </div>
            <label className='field-label' htmlFor={`maven-goal-${ws.id}`}>
              执行目标
            </label>
            <Select
              style={{ width: '100%' }}
              id={`maven-goal-${ws.id}`}
              aria-label='执行目标'
              value={action}
              options={Object.entries(actions).map(([value, label]) => ({ value, label }))}
              onChange={(value) => {
                setAction(String(value));
                if (['test', 'verify'].includes(String(value))) {
                  setOptions({ ...options, skipTests: false });
                }
              }}
            />
            <label className='field-label' htmlFor={`maven-profiles-${ws.id}`}>
              Profiles（逗号分隔）
            </label>
            <Input
              id={`maven-profiles-${ws.id}`}
              value={profilesText}
              placeholder={report.profiles?.join(', ') || '例如 dev,intranet'}
              onChange={(e) => setProfilesText(e)}
            />
            {report.profiles?.length ? (
              <p className='subtle'>当前 POM / settings 声明：{report.profiles.join('、')}</p>
            ) : null}
            <label className='field-label' htmlFor={`maven-modules-${ws.id}`}>
              构建模块（留空构建全部）
            </label>
            <Select
              style={{ width: '100%' }}
              id={`maven-modules-${ws.id}`}
              aria-label='构建模块'
              placeholder='全部模块'
              mode='multiple'
              value={options.modules || []}
              options={(report.modules || []).map((value) => ({ value, label: value }))}
              onChange={(value) => setOptions({ ...options, modules: Array.isArray(value) ? value.map(String) : [] })}
            />
            <label className='field-label' htmlFor={`task-jdk-${ws.id}`}>
              本次 JDK
            </label>
            <Select
              id={`task-jdk-${ws.id}`}
              style={{ width: '100%' }}
              value={options.jdk || ''}
              options={[
                { value: '', label: '使用项目默认 JDK' },
                ...(report.jdks || []).map((value) => ({ value, label: `JDK ${value}` })),
              ]}
              onChange={(v) => setOptions({ ...options, jdk: String(v) || undefined })}
            />
            <label className='field-label' htmlFor={`task-timeout-${ws.id}`}>
              超时（分钟）
            </label>
            <Input
              id={`task-timeout-${ws.id}`}
              type='number'
              value={String(options.timeoutMinutes || 15)}
              onChange={(e) => setOptions({ ...options, timeoutMinutes: Number(e) })}
            />
            <div className='maven-flags'>
              <Checkbox checked={options.alsoMake !== false} onChange={(e) => setOptions({ ...options, alsoMake: e })}>
                同时构建依赖模块 -am
              </Checkbox>
              <Checkbox
                checked={!!options.skipTests}
                disabled={['test', 'verify'].includes(action)}
                onChange={(e) => setOptions({ ...options, skipTests: e })}
              >
                跳过测试 -DskipTests
              </Checkbox>
              <Checkbox
                checked={!!options.offline}
                onChange={(e) =>
                  setOptions({
                    ...options,
                    offline: e,
                    updateSnapshots: e ? false : options.updateSnapshots,
                  })
                }
              >
                离线使用缓存 -o
              </Checkbox>
              <Checkbox
                checked={!!options.updateSnapshots}
                onChange={(e) =>
                  setOptions({
                    ...options,
                    updateSnapshots: e,
                    offline: e ? false : options.offline,
                  })
                }
              >
                更新快照依赖 -U
              </Checkbox>
              <Checkbox checked={!!options.clean} onChange={(e) => setOptions({ ...options, clean: e })}>
                构建前清理 target
              </Checkbox>
            </div>
          </section>
          <MavenConfiguration
            id={ws.id}
            disabled={busy || !!wb.pending || !!ws.ownerName}
            action={action}
            options={{
              ...options,
              profiles: profilesText
                .split(',')
                .map((v) => v.trim())
                .filter(Boolean),
            }}
            onPreset={(p) => {
              setAction(p.action);
              setOptions(p.options);
              setProfilesText((p.options.profiles || []).join(', '));
            }}
          />
          <section>
            <h2>任务与日志</h2>
            {jobs.length ? (
              <>
                <Select
                  style={{ width: '100%' }}
                  aria-label='选择 Maven 任务'
                  value={jobId}
                  options={jobs
                    .filter((job) => job.id)
                    .map((job) => ({
                      value: job.id!,
                      label: `${date(job.startedAt)} · ${actions[job.action] || job.action} · ${states[job.status] || job.status}`,
                    }))}
                  onChange={(value) => setSelectedJob(String(value))}
                />
                {log?.truncated && (
                  <p className='subtle'>显示最后 64 KiB，完整日志保存在工作区 .platform/maven 目录。</p>
                )}
                <pre className='maven-log' aria-label='Maven 任务日志' tabIndex={0}>
                  {log?.text || (busy ? '等待任务输出…' : '此任务暂无日志')}
                </pre>
              </>
            ) : (
              <p className='subtle'>还没有任务。准备依赖会下载到个人开发机，后续项目可复用缓存。</p>
            )}
          </section>
        </div>
      </Drawer>
    </>
  );
}
