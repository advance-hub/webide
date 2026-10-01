import { Button, Tag } from '@arco-design/web-react';
import { useState } from 'react';

import { Callout, Definition, PageHeader } from '../components/common';
import { Drawer } from '../components/overlays';
import { date } from '../domain';
import { CloudIcon } from '../icons';

import type { Navigation, Workbench } from '../use-workbench';

export function Environment({ wb, navigate }: { wb: Workbench; navigate: Navigation }) {
  const [guide, setGuide] = useState(false);
  const env = wb.catalog?.environment;
  return (
    <>
      <PageHeader title='开发环境' action={<Button onClick={() => setGuide(true)}>配置指引</Button>} />
      <div className='settings-body environment-settings'>
        <div className='settings-intro'>
          <h2>运行环境</h2>
          <p>查看项目使用的运行方式、默认规格与数据保存方式。</p>
        </div>
        <div className='connection-identity'>
          <span className='source-symbol'>
            <CloudIcon />
          </span>
          <div>
            <strong>{env?.driver === 'local' ? '本地直连驱动' : 'OpenSandbox 沙箱'}</strong>
            <p>{wb.checked ? `最近检测 ${date(wb.checked.at)}` : '尚未检测连接'}</p>
          </div>
          <Tag
            color={
              wb.checked?.status === 'connected' ? 'green' : wb.checked?.status === 'failed' ? 'orange' : undefined
            }
          >
            {wb.checked?.status === 'connected' ? '连接正常' : wb.checked?.status === 'failed' ? '连接异常' : '未检测'}
          </Tag>
          <Button loading={wb.pending === 'probe'} disabled={!!wb.pending} onClick={() => void wb.probe()}>
            检测连接
          </Button>
        </div>
        <div className='settings-section'>
          <div className='section-heading'>
            <h2>默认工作区</h2>
            {env?.driver === 'sandbox' && (
              <Tag color={env?.imageConfigured ? 'blue' : 'orange'}>
                {env?.imageConfigured ? '镜像已配置' : '镜像待配置'}
              </Tag>
            )}
          </div>
          <Definition
            entries={[
              ['编辑器', 'OpenSumi'],
              [
                '运行方式',
                env?.driver === 'local' ? '控制面主机直接运行（单租户/本地演示）' : 'OpenSandbox 沙箱内隔离运行',
              ],
              ['CPU / 内存', env && env.driver !== 'local' ? `${env.cpu} CPU / ${env.memory}` : '与控制面主机相同'],
              [
                '文件保存',
                env?.driver === 'local'
                  ? '主机数据目录，随工作区删除清理'
                  : env?.storageMode === 'retained'
                    ? '当前沙箱内保存'
                    : '5 GiB · 每人一台开发机使用持久卷',
              ],
              [
                '恢复方式',
                env?.driver === 'local'
                  ? '进程可随时停止与重启，文件不受影响'
                  : env?.storageMode === 'retained'
                    ? '可在工作区的「管理开发机」中备份与恢复；未备份的数据在沙箱丢失后无法找回'
                    : env?.storageClass || '集群默认 StorageClass',
              ],
              [
                '多用户隔离',
                env?.driver === 'local'
                  ? '⚠️ 同机执行，仅限可信用户'
                  : '按账号分配沙箱，最多 20 台；同一人的项目共用开发机',
              ],
            ]}
          />
          {env?.driver === 'sandbox' && !env?.imageConfigured && (
            <Callout
              tone='warning'
              action={
                <Button size='small' onClick={() => setGuide(true)}>
                  查看配置
                </Button>
              }
            >
              沙箱驱动需要先配置开发镜像；本地演示可切换 WORKBENCH_RUNTIME_DRIVER=local 直接运行。
            </Callout>
          )}
        </div>
        <div className='settings-section'>
          <div className='section-heading'>
            <h2>运行资源</h2>
          </div>
          <div className='environment-links'>
            <div>
              <div>
                <strong>开发镜像</strong>
                <p>查看通用开发镜像及其使用情况。</p>
              </div>
              <Button onClick={() => navigate('/images')}>查看镜像</Button>
            </div>
            {wb.config?.sandboxAdmin && (
              <div>
                <div>
                  <strong>沙箱</strong>
                  <p>查看工作区对应的沙箱实例与运行状态。</p>
                </div>
                <Button onClick={() => navigate('/sandbox-admin')}>查看沙箱</Button>
              </div>
            )}
          </div>
        </div>
      </div>
      <Drawer
        visible={guide}
        title='开发环境配置步骤'

        width='min(600px, 100vw)'
        onCancel={() => setGuide(false)}
        focusLock

        escToExit
        closable

        footer={<Button onClick={() => setGuide(false)}>返回环境</Button>}
      >
        <p className='overlay-description'>{'供部署人员完成服务端配置'}</p>
        <ol className='setup-guide'>
          <li>
            <h2>构建工作区镜像</h2>
            <p>在 OpenSumi 仓库根目录构建基础镜像，再构建工作区入口层。</p>
            <pre>
              docker build --platform linux/amd64 -t opensumi-workbench-base:dev .{'\n'}docker build -f
              application/runtime/Dockerfile -t opensumi-workspace:dev .
            </pre>
            <p>将镜像发布到集群可访问的仓库。</p>
          </li>
          <li>
            <h2>配置服务端环境变量</h2>
            <p>
              将 <code>OPEN_SANDBOX_IMAGE</code> 设置为已发布的镜像地址。如果集群没有默认存储类型，设置{' '}
              <code>OPEN_SANDBOX_STORAGE_CLASS</code>。
            </p>
            <p>重启工作台服务使配置生效。</p>
          </li>
          <li>
            <h2>验收工作区文件恢复</h2>
            <p>
              先创建工作区并验证编辑与终端，再验证停止与重新启动后未提交文件仍然存在。多用户集群部署请保持 sandbox
              驱动；本机演示或单租户可用 <code>WORKBENCH_RUNTIME_DRIVER=local</code> 直接运行。
            </p>
          </li>
        </ol>
        <Callout>
          完整部署参数与验证记录位于仓库的 <code>application/README.md</code>。
        </Callout>
      </Drawer>
    </>
  );
}
