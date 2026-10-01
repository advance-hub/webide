import React, { useCallback, useEffect, useState } from 'react';

import { Button } from '@opensumi/ide-components';

import styles from './cloud-dev.view.module.less';

interface AISettingsState {
  model: string;
  revision: string;
  connectedProviders: string[];
}

async function requestAISettings(payload?: { model: string; revision: string }): Promise<AISettingsState> {
  const response = await fetch('/__ide/ai/config', {
    method: payload ? 'POST' : 'GET',
    headers: payload ? { 'Content-Type': 'application/json' } : undefined,
    body: payload ? JSON.stringify(payload) : undefined,
    credentials: 'same-origin',
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'AI 配置暂时不可用');
  }
  return data as AISettingsState;
}

export const CloudDevAISettings: React.FC<{ onConnect: () => Promise<void>; onOpenAI: () => Promise<void> }> = ({
  onConnect,
  onOpenAI,
}) => {
  const [settings, setSettings] = useState<AISettingsState>();
  const [model, setModel] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [saved, setSaved] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await requestAISettings();
      setSettings(result);
      setModel(result.model);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!settings || saving) {
      return;
    }
    const nextModel = model.trim();
    if (nextModel && !/^[^\s/#]+\/[^\s#]+$/.test(nextModel)) {
      setError('模型 ID 应为 provider/model，例如 openai/gpt-5。');
      return;
    }
    setSaving(true);
    setError('');
    setSaved(false);
    try {
      const result = await requestAISettings({ model: nextModel, revision: settings.revision });
      setSettings({ ...settings, model: result.model, revision: result.revision });
      setModel(result.model);
      setSaved(true);
    } catch (cause) {
      setError((cause as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className={styles.aiSettings}>
      <div className={styles.settingsHeading}>
        <strong>OpenCode 设置</strong>
        <Button type='link' size='small' onClick={() => void refresh()} disabled={loading || saving}>
          刷新
        </Button>
      </div>
      {loading && <p className={styles.muted}>正在读取 AI 设置…</p>}
      {error && (
        <p className={styles.error} role='alert'>
          {error}
        </p>
      )}
      {settings && !loading && (
        <>
          <div className={styles.settingsGroup}>
            <span className={styles.settingsLabel}>账号连接</span>
            <div className={styles.providerStatus}>
              {settings.connectedProviders.length ? settings.connectedProviders.join('、') : '尚未保存服务商账号'}
            </div>
            <Button type='secondary' size='small' onClick={() => void onConnect()}>
              连接账号
            </Button>
            <p className={styles.hint}>在终端完成 OpenCode 登录；完成后点击刷新查看状态。</p>
          </div>
          <form className={styles.settingsGroup} onSubmit={(event) => void save(event)}>
            <label className={styles.settingsLabel} htmlFor='cloud-dev-ai-model'>
              默认模型
            </label>
            <input
              id='cloud-dev-ai-model'
              className={styles.settingsInput}
              value={model}
              onChange={(event) => {
                setModel(event.target.value);
                setSaved(false);
              }}
              placeholder='provider/model'
              spellCheck={false}
              autoComplete='off'
              aria-describedby='cloud-dev-ai-model-help'
            />
            <p className={styles.hint} id='cloud-dev-ai-model-help'>
              留空使用 OpenCode 默认模型。新会话采用此设置。
            </p>
            <div className={styles.settingsActions}>
              <Button
                type='primary'
                size='small'
                htmlType='submit'
                loading={saving}
                disabled={saving || model.trim() === settings.model}
              >
                保存模型
              </Button>
              {saved && (
                <span role='status' className={styles.saved}>
                  已保存
                </span>
              )}
            </div>
          </form>
          <Button type='link' size='small' onClick={() => void onOpenAI()}>
            打开 OpenCode 对话
          </Button>
        </>
      )}
    </div>
  );
};
