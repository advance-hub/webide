import { Button, Form, Input, Menu, Tag } from '@arco-design/web-react';
import { useEffect, useState } from 'react';

import { type Workspace } from '../../shared/contracts';
import { request } from '../api/client';
import { Callout, PageHeader } from '../components/common';

import type { Workbench } from '../state/use-workbench';

type ResourceId = 'nacos' | 'redis' | 'mysql' | 'rocketmq' | 'elasticsearch' | 'middleware' | 'cos';
interface Profile {
  id: ResourceId;
  endpoint?: string;
  database?: string;
  username?: string;
  options: Record<string, string>;
  bucket?: string;
  region?: string;
  prefix?: string;
  configured: boolean;
  hasPassword: boolean;
  hasSecretId: boolean;
  hasSecretKey: boolean;
}
type ProfileDetail = Profile & { password: string; secretId: string; secretKey: string };
interface Probe {
  status: 'ready' | 'failed';
  detail: string;
  latencyMs?: number;
}
interface COSList {
  prefixes: string[];
  objects: { key: string; size: number; lastModified: string }[];
  nextMarker: string;
  truncated: boolean;
  root: string;
}
interface COSText {
  key: string;
  content: string;
  contentType: string;
}

const definitions: { id: ResourceId; name: string; group: string; description: string }[] = [
  { id: 'nacos', name: 'Nacos', group: '配置与发现', description: '命名空间和控制台' },
  { id: 'redis', name: 'Redis', group: '数据服务', description: '逻辑 DB 与 ACL' },
  { id: 'mysql', name: 'MySQL', group: '数据服务', description: '数据库与账号' },
  { id: 'rocketmq', name: 'RocketMQ', group: '消息服务', description: 'NameServer 和 Dashboard' },
  { id: 'elasticsearch', name: 'Elasticsearch', group: '检索服务', description: '协议和索引范围' },
  { id: 'middleware', name: 'Middleware Config', group: '配置与发现', description: '服务路径与文档' },
  { id: 'cos', name: '腾讯云 COS', group: '对象存储', description: 'Bucket、目录与文本预览' },
];

const optionFields: Partial<Record<ResourceId, { key: string; label: string; hint?: string }[]>> = {
  nacos: [
    { key: 'scheme', label: '协议', hint: 'http 或 https' },
    { key: 'namespace', label: '命名空间' },
    { key: 'context_path', label: '控制台路径' },
  ],
  rocketmq: [{ key: 'dashboard_endpoint', label: 'Dashboard 地址', hint: 'host:port 或 https://…' }],
  elasticsearch: [
    { key: 'scheme', label: '协议', hint: 'http 或 https' },
    { key: 'index_pattern', label: '索引范围' },
  ],
  middleware: [
    { key: 'scheme', label: '协议', hint: 'http 或 https' },
    { key: 'health_path', label: '健康检查路径', hint: '可选，例如 /actuator/health' },
    { key: 'base_path', label: '服务路径' },
    { key: 'docs_path', label: '文档路径' },
  ],
  cos: [
    { key: 'config_prefix', label: '配置目录' },
    { key: 'environment_prefix', label: '环境目录' },
  ],
};

function safeConsoleURL(profile: Profile): string | undefined {
  if (!profile.configured) {
    return undefined;
  }
  let value = '';
  if (profile.id === 'nacos' || profile.id === 'middleware') {
    try {
      const parsed = new URL(`http://${profile.endpoint}`);
      const path =
        profile.id === 'nacos' ? profile.options.context_path || '/nacos' : profile.options.docs_path || '/doc.html';
      parsed.pathname = `/${path.replace(/^\/+/, '')}`;
      return parsed.href;
    } catch {
      return undefined;
    }
  }
  if (profile.id === 'rocketmq') {
    value = profile.options.dashboard_endpoint || '';
  }
  if (profile.id === 'elasticsearch') {
    value = `${profile.options.scheme || 'http'}://${profile.endpoint}`;
  }
  if (!value) {
    return undefined;
  }
  if (!/^https?:\/\//i.test(value)) {
    value = `http://${value}`;
  }
  try {
    const parsed = new URL(value);
    return ['http:', 'https:'].includes(parsed.protocol) ? parsed.href : undefined;
  } catch {
    return undefined;
  }
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  secret = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  secret?: boolean;
}) {
  return (
    <Form.Item label={label}>
      <Input
        aria-label={label}
        autoComplete={secret ? 'off' : undefined}
        spellCheck={!secret}
        value={value}
        placeholder={placeholder}
        onChange={(e) => onChange(e)}
      />
    </Form.Item>
  );
}

