import { Button } from '@arco-design/web-react';
import { useState } from 'react';

import { request } from '../domain';
import { CloudIcon } from '../icons';

import { Callout } from './common';
import { MachineManagement } from './machine-management';
import { Modal } from './overlays';

import type { Workbench } from '../use-workbench';

export function PersonalMachine({ wb }: { wb: Workbench }) {
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState('');
  const overview = wb.machine;
  if (wb.config?.driver !== 'sandbox' || !overview) {return null;}
  const release = () =>
    void wb.act('release-machine', async () => {
      setError('');
      try {
        await request('/machine/release', {});
        await wb.refresh();
        setConfirm(false);
        wb.setNotice('个人开发机已回收，名额已释放。');
      } catch (e) {
        setError((e as Error).message);
        throw e;
      }
    });
  return (
    <>
      <section className='personal-machine' aria-label='我的开发机'>
        <CloudIcon />
        <div className='personal-machine-info'>
          <strong>我的开发机</strong>
          <span>
            {overview.machine
              ? `${overview.workspaces} 个工作区 · Maven 缓存持久保存`
              : '创建工作区时分配，后续项目自动复用'}
          </span>
          {overview.legacyWorkspaces > 0 && <span>{overview.legacyWorkspaces} 个旧工作区待迁入，文件仍在原沙箱中</span>}
        </div>
        <span className='personal-machine-capacity'>
          平台已用 {overview.allocated} / {overview.limit} 台
        </span>
        {overview.machine && <MachineManagement wb={wb} />}
        {overview.machine && (
          <Button
            size='small'
            type='text'
            disabled={!!wb.pending || overview.workspaces > 0}
            title={overview.workspaces > 0 ? '先删除开发机内的工作区，再回收开发机' : undefined}
            onClick={() => setConfirm(true)}
          >
            回收开发机
          </Button>
        )}
      </section>
      <Modal
        visible={confirm}
        title='回收个人开发机'
        width={480}
        alignCenter
        closable
        focusLock
        onCancel={() => !wb.pending && setConfirm(false)}
        footer={
          <div className='drawer-actions'>
            <Button disabled={!!wb.pending} onClick={() => setConfirm(false)}>
              取消
            </Button>
            <Button
              type='primary'
              status='danger'
              loading={wb.pending === 'release-machine'}
              disabled={!!wb.pending}
              onClick={release}
            >
              确认回收
            </Button>
          </div>
        }
      >
        <Callout tone='warning' title='删除开发机与缓存'>
          此开发机中已没有工作区。回收会删除保留的个人配置、Git 对象和 Maven 缓存，并释放一个名额。
        </Callout>
        {error && <p role='alert'>{error}</p>}
      </Modal>
    </>
  );
}
