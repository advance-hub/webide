import { Button, Form, Input, Select, Tabs } from '@arco-design/web-react';
import { useState } from 'react';

import { type Project, busyStates, date, request } from '../domain';

import { Callout, Definition } from './common';
import { Modal } from './overlays';

import type { Workbench } from '../use-workbench';

export function BaselineActions({ project: p, wb, commit }: { project: Project; wb: Workbench; commit?: string }) {
  const [mode, setMode] = useState<'update' | 'reset'>('update');
  const [open, setOpen] = useState(false);
  const [branch, setBranch] = useState(p.branch);
  const [sha, setSha] = useState('');
  const [expected, setExpected] = useState(p.sha);
  const [error, setError] = useState('');
  const busy = busyStates.has(p.baselineStatus || '');
  const show = (value: 'update' | 'reset') => {
    setMode(value);
    setBranch(p.branch);
    setSha(commit || '');
    setExpected(p.sha);
    setError('');
    setOpen(true);
  };
  const submit = async () => {
    if (mode === 'reset' && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(sha.trim())) {
      setError('请输入本仓库已拉取提交的完整 SHA，也可以从提交记录中选择。');
      return;
    }
    await wb.act(`baseline:${p.id}`, async () => {
      try {
        await request(`/projects/${p.id}/baseline`, {
          expectedSha: expected,
          branch: branch.trim(),
          sha: mode === 'reset' ? sha.trim() : '',
        });
        await wb.refresh();
        setOpen(false);
        wb.setNotice('基线任务已提交，处理进度显示在项目中。');
      } catch (e) {
        setError((e as Error).message);
        throw e;
      }
    });
  };
  return (
    <>
      {commit ? (
        <Button
          type='text'
          size='small'
          disabled={busy || !!wb.pending || commit === p.sha}
          onClick={() => show('reset')}
        >
          设为基线
        </Button>
      ) : (
        <div className='actions'>
          <Button loading={busy} disabled={busy || !!wb.pending} onClick={() => show('update')}>
            {busy ? '更新基线中' : '更新基线'}
          </Button>
          <Button disabled={busy || !!wb.pending} onClick={() => show('reset')}>
            重置基线
          </Button>
        </div>
      )}
      <Modal
        visible={open}
        title='管理代码基线'
        width={580}

        alignCenter
        closable
        focusLock

        escToExit={!wb.pending}
        onCancel={() => !wb.pending && setOpen(false)}

        footer={
          <div className='actions'>
            <Button disabled={!!wb.pending} onClick={() => setOpen(false)}>
              取消
            </Button>
            <Button
              type='primary'
              loading={wb.pending === `baseline:${p.id}`}
              disabled={!!wb.pending || !branch.trim() || expected !== p.sha}
              onClick={() => void submit()}
            >
              {mode === 'update' ? '确认更新基线' : '确认重置基线'}
            </Button>
          </div>
        }
      >
        <Tabs
          activeTab={mode}

          onChange={(key) => {
            setMode(key as 'update' | 'reset');
            setError('');
          }}
        >
          <Tabs.TabPane key='update' title='更新到分支最新提交' />
          <Tabs.TabPane key='reset' title='重置到指定提交' />
        </Tabs>
        <Definition
          entries={[
            [
              '当前基线',
              <span>
                {p.branch} · <code>{expected.slice(0, 8)}</code>
              </span>,
            ],
            ['最近更新', date(p.baselineUpdatedAt || p.createdAt)],
          ]}
        />
        <Form layout='vertical'>
          <Form.Item label='目标分支'>
            <Input aria-label='基线目标分支' value={branch} onChange={(e) => setBranch(e)} />
          </Form.Item>
          {mode === 'reset' && (
            <>
              {!!p.baselineHistory?.length && (
                <Form.Item label='历史基线'>
                  <Select
                    aria-label='选择历史基线'
                    placeholder='选择此前保存的基线'
                    value={undefined}
                    options={p.baselineHistory.map((h, i) => ({
                      value: String(i),
                      label: `${h.branch} · ${h.sha.slice(0, 8)} · ${date(h.at)}`,
                    }))}
                    onChange={(value) => {
                      const h = p.baselineHistory![Number(value)];
                      setBranch(h.branch);
                      setSha(h.sha);
                    }}
                  />
                </Form.Item>
              )}
              <Form.Item label='目标提交 SHA'>
                <Input
                  aria-label='基线目标提交'
                  placeholder='完整提交 SHA，可从提交记录复制'
                  value={sha}
                  onChange={(e) => setSha(e)}
                />
              </Form.Item>
            </>
          )}
        </Form>
        <Callout>
          变更项目代码基线，并供新工作区使用。已有工作区保留原分支、文件及未提交修改；需要同步代码时，在 IDE 中执行 Git
          操作。
        </Callout>
        {expected !== p.sha && (
          <p role='alert' className='inline-error'>
            基线已被更新，请关闭后重新选择目标。
          </p>
        )}
        {error && (
          <p role='alert' className='inline-error'>
            {error}
          </p>
        )}
      </Modal>
    </>
  );
}