function COSBrowser({ profile, onError }: { profile: Profile; onError: (message: string) => void }) {
  const [prefix, setPrefix] = useState('');
  const [listing, setListing] = useState<COSList>();
  const [text, setText] = useState<COSText>();
  const [loading, setLoading] = useState(false);
  const [marker, setMarker] = useState('');
  const [items, setItems] = useState<COSList['objects']>([]);
  const load = async (nextPrefix: string, nextMarker = '') => {
    setLoading(true);
    setText(undefined);
    try {
      const params = new URLSearchParams({ prefix: nextPrefix });
      if (nextMarker) {
        params.set('marker', nextMarker);
      }
      const next = await request<COSList>(`/development-resources/cos/objects?${params}`);
      setPrefix(nextPrefix);
      setListing(next);
      setItems(nextMarker ? (previous) => [...previous, ...next.objects] : next.objects);
      setMarker(next.nextMarker || '');
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const preview = async (key: string) => {
    setLoading(true);
    try {
      setText(await request<COSText>(`/development-resources/cos/text?key=${encodeURIComponent(key)}`));
    } catch (error) {
      onError((error as Error).message);
    } finally {
      setLoading(false);
    }
  };
  const parent = prefix.split('/').slice(0, -1).join('/');
  return (
    <section className='development-objects' aria-label='COS 对象浏览'>
      <div className='development-section-heading'>
        <div>
          <h3>对象浏览</h3>
          <p>只列出当前前缀；选择文本对象后读取前 64 KiB。</p>
        </div>
        <Button
          disabled={!profile.configured || !profile.hasSecretId || !profile.hasSecretKey || loading}
          loading={loading}
          onClick={() => void load(prefix)}
        >
          读取对象
        </Button>
      </div>
      <div className='development-shortcuts'>
        {profile.options.config_prefix && (
          <Button
            type='text'
            size='small'
            disabled={!profile.configured || loading}
            onClick={() => void load(profile.options.config_prefix)}
          >
            团队配置目录
          </Button>
        )}
        {profile.options.environment_prefix && (
          <Button
            type='text'
            size='small'
            disabled={!profile.configured || loading}
            onClick={() => void load(profile.options.environment_prefix)}
          >
            环境目录
          </Button>
        )}
      </div>
      {listing && (
        <>
          <div className='development-path'>
            <Button type='text' size='small' onClick={() => void load('')}>
              根目录
            </Button>
            {prefix && (
              <>
                <span>/ {prefix}</span>
                <Button type='text' size='small' onClick={() => void load(parent)}>
                  上一级
                </Button>
              </>
            )}
          </div>
          <div className='development-object-list'>
            {listing.prefixes.map((item) => {
              const relative = item.slice(listing.root.length).replace(/\/$/, '');
              return (
                <Button key={item} type='text' className='development-object-row' onClick={() => void load(relative)}>
                  <span aria-hidden='true'>▸</span>
                  <strong>{relative.split('/').at(-1)}</strong>
                  <small>目录</small>
                </Button>
              );
            })}
            {items.map((item) => (
              <Button
                key={item.key}
                type='text'
                className='development-object-row'
                onClick={() => void preview(item.key)}
              >
                <span aria-hidden='true'>◇</span>
                <strong>{item.key.slice(listing.root.length).split('/').at(-1)}</strong>
                <small>{item.size.toLocaleString()} B</small>
              </Button>
            ))}
            {!listing.prefixes.length && !items.length && <p className='development-empty'>这个目录没有对象。</p>}
          </div>
          {listing.truncated && marker && (
            <Button disabled={loading} onClick={() => void load(prefix, marker)}>
              加载更多
            </Button>
          )}
        </>
      )}
      {text && (
        <div className='development-text-preview'>
          <div>
            <strong>{text.key}</strong>
            <span>{text.contentType || '文本'}</span>
          </div>
          <pre>{text.content}</pre>
        </div>
      )}
    </section>
  );
}

export function DevelopmentResources({ wb }: { wb: Workbench }) {
  const [profiles, setProfiles] = useState<Profile[]>();
  const [selected, setSelected] = useState<ResourceId>('nacos');
  const [draft, setDraft] = useState<Profile>();
  const [password, setPassword] = useState('');
  const [secretID, setSecretID] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [initialSecrets, setInitialSecrets] = useState({ password: '', secretId: '', secretKey: '' });
  const [secretLoaded, setSecretLoaded] = useState(false);
  const [busy, setBusy] = useState<'save' | 'probe'>();
  const [checkingAll, setCheckingAll] = useState(false);
  const [probes, setProbes] = useState<Partial<Record<ResourceId, Probe>>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    void request<Profile[]>('/development-resources')
      .then((items) => {
        if (active) {
          setProfiles(items);
        }
      })
      .catch((e: Error) => {
        if (active) {
          setError(e.message);
        }
      });
    return () => {
      active = false;
    };
  }, [revision]);
  useEffect(() => {
    const item = profiles?.find((profile) => profile.id === selected);
    setDraft(item ? { ...item, options: { ...item.options } } : undefined);
    setPassword('');
    setSecretID('');
    setSecretKey('');
    setError('');
    setSecretLoaded(false);
    if (!item) {
      return;
    }
    let active = true;
    void request<ProfileDetail>(`/development-resources/${selected}`)
      .then((detail) => {
        if (!active) {
          return;
        }
        setDraft({ ...detail, options: { ...detail.options } });
        setPassword(detail.password || '');
        setSecretID(detail.secretId || '');
        setSecretKey(detail.secretKey || '');
        setInitialSecrets({
          password: detail.password || '',
          secretId: detail.secretId || '',
          secretKey: detail.secretKey || '',
        });
        setSecretLoaded(true);
      })
      .catch((e: Error) => {
        if (active) {
          setError(e.message);
        }
      });
    return () => {
      active = false;
    };
  }, [selected, profiles]);
  const profile = profiles?.find((item) => item.id === selected);
  const definition = definitions.find((item) => item.id === selected)!;
  const update = (field: keyof Profile, value: string) =>
    setDraft((current) => (current ? { ...current, [field]: value } : current));
  const option = (key: string, value: string) =>
    setDraft((current) => (current ? { ...current, options: { ...current.options, [key]: value } } : current));
  const check = async (id: ResourceId) => {
    setBusy('probe');
    setError('');
    try {
      const result = await request<Probe>(`/development-resources/${id}/probe`, {});
      setProbes((current) => ({ ...current, [id]: result }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const checkAll = async () => {
    setCheckingAll(true);
    setError('');
    await Promise.all(
      definitions.map(async ({ id }) => {
        if (!profiles?.find((item) => item.id === id)?.configured) {
          return;
        }
        try {
          const result = await request<Probe>(`/development-resources/${id}/probe`, {});
          setProbes((current) => ({ ...current, [id]: result }));
        } catch (e) {
          setProbes((current) => ({ ...current, [id]: { status: 'failed', detail: (e as Error).message } }));
        }
      }),
    );
    setCheckingAll(false);
  };
  const save = async () => {
    if (!draft) {
      return;
    }
    setBusy('save');
    setError('');
    setNotice('');
    try {
      const targetChanged =
        selected === 'cos'
          ? draft.bucket !== profile?.bucket || draft.region !== profile?.region
          : draft.endpoint !== profile?.endpoint;
      const nextPassword = targetChanged && password === initialSecrets.password ? '' : password;
      const nextSecretID = targetChanged && secretID === initialSecrets.secretId ? '' : secretID;
      const nextSecretKey = targetChanged && secretKey === initialSecrets.secretKey ? '' : secretKey;
      const next = await request<Profile>(`/development-resources/${selected}`, {
        endpoint: draft.endpoint || '',
        database: draft.database || '',
        username: draft.username || '',
        options: draft.options,
        bucket: draft.bucket || '',
        region: draft.region || '',
        prefix: draft.prefix || '',
        password: nextPassword,
        secretId: nextSecretID,
        secretKey: nextSecretKey,
        clearPassword: !!profile?.hasPassword && !nextPassword,
        clearSecretId: !!profile?.hasSecretId && !nextSecretID,
        clearSecretKey: !!profile?.hasSecretKey && !nextSecretKey,
      });
      setProfiles((current) => current?.map((item) => (item.id === selected ? next : item)));
      setNotice(`${definition.name} 连接已保存。`);
      setProbes((current) => ({ ...current, [selected]: undefined }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(undefined);
    }
  };
  const readyWorkspaces = wb.workspaces.filter((item: Workspace) => item.status === 'ready');
  const consoleURL = profile && safeConsoleURL(profile);
  return (
    <>
      <PageHeader
        title='开发资源'
        description='统一维护数据库、配置中心、消息服务与对象存储连接，保存后可同步到工作区。'
        action={
          <Button loading={checkingAll} disabled={!profiles || !!busy || checkingAll} onClick={() => void checkAll()}>
            检测全部连接
          </Button>
        }
      />
      {error && (
        <Callout
          tone='warning'
          title='操作未完成'
          action={!profiles ? <Button onClick={() => setRevision((value) => value + 1)}>重试</Button> : undefined}
        >
          {error}
        </Callout>
      )}
      {notice && <Callout tone='success'>{notice}</Callout>}
      {!profiles || !draft ? (
        <div className='loading-skeleton' role='status' aria-label='正在读取开发资源'>
          <div />
          <div />
        </div>
      ) : (
        <div className='development-layout'>
          <Menu
            className='development-list'
            aria-label='开发资源列表'
            selectedKeys={[selected]}
            onClickMenuItem={(key) => {
              setNotice('');
              setSelected(key as ResourceId);
            }}
          >
            {definitions.map((item) => {
              const current = profiles.find((resource) => resource.id === item.id);
              const checked = probes[item.id];
              return (
                <Menu.Item key={item.id} className='development-list-item'>
                  <span>
                    <strong>{item.name}</strong>
                    <small>
                      {item.group} · {item.description}
                    </small>
                  </span>
                  <span
                    className={`development-state${checked?.status === 'ready' ? ' is-ready' : checked?.status === 'failed' ? ' is-failed' : ''}`}
                    aria-label={checked?.detail || (current?.configured ? '已配置，未检查' : '模板未启用')}
                  />
                </Menu.Item>
              );
            })}
          </Menu>
          <div className='development-detail'>
            <header className='development-detail-header'>
              <div>
                <span className='eyebrow'>{definition.group}</span>
                <h2>{definition.name}</h2>
                <p>{definition.description}</p>
              </div>
              <Tag
                color={
                  probes[selected]?.status === 'ready'
                    ? 'green'
                    : probes[selected]?.status === 'failed'
                      ? 'orange'
                      : profile?.configured
                        ? 'blue'
                        : undefined
                }
              >
                {probes[selected]?.status === 'ready'
                  ? '连接正常'
                  : probes[selected]?.status === 'failed'
                    ? '检查失败'
                    : profile?.configured
                      ? '已配置'
                      : '模板'}
              </Tag>
            </header>
            <div className='development-actions'>
              <Button
                type='primary'
                loading={busy === 'save'}
                disabled={!!busy || checkingAll || !secretLoaded}
                onClick={() => void save()}
              >
                保存连接
              </Button>
              <Button
                loading={busy === 'probe'}
                disabled={!!busy || checkingAll || !profile?.configured}
                onClick={() => void check(selected)}
              >
                检查连接
              </Button>
              {consoleURL && (
                <Button href={consoleURL} target='_blank' rel='noopener noreferrer'>
                  打开控制台
                </Button>
              )}
            </div>
            {probes[selected] && (
              <p className={`development-probe is-${probes[selected]?.status}`} role='status'>
                {probes[selected]?.detail}
                {probes[selected]?.latencyMs != null ? ` · ${probes[selected]?.latencyMs} ms` : ''}
              </p>
            )}
            <Form layout='vertical' className='development-form' onSubmit={() => void save()}>
              {selected === 'cos' ? (
                <>
                  <div className='development-form-grid'>
                    <Field label='Bucket' value={draft.bucket || ''} onChange={(value) => update('bucket', value)} />
                    <Field label='Region' value={draft.region || ''} onChange={(value) => update('region', value)} />
                    <Field label='受管前缀' value={draft.prefix || ''} onChange={(value) => update('prefix', value)} />
                  </div>
                  <div className='development-form-grid'>
                    <Field
                      label='SecretId'
                      secret
                      value={secretID}
                      onChange={setSecretID}
                      placeholder='填写当前账号 SecretId'
                    />
                    <Field
                      label='SecretKey'
                      secret
                      value={secretKey}
                      onChange={setSecretKey}
                      placeholder='填写当前账号 SecretKey'
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className='development-form-grid'>
                    <Field
                      label='连接地址'
                      value={draft.endpoint || ''}
                      onChange={(value) => update('endpoint', value)}
                      placeholder='host:port'
                    />
                    {(selected === 'mysql' || selected === 'redis') && (
                      <Field
                        label={selected === 'mysql' ? '数据库' : '逻辑 DB'}
                        value={draft.database || ''}
                        onChange={(value) => update('database', value)}
                      />
                    )}
                    <Field
                      label='用户名'
                      value={draft.username || ''}
                      onChange={(value) => update('username', value)}
                    />
                    <Field label='密码' secret value={password} onChange={setPassword} placeholder='未启用认证可留空' />
                  </div>
                </>
              )}
              {!!optionFields[selected]?.length && (
                <div className='development-form-grid'>
                  {optionFields[selected]?.map((field) => (
                    <Field
                      key={field.key}
                      label={field.label}
                      value={draft.options[field.key] || ''}
                      onChange={(value) => option(field.key, value)}
                      placeholder={field.hint}
                    />
                  ))}
                </div>
              )}
              <p className='field-help'>
                连接值按当前账号加密保存，不写入 Git 仓库或镜像。密码与密钥会在此表单回填；更换地址、Bucket 或 Region
                时需重新填写凭据。
              </p>
            </Form>
            {(selected === 'mysql' || selected === 'redis') && (
              <section className='development-tool'>
                <div>
                  <h3>在编辑器中浏览</h3>
                  <p>
                    {selected === 'mysql' ? 'SQLTools 和 MySQL 驱动' : 'Redis Live'} 已预装在
                    IDE；保存此资源后重启个人工作区即可预置连接，也可在插件里修改或新增。
                  </p>
                </div>
                {readyWorkspaces.length === 1 ? (
                  <Button disabled={!!wb.pending} onClick={() => void wb.enter(readyWorkspaces[0])}>
                    进入 {readyWorkspaces[0].branch} IDE
                  </Button>
                ) : (
                  <Button href='#/workspaces'>选择工作区</Button>
                )}
              </section>
            )}
            {selected === 'nacos' && (
              <p className='development-tool-note'>IDE 终端已预装 nacos-cli；可使用控制台管理命名空间与配置。</p>
            )}
            {selected === 'cos' && (
              <COSBrowser
                key={`${profile?.bucket}:${profile?.region}:${profile?.prefix}`}
                profile={profile!}
                onError={setError}
              />
            )}
          </div>
        </div>
      )}
    </>
  );
}
