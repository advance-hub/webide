import { Button, Input } from '@arco-design/web-react';
import { useCallback, useEffect, useState } from 'react';

import { Callout, Empty, PageHeader } from '../components/common';
import { Modal } from '../components/overlays';
import { date, request } from '../domain';
import { RefreshIcon } from '../icons';

import type { Workbench } from '../use-workbench';

interface ImageInfo {
  id: string;
  tags: string[];
  size: number;
  createdAt: string;
  inUse: number;
}

// The runtime image is shared across workspaces. Each workspace fetches its
// selected Git branch at creation time, after the runtime image is chosen.
export function Images({ wb }: { wb: Workbench }) {
  const [images, setImages] = useState<ImageInfo[]>();
  const [query, setQuery] = useState('');
  const [showUnused, setShowUnused] = useState(false);
  const [showOther, setShowOther] = useState(false);
  const [error, setError] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string>();

  const load = useCallback(async () => {
    setError('');
    try {
      const result = await request<{ images: ImageInfo[] }>('/images');
      setImages(result.images);
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const doDelete = (ref: string) =>
    void wb.act(`image:${ref}`, async () => {
      try {
        await request(`/images/${encodeURIComponent(ref)}/delete`, {});
        wb.setNotice(`镜像 ${ref} 已删除`);
        await load();
        setConfirmDelete(undefined);
      } catch (e) {
        setError((e as Error).message);
        throw e;
      }
    });

  const items = (images || []).filter(
    (img) => img.tags.some((tag) => tag.toLowerCase().includes(query.toLowerCase())) || img.id.includes(query),
  );
  const relevant = (img: ImageInfo) => img.inUse > 0 || img.tags.some((tag) => /opensumi|workspace/i.test(tag));
  const workbenchImages = items.filter(relevant);
  const otherImages = items.filter((img) => !relevant(img));
  const linkedImages = workbenchImages.filter((img) => img.inUse > 0);
  const unusedImages = workbenchImages.filter((img) => img.inUse === 0);
  const primaryImages = query ? items : linkedImages.length ? linkedImages : unusedImages.slice(0, 3);
  const deferredImages = linkedImages.length ? unusedImages : unusedImages.slice(3);

  const formatSize = (bytes: number) => {
    if (bytes > 1 << 30) {
      return `${(bytes / (1 << 30)).toFixed(1)} GB`;
    }
    if (bytes > 1 << 20) {
      return `${(bytes / (1 << 20)).toFixed(0)} MB`;
    }
    return `${(bytes / (1 << 10)).toFixed(0)} KB`;
  };
  const renderImages = (entries: ImageInfo[], canDelete: boolean) =>
    entries.map((img) => (
      <div className='env-card' key={img.id}>
        <div className='env-head image-row'>
          <span className='env-dot env-dot-idle' />
          <span className='env-branch image-tag-main' title={img.tags[0]}>
            {img.tags[0]}
          </span>
          {img.tags.length > 1 && <span className='subtle'>+{img.tags.length - 1} 个标签</span>}
          <span className='env-meta'>
            {formatSize(img.size)} · {date(img.createdAt)}
            {img.inUse > 0 ? ` · ${img.inUse} 个沙箱关联` : ''}
          </span>
          <span className='env-actions'>
            {img.inUse > 0 ? (
              <span className='sandbox-binding'>有关联</span>
            ) : canDelete && relevant(img) ? (
              <Button
                type='text'
                size='small'
                status='danger'
                disabled={!!wb.pending}
                onClick={() => setConfirmDelete(img.tags[0])}
              >
                删除
              </Button>
            ) : null}
          </span>
        </div>
        {img.tags.length > 1 && (
          <div className='image-tag-list'>
            {img.tags.slice(1).map((tag) => (
              <code key={tag} className='image-tag'>
                {tag}
              </code>
            ))}
          </div>
        )}
      </div>
    ));

  return (
    <>
      <PageHeader
        title='开发镜像'
        description='这里管理通用开发镜像。项目代码不打进镜像；创建工作区时会拉取所选分支的最新提交。'
        action={
          <>
            <Button
              icon={<RefreshIcon />}
              loading={wb.pending === 'images-refresh'}
              disabled={!!wb.pending}
              onClick={() => void wb.act('images-refresh', load)}
            >
              刷新
            </Button>
          </>
        }
      />
      {error && (
        <div className='inline-error' role='alert'>
          {error}
        </div>
      )}
      <div className='collection-toolbar'>
        <Input.Search
          className='resource-search'
          aria-label='搜索镜像'
          placeholder='搜索镜像名或 ID'
          value={query}
          onChange={(e) => setQuery(e)}
          allowClear
        />
        <span className='subtle'>
          {!images
            ? '正在读取镜像'
            : query
              ? `${items.length} 个结果`
              : linkedImages.length
                ? `${linkedImages.length} 个有沙箱关联`
                : `${workbenchImages.length} 个工作区镜像`}
        </span>
      </div>
      {primaryImages.length ? (
        <div className='workspace-list'>{renderImages(primaryImages, true)}</div>
      ) : images ? (
        <Empty title={query ? '没有匹配的镜像' : '尚无工作区镜像'}>
          {query
            ? '调整搜索条件，或刷新读取最新列表。'
            : '工作区镜像使用中或名称包含 opensumi / workspace 时，会出现在这里。'}
        </Empty>
      ) : error ? (
        <Empty title='镜像列表暂不可用' action={<Button onClick={() => void load()}>重试</Button>}>
          检查 Docker 服务后重新读取。
        </Empty>
      ) : (
        <div className='loading-skeleton' role='status' aria-label='正在读取镜像'>
          <span />
          <div />
        </div>
      )}
      {!query && !!deferredImages.length && (
        <section className='image-other-section' aria-label='其他工作区镜像'>
          <div className='section-heading'>
            <div>
              <h2>其他工作区镜像</h2>
              <p className='subtle'>已构建或保留的开发镜像，当前没有沙箱关联。</p>
            </div>
            <Button type='text' onClick={() => setShowUnused((value) => !value)} aria-expanded={showUnused}>
              {showUnused ? '收起' : `查看 ${deferredImages.length} 个`}
            </Button>
          </div>
          {showUnused && <div className='workspace-list'>{renderImages(deferredImages, true)}</div>}
        </section>
      )}
      {!query && !!otherImages.length && (
        <section className='image-other-section' aria-label='其他本机镜像'>
          <div className='section-heading'>
            <div>
              <h2>其他本机镜像</h2>
              <p className='subtle'>未识别为工作区镜像，保留清单供排查。</p>
            </div>
            <Button type='text' onClick={() => setShowOther((value) => !value)} aria-expanded={showOther}>
              {showOther ? '收起' : `查看 ${otherImages.length} 个`}
            </Button>
          </div>
          {showOther && <div className='workspace-list'>{renderImages(otherImages, false)}</div>}
        </section>
      )}

      <Modal
        visible={!!confirmDelete}
        title='删除镜像'
        width={520}

        alignCenter
        closable
        escToExit={!wb.pending}
        onCancel={() => !wb.pending && setConfirmDelete(undefined)}

        footer={
          <div className='drawer-actions'>
            <Button disabled={!!wb.pending} onClick={() => setConfirmDelete(undefined)}>
              取消
            </Button>
            <Button
              type='primary'
              status='danger'
              loading={!!wb.pending}
              disabled={!!wb.pending}
              onClick={() => confirmDelete && doDelete(confirmDelete)}
            >
              确认删除
            </Button>
          </div>
        }
      >
        <Callout tone='warning' title='此操作不可恢复'>
          将删除镜像 <code>{confirmDelete}</code>
          。如果镜像被其他容器引用，Docker 可能拒绝删除。删除后，新工作区将无法使用此镜像创建。
        </Callout>
      </Modal>
    </>
  );
}
