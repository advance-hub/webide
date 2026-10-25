import { CancellationToken, CancellationTokenSource, Deferred } from '@opensumi/ide-core-common';

import { ISuggestDataDtoField } from '../../../../src/common/vscode';
import { Uri } from '../../../../src/common/vscode/ext-types';
import { ExtHostDocumentData } from '../../../../src/hosted/api/vscode/doc/ext-data.host';
import { CompletionAdapter } from '../../../../src/hosted/api/vscode/language/completion';

const resource = Uri.file('/fixture/completion.ts');
const position = { lineNumber: 2, column: 3 };
const context = { triggerKind: 0 };

function fixture(provider: any, lines = ['const value = 1;', 'value']) {
  const data = new ExtHostDocumentData({} as any, resource, lines, '\n', 'typescript', 1, false);
  const documents = { getDocumentData: () => data };
  const commands = { toInternal: jest.fn(() => undefined) };
  const adapter = new CompletionAdapter(provider, commands as any, documents as any);
  const shorten = () =>
    data.onEvents({
      versionId: 2,
      changes: [{ range: { startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 6 }, text: 'x' }],
    } as any);
  return { data, documents, commands, adapter, shorten };
}

describe('补全请求与文档版本的生命周期', () => {
  it('文档缩短后旧行号不会进入提供者', async () => {
    expect.hasAssertions();
    const provider = { provideCompletionItems: jest.fn(() => []) };
    const { adapter, shorten } = fixture(provider);
    shorten();
    expect(await adapter.provideCompletionItems(resource, position, context, CancellationToken.None)).toBeUndefined();
    expect(provider.provideCompletionItems).not.toHaveBeenCalled();
  });

  it('提供者等待期间文档缩短造成的旧请求错误会被丢弃', async () => {
    expect.hasAssertions();
    const started = new Deferred<void>();
    const resume = new Deferred<void>();
    const provider = {
      provideCompletionItems: jest.fn(async (document, pos) => {
        started.resolve();
        await resume.promise;
        return [{ label: document.lineAt(pos).text }];
      }),
    };
    const { adapter, shorten, commands } = fixture(provider);
    const pending = adapter.provideCompletionItems(resource, position, context, CancellationToken.None);
    await started.promise;
    shorten();
    resume.resolve();
    await expect(pending).resolves.toBeUndefined();
    expect(commands.toInternal).not.toHaveBeenCalled();
    expect((adapter as any).toDispose.size).toBe(0);
  });

  it('过期的正常返回也不分配补全缓存', async () => {
    expect.hasAssertions();
    const started = new Deferred<void>();
    const resume = new Deferred<void>();
    const { adapter, shorten } = fixture({
      provideCompletionItems: async () => {
        started.resolve();
        await resume.promise;
        return [{ label: 'value' }];
      },
    });
    const pending = adapter.provideCompletionItems(resource, position, context, CancellationToken.None);
    await started.promise;
    shorten();
    resume.resolve();
    expect(await pending).toBeUndefined();
    expect((adapter as any).toDispose.size).toBe(0);
  });

  it('取消和关闭文档后的结果不再返回给编辑器', async () => {
    expect.hasAssertions();
    for (const action of ['cancel', 'close']) {
      const source = new CancellationTokenSource();
      const started = new Deferred<void>();
      const resume = new Deferred<void>();
      const { adapter, data } = fixture({
        provideCompletionItems: async () => {
          started.resolve();
          await resume.promise;
          return [{ label: 'value' }];
        },
      });
      const pending = adapter.provideCompletionItems(resource, position, context, source.token);
      await started.promise;
      if (action === 'cancel') {
        source.cancel();
      } else {
        data.dispose();
      }
      resume.resolve();
      expect(await pending).toBeUndefined();
      source.dispose();
    }
  });

  it('当前文档的真实提供者错误仍向上传播', async () => {
    expect.hasAssertions();
    const failure = new Error('提供者失败');
    const { adapter } = fixture({
      provideCompletionItems: () => {
        throw failure;
      },
    });
    await expect(adapter.provideCompletionItems(resource, position, context, CancellationToken.None)).rejects.toBe(
      failure,
    );
  });

  it('有效结果可解析并在显式释放时清空资源', async () => {
    expect.hasAssertions();
    const provider = { provideCompletionItems: () => [{ label: 'value' }], resolveCompletionItem: (item) => item };
    const { adapter, commands } = fixture(provider);
    const result = await adapter.provideCompletionItems(resource, position, context, CancellationToken.None);
    expect(result).toBeDefined();
    expect(await adapter.resolveCompletionItem([result!.x, 0], CancellationToken.None)).toBeDefined();
    expect(commands.toInternal).toHaveBeenCalledTimes(2);
    await adapter.releaseCompletionItems(result!.x);
    expect((adapter as any).toDispose.size).toBe(0);
  });

  it('继续输入时仍可复用完整列表并解析详情', async () => {
    expect.hasAssertions();
    const provider = {
      provideCompletionItems: () => [{ label: 'values' }],
      resolveCompletionItem: jest.fn((item) => ({ ...item, detail: '详细说明' })),
    };
    const { adapter, data } = fixture(provider, ['const values = 1;', 'va']);
    const result = await adapter.provideCompletionItems(resource, position, context, CancellationToken.None);
    data.onEvents({
      versionId: 2,
      changes: [
        {
          range: {
            startLineNumber: 2,
            startColumn: 3,
            endLineNumber: 2,
            endColumn: 3,
          },
          text: 'l',
        },
      ],
    } as any);
    const resolved = await adapter.resolveCompletionItem([result!.x, 0], CancellationToken.None);
    expect(resolved![ISuggestDataDtoField.detail]).toBe('详细说明');
    expect(provider.resolveCompletionItem).toHaveBeenCalledTimes(1);
    await adapter.releaseCompletionItems(result!.x);
  });

  it('详情解析的正常返回允许文档在等待期间变化', async () => {
    expect.hasAssertions();
    const started = new Deferred<void>();
    const resume = new Deferred<void>();
    const provider = {
      provideCompletionItems: () => [{ label: 'value' }],
      resolveCompletionItem: async (item) => {
        started.resolve();
        await resume.promise;
        return item;
      },
    };
    const { adapter, shorten } = fixture(provider);
    const result = await adapter.provideCompletionItems(resource, position, context, CancellationToken.None);
    const pending = adapter.resolveCompletionItem([result!.x, 0], CancellationToken.None);
    await started.promise;
    shorten();
    resume.resolve();
    expect(await pending).toBeDefined();
    await adapter.releaseCompletionItems(result!.x);
  });

  it('解析等待期间文档缩短导致的位置错误会被丢弃', async () => {
    expect.hasAssertions();
    const started = new Deferred<void>();
    const resume = new Deferred<void>();
    const value = fixture({
      provideCompletionItems: () => [{ label: 'value' }],
      resolveCompletionItem: async (item) => {
        started.resolve();
        await resume.promise;
        return { ...item, detail: value.data.document.lineAt(1).text };
      },
    });
    const result = await value.adapter.provideCompletionItems(resource, position, context, CancellationToken.None);
    const pending = value.adapter.resolveCompletionItem([result!.x, 0], CancellationToken.None);
    await started.promise;
    value.shorten();
    resume.resolve();
    expect(await pending).toBeUndefined();
    await value.adapter.releaseCompletionItems(result!.x);
  });

  it('当前版本的解析错误仍向上传播', async () => {
    expect.hasAssertions();
    const failure = new Error('解析失败');
    const current = fixture({
      provideCompletionItems: () => [{ label: 'value' }],
      resolveCompletionItem: () => {
        throw failure;
      },
    });
    const valid = await current.adapter.provideCompletionItems(resource, position, context, CancellationToken.None);
    await expect(current.adapter.resolveCompletionItem([valid!.x, 0], CancellationToken.None)).rejects.toBe(failure);
    await current.adapter.releaseCompletionItems(valid!.x);
  });
});
