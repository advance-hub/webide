import { Button, Form, Input, Select } from '@arco-design/web-react';
import { useState } from 'react';

import { PageHeader } from '../components/common';
import { type Project, projectHref, repository, request } from '../domain';
import { BackIcon, BranchIcon } from '../icons';

import type { Navigation, Workbench } from '../use-workbench';

interface Draft {
  name: string;
  url: string;
  branch: string;
}
function readDraft(key: string): Draft {
  try {
    return {
      name: '',
      url: '',
      branch: 'main',
      ...JSON.parse(sessionStorage.getItem(key) || '{}'),
    };
  } catch {
    return { name: '', url: '', branch: 'main' };
  }
}
export function ImportProject({ wb, navigate }: { wb: Workbench; navigate: Navigation }) {
  const draftKey = `workbench-import-draft:${wb.user?.id}`;
  const [draft, setDraft] = useState(() => readDraft(draftKey));
  const [validation, setValidation] = useState('');
  const [custom, setCustom] = useState(false);
  const [instance, setInstance] = useState(wb.config?.gitlabURL || '');
  const [token, setToken] = useState('');
  const update = (values: Partial<Draft>) => {
    const next = { ...draft, ...values };
    setDraft(next);
    setValidation('');
    try {
      let savedURL = next.url;
      try {
        const parsed = new URL(next.url);
        if (parsed.username || parsed.password || parsed.search) {
          savedURL = '';
        }
      } catch {
        /* incomplete address */
      }
      sessionStorage.setItem(draftKey, JSON.stringify({ ...next, url: savedURL }));
    } catch {
      /* The form still works when storage is unavailable. */
    }
  };
  const submit = async () => {
    const input = { name: draft.name.trim(), url: draft.url.trim(), branch: draft.branch.trim() };
    try {
      const url = new URL(input.url);
      if (
        url.origin !== new URL(custom ? instance : wb.config!.gitlabURL).origin ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !['http:', 'https:'].includes(url.protocol)
      ) {
        throw new Error();
      }
    } catch {
      setValidation('请输入当前代码源下的 HTTP(S) 仓库地址，不包含令牌或查询参数。');
      document.getElementById('repository-url')?.focus();
      return;
    }
    if (new TextEncoder().encode(input.name).length > 120) {
      setValidation('项目名称过长，请控制在 120 字节以内（约 40 个汉字）。');
      document.getElementById('project-name')?.focus();
      return;
    }
    await wb.act('import', async () => {
      const p = await request<Project>('/projects', {
        ...input,
        ...(custom ? { connection: { url: instance, token } } : {}),
      });
      await wb.refresh();
      try {
        sessionStorage.removeItem(draftKey);
      } catch {
        /* optional storage */
      }
      navigate(projectHref(p.id));
      wb.setNotice('项目已加入导入队列，完成后即可准备工作区。');
    });
  };
  return (
    <>
      <Button type='text' className='back-link' icon={<BackIcon />} onClick={() => navigate('/projects')}>
        返回项目
      </Button>
      <PageHeader title='导入项目' description='先连接仓库。创建工作区时再选择开发分支，并拉取该分支的最新提交。' />
      <div className='import-layout'>
        <section className='import-form-surface'>
          <div className='import-source'>
            <span className='source-symbol'>
              <BranchIcon />
            </span>
            <div>
              <strong>代码仓库</strong>
              <p>{wb.config?.gitlabURL}</p>
            </div>
            <Button type='text' onClick={() => navigate('/connection')}>
              管理代码源
            </Button>
          </div>
          <Form layout='vertical' onSubmit={submit}>
            <Form.Item label='代码源'>
              <Select
                aria-label='导入代码源'
                value={custom ? 'custom' : 'default'}
                options={[
                  { value: 'default', label: '继承全局代码源' },
                  { value: 'custom', label: '为此项目单独配置' },
                ]}
                onChange={(value) => setCustom(value === 'custom')}
              />
            </Form.Item>
            {custom && (
              <>
                <Form.Item label='项目代码托管地址'>
                  <Input
                    aria-label='项目代码托管地址'
                    value={instance}
                    onChange={(e) => setInstance(e)}
                    placeholder='https://gitee.com 或 https://gitlab.example.com'
                    required
                  />
                </Form.Item>
                <Form.Item label='项目访问令牌'>
                  <Input.Password
                    aria-label='项目访问令牌'
                    value={token}
                    onChange={(e) => setToken(e)}
                    autoComplete='off'
                    required
                  />
                  <p className='field-help'>仅用于此项目，加密保存；令牌需允许读取、推送和创建合并请求。</p>
                </Form.Item>
              </>
            )}

            <Form.Item label='仓库地址'>
              <Input
                id='repository-url'
                aria-label='仓库地址'
                placeholder={`${wb.config?.gitlabURL || 'https://gitlab.com'}/group/project.git`}
                value={draft.url}
                onChange={(e) => update({ url: e })}
                onBlur={() => {
                  if (!draft.name && draft.url.trim()) {
                    update({ name: repository(draft.url.trim()).split('/').pop() || '' });
                  }
                }}
                autoComplete='off'
                required
              />
              <p className='field-help'>粘贴仓库的 HTTPS 克隆地址。默认使用全局代码源令牌。</p>
            </Form.Item>
            <Form.Item label='项目名称'>
              <Input
                id='project-name'
                aria-label='项目名称'
                placeholder='例如：订单服务'
                value={draft.name}
                onChange={(e) => update({ name: e })}
                required
              />
              <p className='field-help'>显示在工作台项目列表中，不修改远端仓库名称。</p>
            </Form.Item>
            <Form.Item label='基线分支'>
              <Input
                aria-label='基线分支'
                placeholder='main'
                value={draft.branch}
                onChange={(e) => update({ branch: e })}
                required
              />
              <p className='field-help'>使用远端已存在的分支；个人工作区首次从此分支初始化。</p>
            </Form.Item>
            {validation && (
              <p role='alert' className='inline-error'>
                {validation}
              </p>
            )}
            <div className='form-footer'>
              <span className='subtle'>导入仅拉取仓库，不启动沙箱。</span>
              <Button
                type='primary'
                htmlType='submit'
                loading={wb.pending === 'import'}
                disabled={
                  !draft.name.trim() ||
                  !draft.url.trim() ||
                  !draft.branch.trim() ||
                  (custom && (!instance.trim() || !token.trim())) ||
                  !!wb.pending
                }
              >
                导入项目
              </Button>
            </div>
          </Form>
        </section>
        <aside className='import-guide' aria-label='接下来的步骤'>
          <h2>接下来</h2>
          <ol>
            <li>
              <strong>导入仓库</strong>
              <span>验证地址与令牌，建立可浏览的代码基线。</span>
            </li>
            <li>
              <strong>选择分支</strong>
              <span>从远端分支进入，或从起点创建新开发分支。</span>
            </li>
            <li>
              <strong>进入 IDE</strong>
              <span>通用镜像启动沙箱，开发完成后推送并创建 MR。</span>
            </li>
          </ol>
        </aside>
      </div>
    </>
  );
}
