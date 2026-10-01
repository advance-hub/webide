import { Button, Form, Input, Select, Tag } from '@arco-design/web-react';
import { useEffect, useState } from 'react';

import { Callout, PageHeader } from '../components/common';
import { type Project, request } from '../domain';
import { LockIcon } from '../icons';

import type { Navigation, Workbench } from '../use-workbench';

interface ConnectionInfo {
  url: string;
  configured: boolean;
  account: string;
  inherited: boolean;
  canManage: boolean;
}
export function GitConnectionForm({ wb, project }: { wb: Workbench; project?: Project }) {
  const endpoint = `/connections/gitlab${project ? `?projectId=${project.id}` : ''}`;
  const [connection, setConnection] = useState<ConnectionInfo>();
  const [url, setURL] = useState('');
  const [token, setToken] = useState('');
  const [inherit, setInherit] = useState(!!project);
  const [loadError, setLoadError] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    setConnection(undefined);
    setToken('');
    setLoadError('');
    void request<ConnectionInfo>(endpoint)
      .then((result) => {
        if (active) {
          setConnection(result);
          setURL(result.url);
          setInherit(result.inherited);
        }
      })
      .catch((e: Error) => {
        if (active) {
          setLoadError(e.message);
        }
      });
    return () => {
      active = false;
    };
  }, [endpoint, revision]);
  const save = async () => {
    const ok = await wb.act('save-connection', async () => {
      await request(endpoint, { url: url.trim(), token: token.trim(), inherit: !!project && inherit });
      setToken('');
      await wb.reloadConfig();
      wb.setNotice(project ? '项目代码源已保存' : '全局代码源已保存，未覆盖的项目将自动使用此配置');
    });
    if (ok) {
      setRevision((v) => v + 1);
    }
  };
  if (loadError) {
    return (
      <Callout tone='warning' action={<Button onClick={() => setRevision((v) => v + 1)}>重试</Button>}>
        {loadError}
      </Callout>
    );
  }
  if (!connection) {
    return (
      <div className='loading-skeleton' role='status' aria-label='正在读取代码源'>
        <div />
      </div>
    );
  }
  return (
    <>
      <div className='section-heading'>
        <h2>{project ? '项目代码源' : '全局默认代码源'}</h2>
        <Tag color={connection.configured ? 'green' : undefined}>
          {connection.configured ? `已配置 · ${connection.account}` : '未配置'}
        </Tag>
      </div>
      {!project && (
        <p className='settings-description'>
          设置一次 GitLab 或 Gitee 地址和访问令牌，项目默认继承。需要使用其他账号或实例时，可在项目中覆盖。
        </p>
      )}
      <Form layout='vertical' onSubmit={save} className='connection-form'>
        {project && (
          <Form.Item label='配置方式'>
            <Select
              aria-label='项目代码源配置方式'
              value={inherit ? 'inherit' : 'custom'}
              options={[
                { value: 'inherit', label: '继承全局配置' },
                { value: 'custom', label: '项目独立配置' },
              ]}
              onChange={(v) => {
                setInherit(v === 'inherit');
                if (v === 'custom') {
                  try {
                    setURL(new URL(project.url).origin);
                  } catch {
                    /* invalid legacy URL */
                  }
                }
              }}
            />
          </Form.Item>
        )}
        {!project || !inherit ? (
          <>
            <Form.Item label='代码托管地址'>
              <Input
                aria-label='代码托管地址'
                placeholder='https://gitee.com 或 https://gitlab.example.com'
                value={url}
                onChange={(e) => setURL(e)}
                readOnly={!connection.canManage}
                required
              />
            </Form.Item>
            <Form.Item label='访问令牌 Token'>
              <Input.Password
                aria-label='访问令牌 Token'
                placeholder={
                  connection.configured && connection.url === url
                    ? '已加密保存，留空保持现有令牌'
                    : '粘贴代码托管平台的访问令牌'
                }
                value={token}
                onChange={(e) => setToken(e)}
                autoComplete='off'
                readOnly={!connection.canManage}
              />
              <p className='field-help'>令牌需要读取仓库、推送和创建合并请求的权限。令牌不会回显。</p>
            </Form.Item>
          </>
        ) : (
          <div className='inherited-connection'>
            <span className='muted'>全局实例</span>
            <strong>{wb.config?.gitlabURL}</strong>
            <span className='subtle'>项目使用全局保存的访问令牌。</span>
          </div>
        )}
        <div className='connection-submit'>
          <Button
            type='primary'
            htmlType='submit'
            loading={wb.pending === 'save-connection'}
            disabled={
              !!wb.pending ||
              !connection.canManage ||
              ((!project || !inherit) &&
                (!url.trim() || (!token.trim() && (!connection.configured || connection.url !== url))))
            }
          >
            {project && inherit ? '使用全局配置' : '验证并保存'}
          </Button>
          <span className='subtle'>
            <LockIcon /> 服务端加密保存
          </span>
        </div>
        {!connection.canManage && (
          <p className='field-help'>全局配置由创建它的管理员维护，你可以设置自己的项目代码源。</p>
        )}
      </Form>
    </>
  );
}
function AccountLogin({ wb }: { wb: Workbench }) {
  const [token, setToken] = useState('');
  return (
    <div className='settings-body'>
      <Callout>工作台身份与代码源配置分别管理。请使用当前实例的个人令牌登录。</Callout>
      <Form
        layout='vertical'
        onSubmit={async () => {
          await wb.act('login', async () => {
            await request('/login', { token: token.trim() });
            setToken('');
            await wb.boot();
          });
        }}
      >
        <Form.Item label='个人登录令牌'>
          <Input.Password aria-label='个人登录令牌' value={token} onChange={(e) => setToken(e)} autoComplete='off' />
        </Form.Item>
        <Button
          type='primary'
          htmlType='submit'
          disabled={!token.trim() || !!wb.pending}
          loading={wb.pending === 'login'}
        >
          登录工作台
        </Button>
      </Form>
    </div>
  );
}
export function Connection({ wb }: { wb: Workbench; navigate: Navigation }) {
  return (
    <>
      <PageHeader title='代码源' description='连接 GitLab 或 Gitee，供仓库导入、分支拉取和合并请求发布使用。' />
      {wb.user ? (
        <div className='settings-body'>
          <GitConnectionForm wb={wb} />
          <div className='settings-section'>
            <h2>配置优先级</h2>
            <p>项目独立配置 → 全局默认配置。修改全局代码源不会改写已导入的仓库；实例不匹配的项目需要单独配置。</p>
          </div>
        </div>
      ) : (
        <AccountLogin wb={wb} />
      )}
    </>
  );
}
