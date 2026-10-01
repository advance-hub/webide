import { Button, Input, Table, Tag } from '@arco-design/web-react';
import { useEffect, useState } from 'react';

import { BaselineActions } from '../components/baseline';
import { Branch, Callout, Empty } from '../components/common';
import { VirtualTable } from '../components/virtual-collection';
import { type Project, busyStates, date, projectHref } from '../domain';
import { ArrowIcon, BackIcon, CopyIcon, FileIcon, ProjectsIcon } from '../icons';

import type { Navigation, Workbench } from '../use-workbench';

interface Entry {
  name: string;
  path: string;
  kind: string;
  size: number;
}
interface Commit {
  sha: string;
  author: string;
  date: string;
  subject: string;
}
interface RepositoryData {
  kind: string;
  path: string;
  entries?: Entry[];
  truncated?: boolean;
  size?: number;
  preview?: string;
  content?: string;
  commits?: Commit[];
}
const bytes = (size = 0) => (size < 1024 ? `${size} B` : `${(size / 1024).toFixed(1)} KB`);

export function Repository({
  project,
  route,
  navigate,
  wb,
  commits = false,
}: {
  project: Project;
  route: URL;
  navigate: Navigation;
  wb: Workbench;
  commits?: boolean;
}) {
  const [search, setSearch] = useState('');
  const path = commits ? '' : route.searchParams.get('path') || '';
  const endpoint = `/api/projects/${project.id}/${commits ? 'commits' : 'repository'}?path=${encodeURIComponent(path)}`;
  const [result, setResult] = useState<{ key: string; data?: RepositoryData; error?: string }>();
  const [retry, setRetry] = useState(0);
  useEffect(() => setSearch(''), [path, project.id, project.sha]);
  useEffect(() => {
    if (project.status !== 'ready') {
      return;
    }
    const controller = new AbortController();
    setResult(undefined);
    void fetch(endpoint, { signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) {
          throw new Error(data.error || '代码读取失败');
        }
        if (!controller.signal.aborted) {
          setResult({ key: endpoint, data });
        }
      })
      .catch((error: Error) => {
        if (!controller.signal.aborted) {
          setResult({ key: endpoint, error: error.message });
        }
      });
    return () => controller.abort();
  }, [endpoint, retry, project.status, project.sha]);
  const data = result?.key === endpoint ? result.data : undefined;
  const error = result?.key === endpoint ? result.error : undefined;
  const openPath = (value: string) =>
    navigate(`${projectHref(project.id, 'code')}${value ? `&path=${encodeURIComponent(value)}` : ''}`);
  const remote = project.url.replace(/\.git$/, '');
  const remoteURL = commits
    ? `${remote}/-/commits/${project.sha}`
    : `${remote}/-/tree/${project.sha}${path ? `/${path.split('/').map(encodeURIComponent).join('/')}` : ''}`;
  if (project.status !== 'ready') {
    return <Empty title='代码基线还未就绪'>项目拉取完成后，可以查看目录与提交记录。</Empty>;
  }
  const lines = (data?.content || '').split('\n');
  return (
    <div className='repository-browser'>
      <div className='repository-toolbar'>
        <div className='actions'>
          <Tag>
            <Branch value={project.branch} />
          </Tag>
          <code>{project.sha.slice(0, 8)}</code>
          <span className='subtle'>
            {busyStates.has(project.baselineStatus || '')
              ? `正在更新 ${project.baselineRequest?.branch || ''}`
              : `${date(project.baselineUpdatedAt || project.createdAt)} 更新`}
          </span>
        </div>
        <div className='actions baseline-toolbar-actions'>
          <BaselineActions project={project} wb={wb} />
          <Button type='text' href={remoteURL} target='_blank' rel='noopener noreferrer'>
            在远端查看
            {<ArrowIcon />}
          </Button>
        </div>
      </div>
      {!commits && (
        <nav className='file-breadcrumbs' aria-label='仓库路径'>
          <Button type='text' size='small' onClick={() => openPath('')}>
            {project.name}
          </Button>
          {path
            .split('/')
            .filter(Boolean)
            .map((segment, index, parts) => (
              <span key={index}>
                <span className='slash'>/</span>
                <Button type='text' size='small' onClick={() => openPath(parts.slice(0, index + 1).join('/'))}>
                  {segment}
                </Button>
              </span>
            ))}
        </nav>
      )}
      {error ? (
        <Empty
          title='无法读取此内容'
          action={
            <div className='actions'>
              <Button onClick={() => setRetry((v) => v + 1)}>重试</Button>
              {path && <Button onClick={() => openPath('')}>返回根目录</Button>}
            </div>
          }
        >
          {error}
        </Empty>
      ) : !data ? (
        <div className='loading-skeleton' role='status' aria-label='正在读取仓库'>
          <div />
          <div />
        </div>
      ) : commits ? (
        <>
          <Table<Commit>
            data={data.commits || []}
            pagination={false}
            rowKey='sha'
            scroll={{ x: 620 }}
            columns={[
              {
                title: '提交说明',
                key: 'subject',
                width: '55%',
                render: (_, c) => (
                  <div className='commit-subject'>
                    <a href={`${remote}/-/commit/${c.sha}`} target='_blank' rel='noopener noreferrer'>
                      {c.subject || '(无提交说明)'}
                    </a>
                    <span className='subtle'>{c.author}</span>
                  </div>
                ),
              },
              {
                title: '提交',
                key: 'sha',
                render: (_, c) => (
                  <div className='actions'>
                    <code>{c.sha.slice(0, 8)}</code>
                    <Button
                      type='text'
                      size='small'
                      icon={<CopyIcon />}
                      aria-label={`复制提交 ${c.sha.slice(0, 8)}`}
                      onClick={() =>
                        void wb.act('copy-sha', async () => {
                          await navigator.clipboard.writeText(c.sha);
                          wb.setNotice('提交 SHA 已复制');
                        })
                      }
                    />
                  </div>
                ),
              },
              { title: '时间', key: 'date', render: (_, c) => <span className='subtle nowrap'>{date(c.date)}</span> },
              {
                title: '操作',
                key: 'action',
                width: 120,
                render: (_, c) => <BaselineActions project={project} wb={wb} commit={c.sha} />,
              },
            ]}
          />
          <p className='collection-summary'>展示基线最近 {data.commits?.length || 0} 条提交，最多 20 条</p>
        </>
      ) : data.kind === 'tree' ? (
        <>
          {path && (
            <Button
              type='text'
              className='directory-up'
              icon={<BackIcon />}
              onClick={() => openPath(path.split('/').slice(0, -1).join('/'))}
            >
              上级目录
            </Button>
          )}
          <div className='directory-toolbar'>
            <Input.Search
              className='resource-search'
              aria-label='筛选当前目录'
              placeholder='筛选当前目录文件、文件夹'
              value={search}
              allowClear
              onChange={(e) => setSearch(e)}
            />
            <span className='subtle'>
              {(data.entries || []).filter((e) => e.name.toLowerCase().includes(search.toLowerCase())).length} 个条目
            </span>
          </div>
          <VirtualTable<Entry>
            rowHeight={44}
            resetKey={`${endpoint}:${project.sha}:${search}`}
            data={(data.entries || []).filter((e) => e.name.toLowerCase().includes(search.toLowerCase()))}
            pagination={false}
            rowKey='path'
            noDataElement='该目录没有文件'
            columns={[
              {
                title: '名称',
                key: 'name',
                render: (_, entry) => (
                  <div className='file-name'>
                    {entry.kind === 'tree' ? <ProjectsIcon /> : <FileIcon />}
                    {entry.kind === 'commit' ? (
                      <span>
                        {entry.name} <Tag size='small'>子模块</Tag>
                      </span>
                    ) : (
                      <a href={`#${projectHref(project.id, 'code')}&path=${encodeURIComponent(entry.path)}`}>
                        {entry.name}
                      </a>
                    )}
                    {entry.kind === 'symlink' && <span className='subtle'>符号链接</span>}
                  </div>
                ),
              },
              {
                title: '类型',
                key: 'type',
                width: 120,
                render: (_, entry) => (
                  <span className='subtle'>
                    {entry.kind === 'tree'
                      ? '目录'
                      : entry.kind === 'commit'
                        ? '子模块'
                        : entry.kind === 'symlink'
                          ? '链接'
                          : '文件'}
                  </span>
                ),
              },
              {
                title: '大小',
                key: 'size',
                width: 120,
                render: (_, entry) => (
                  <span className='subtle'>
                    {entry.kind === 'blob' || entry.kind === 'symlink' ? bytes(entry.size) : '—'}
                  </span>
                ),
              },
            ]}
          />
          {data.truncated && <Callout>当前目录仅展示前 1,000 项，请在远端查看全部文件。</Callout>}
          <p className='collection-summary'>{data.entries?.length || 0} 个条目 · 工作区内的未提交修改不会显示在这里</p>
        </>
      ) : data.preview === 'text' ? (
        <section className='file-preview'>
          <div className='file-preview-heading'>
            <span>
              <FileIcon /> {path.split('/').pop()}
            </span>
            <span className='subtle'>{bytes(data.size)}</span>
            <Button
              type='text'
              size='small'
              icon={<CopyIcon />}
              onClick={() =>
                void wb.act('copy-file', async () => {
                  await navigator.clipboard.writeText(data.content || '');
                  wb.setNotice('文件内容已复制');
                })
              }
            >
              复制内容
            </Button>
          </div>
          {lines.length > 2000 && <Callout>预览仅展示前 2,000 行，可复制完整内容或在远端查看。</Callout>}
          <pre className='source-code' tabIndex={0} aria-label={`${path} 文件内容`}>
            <code>
              {lines.slice(0, 2000).map((line, index) => (
                <span className='source-line' key={index}>
                  <span className='line-number' aria-hidden='true'>
                    {index + 1}
                  </span>
                  {line || ' '}
                </span>
              ))}
            </code>
          </pre>
        </section>
      ) : (
        <Empty
          title={data.preview === 'large' ? '文件超过预览大小' : '此文件不支持文本预览'}
          action={
            <Button href={remoteURL} target='_blank' rel='noopener noreferrer'>
              在远端查看
            </Button>
          }
        >
          {data.preview === 'large'
            ? `${bytes(data.size)}，文本预览上限为 256 KB。`
            : '二进制文件和子模块请在远端查看。'}
        </Empty>
      )}
    </div>
  );
}
