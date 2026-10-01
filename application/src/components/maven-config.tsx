import { Button, Input, Select } from '@arco-design/web-react';
import { useState } from 'react';

import { type MavenOptions, request } from '../domain';

import { Callout } from './common';
interface Preset { name: string; action: string; options: MavenOptions }
interface Configuration { xml: string; revision: string; jdk: string; jdks: string[]; presets: Preset[] }
export function MavenConfiguration({
  id,
  disabled,
  action,
  options,
  onPreset,
}: {
  id: string;
  disabled: boolean;
  action: string;
  options: MavenOptions;
  onPreset: (value: Preset) => void;
}) {
  const [config, setConfig] = useState<Configuration>();
    const [xml, setXML] = useState('');
    const [jdk, setJDK] = useState('21');
    const [name, setName] = useState('');
    const [pending, setPending] = useState(false);
    const [error, setError] = useState('');
    const [message, setMessage] = useState('');
  const run = async (action: string, extra: object = {}) => {
    if (pending) {return;}
    setPending(true);
    setError('');
    setMessage('');
    try {
      const r = await request<Configuration>(`/workspaces/${id}/maven-config`, { action, ...extra });
      setConfig(r);
      setXML(r.xml);
      setJDK(r.jdk);
      if (action !== 'read') {setMessage('配置已保存。');}
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setPending(false);
    }
  };
  const busy = disabled || pending;
  return (
    <section>
      <div className='tool-heading'>
        <h2>配置与构建方案</h2>
        <Button disabled={busy} loading={pending} onClick={() => void run('read')}>
          {config ? '重新读取' : '读取配置'}
        </Button>
      </div>
      {error && (
        <Callout tone='warning' title='保存未完成'>
          {error}
        </Callout>
      )}
      {message && <p role='status'>{message}</p>}
      {config ? (
        <>
          <label className='field-label' htmlFor={`jdk-default-${id}`}>
            项目默认 JDK
          </label>
          <div className='maven-pom-row'>
            <Select
              id={`jdk-default-${id}`}
              style={{ width: '100%' }}
              value={jdk}
              options={config.jdks.map((value) => ({ value, label: `JDK ${value}` }))}
              onChange={(v) => setJDK(String(v))}
            />
            <Button disabled={busy} onClick={() => void run('save-jdk', { jdk })}>
              保存 JDK
            </Button>
          </div>
          <p className='subtle'>用于后续构建和启动任务。终端重开后生效；Java 语言服务固定使用 JDK 21。</p>
          <label className='field-label' htmlFor={`preset-name-${id}`}>
            保存当前构建选项
          </label>
          <div className='maven-pom-row'>
            <Input
              id={`preset-name-${id}`}
              value={name}
              maxLength={120}
              placeholder='例如 CI 校验 / 本地调试'
              onChange={(e) => setName(e)}
            />
            <Button
              disabled={busy || !name.trim()}
              onClick={() =>
                void run('save-presets', {
                  presets: [
                    ...config.presets.filter((p) => p.name !== name.trim()),
                    { name: name.trim(), action, options },
                  ],
                })
              }
            >
              保存方案
            </Button>
          </div>
          {config.presets.map((p) => (
            <div className='service-row' key={p.name}>
              <strong>{p.name}</strong>
              <div className='tool-actions'>
                <Button size='small' disabled={busy} onClick={() => onPreset(p)}>
                  使用
                </Button>
                <Button
                  size='small'
                  disabled={busy}
                  onClick={() =>
                    void run('save-presets', { presets: config.presets.filter((item) => item.name !== p.name) })
                  }
                >
                  移除
                </Button>
              </div>
            </div>
          ))}
          <details className='settings-detail'>
            <summary>编辑 settings.xml</summary>
            <p>镜像、私服、账号与 Profiles 可直接修改。保存后作为个人配置保留，不再被团队自动同步覆盖。</p>
            <Input.TextArea
              className='tool-editor'
              aria-label='Maven settings.xml'
              spellCheck={false}
              rows={18}
              value={xml}
              onChange={(e) => setXML(e)}
            />
            <div className='tool-actions'>
              <Button
                type='primary'
                disabled={busy}
                onClick={() => void run('save-settings', { xml, revision: config.revision })}
              >
                保存 settings.xml
              </Button>
            </div>
          </details>
        </>
      ) : (
        <p className='subtle'>读取后可编辑私服配置、设置默认 JDK，保存和复用构建方案。</p>
      )}
    </section>
  );
}
