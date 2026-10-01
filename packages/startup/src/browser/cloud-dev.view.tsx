import React, { useEffect, useState } from 'react';

import { Button } from '@opensumi/ide-components';
import { useInjectable } from '@opensumi/ide-core-browser';

import { CloudDevAISettings } from './cloud-dev-ai-settings';
import { CloudDevContribution } from './cloud-dev.contribution';
import styles from './cloud-dev.view.module.less';

const applicationLabels = {
  preparing: '准备中',
  notConfigured: '未配置启动',
  stopped: '未运行',
  error: '启动失败',
  ready: '运行中',
};

export const CloudDevView: React.FC = () => {
  const cloudDev = useInjectable<CloudDevContribution>(CloudDevContribution);
  const [state, setState] = useState(cloudDev.snapshot);
  const [aiSettingsOpen, setAISettingsOpen] = useState(false);

  useEffect(() => {
    const disposable = cloudDev.onDidChange(() => setState(cloudDev.snapshot));
    if (!cloudDev.snapshot.context && !cloudDev.snapshot.loading) {
      void cloudDev.refresh();
    }
    return () => disposable.dispose();
  }, [cloudDev]);

  useEffect(() => {
    if (state.aiSettingsRequestId) {
      setAISettingsOpen(true);
    }
  }, [state.aiSettingsRequestId]);

  const { context, error, loading, publishing } = state;

  return (
    <section className={styles.panel} aria-label='云开发工作区'>
      <div className={styles.heading}>
        <span>工作区</span>
        <Button
          type='link'
          size='small'
          onClick={() => void cloudDev.refresh()}
          disabled={loading}
          aria-label='刷新工作区状态'
        >
          {loading ? '刷新中…' : '刷新'}
        </Button>
      </div>

      {error && (
        <div className={styles.error} role='alert'>
          状态暂时无法读取：{error}
          <Button type='link' size='small' onClick={() => void cloudDev.refresh()}>
            重试
          </Button>
        </div>
      )}

      {!context && !error && <p className={styles.muted}>正在读取工作区…</p>}

      {context && (
        <>
          <div className={styles.projectName} title={context.projectName}>
            {context.projectName}
          </div>
          <dl className={styles.facts}>
            <div>
              <dt>开发分支</dt>
              <dd title={context.branch}>{context.branch}</dd>
            </div>
            <div>
              <dt>目标分支</dt>
              <dd title={context.targetBranch}>{context.targetBranch}</dd>
            </div>
            {context.baselineSha && (
              <div>
                <dt>拉取版本</dt>
                <dd className={styles.mono}>{context.baselineSha.slice(0, 8)}</dd>
              </div>
            )}
          </dl>

          <div className={styles.section}>
            <div className={styles.sectionHeading}>应用</div>
            <div className={styles.stateLine}>
              <span className={`${styles.dot} ${context.previewReady ? styles.ready : ''}`} aria-hidden='true' />
              <span>{applicationLabels[context.applicationStatus] || '状态未知'}</span>
            </div>
            {context.previewReady ? (
              <Button type='secondary' size='small' onClick={() => void cloudDev.openPreview()}>
                打开预览
              </Button>
            ) : (
              <p className={styles.muted}>应用启动后可在这里预览。</p>
            )}
          </div>

          <div className={styles.section}>
            <div className={styles.sectionHeading}>AI 开发</div>
            <p className={styles.muted}>OpenCode 可在当前工作区阅读代码、修改文件和运行测试。</p>
            <Button type='secondary' size='small' onClick={() => void cloudDev.openAI()}>
              打开 OpenCode
            </Button>
            <Button
              type='link'
              size='small'
              aria-expanded={aiSettingsOpen}
              onClick={() => setAISettingsOpen(!aiSettingsOpen)}
            >
              {aiSettingsOpen ? '收起设置' : 'AI 设置'}
            </Button>
            {aiSettingsOpen && (
              <CloudDevAISettings onConnect={() => cloudDev.connectAI()} onOpenAI={() => cloudDev.openAI()} />
            )}
          </div>

          <div className={styles.section}>
            <div className={styles.sectionHeading}>数据连接</div>
            <p className={styles.muted}>默认连接可在插件中修改，也可添加其他数据库。</p>
            <div className={styles.resourceRow}>
              <span>MySQL · {context.editorConnections?.mysql ? '已预置' : '未预置'}</span>
              <Button type='secondary' size='small' onClick={() => void cloudDev.openDataTool('mysql')}>
                打开
              </Button>
              <Button type='link' size='small' onClick={() => void cloudDev.openDataTool('mysql', true)}>
                新增
              </Button>
            </div>
            <div className={styles.resourceRow}>
              <span>Redis · {context.editorConnections?.redis ? '已预置' : '未预置'}</span>
              <Button type='secondary' size='small' onClick={() => void cloudDev.openDataTool('redis')}>
                打开
              </Button>
              <Button type='link' size='small' onClick={() => void cloudDev.openDataTool('redis', true)}>
                新增
              </Button>
            </div>
            {context.editorConnections?.error && <p className={styles.error}>{context.editorConnections.error}</p>}
          </div>

          <div className={styles.section}>
            <div className={styles.sectionHeading}>合并请求</div>
            <p className={styles.muted}>
              {context.publishedSha ? `已发布 ${context.publishedSha.slice(0, 8)}` : '尚未发布提交'}
            </p>
            {context.canPublish ? (
              <Button
                type='primary'
                size='small'
                loading={publishing}
                disabled={publishing}
                onClick={() => void cloudDev.publish()}
              >
                {context.mergeRequestUrl ? '更新 MR' : '提交 MR'}
              </Button>
            ) : (
              <p className={styles.muted}>
                {context.isOwner ? '当前开发分支没有不同的目标分支。' : '仅工作区所有者可以发布提交。'}
              </p>
            )}
            {context.mergeRequestUrl && (
              <Button type='link' size='small' onClick={() => cloudDev.openMergeRequest()}>
                查看 MR
              </Button>
            )}
            {context.canPublish && <p className={styles.hint}>只发布 Git 已提交的内容。</p>}
          </div>

          <div className={styles.footer}>
            <Button type='link' size='small' onClick={() => cloudDev.openDevelopmentResources()}>
              开发资源
            </Button>
            <Button type='link' size='small' onClick={() => cloudDev.openWorkbench()}>
              返回工作台
            </Button>
          </div>
        </>
      )}
    </section>
  );
};
