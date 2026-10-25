import { Delayer } from '@opensumi/monaco-editor-core/esm/vs/base/common/async';
import { errorHandler } from '@opensumi/monaco-editor-core/esm/vs/base/common/errors';
import { WordHighlighterContribution } from '@opensumi/monaco-editor-core/esm/vs/editor/contrib/wordHighlighter/browser/wordHighlighter';
import { editor } from '@opensumi/monaco-editor-core/esm/vs/editor/editor.api';

describe('单词高亮的延迟任务生命周期', () => {
  it('切换模型取消排队任务时不产生未处理的拒绝', async () => {
    expect.hasAssertions();
    const container = document.createElement('div');
    document.body.append(container);
    const first = editor.createModel('const first = 1;');
    const second = editor.createModel('const second = 2;');
    const instance = editor.create(container, { model: first, occurrencesHighlight: 'singleFile' });
    const trigger = jest.spyOn(Delayer.prototype, 'trigger');
    try {
      expect(instance.getContribution(WordHighlighterContribution.ID)).toBeDefined();
      instance.setPosition({ lineNumber: 1, column: 8 });
      expect(trigger).toHaveBeenCalled();
      instance.setModel(second);
      // 等待真实 Promise 拒绝传播，不能给待测任务额外挂 catch 而掩盖回归。
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(instance.getModel()).toBe(second);
    } finally {
      trigger.mockRestore();
      instance.dispose();
      first.dispose();
      second.dispose();
      container.remove();
    }
  });

  it('延迟任务中的非取消错误仍交给错误处理器', async () => {
    expect.hasAssertions();
    const container = document.createElement('div');
    document.body.append(container);
    const instance = editor.create(container, { value: 'const value = 1;', occurrencesHighlight: 'singleFile' });
    const report = jest.spyOn(errorHandler, 'onUnexpectedError').mockImplementation(() => {});
    const failure = new Error('高亮任务失败');
    try {
      const contribution = instance.getContribution(WordHighlighterContribution.ID) as WordHighlighterContribution;
      const highlighter = contribution.wordHighlighter!;
      jest.spyOn(highlighter as any, '_onPositionChanged').mockImplementation(() => {
        throw failure;
      });
      instance.setPosition({ lineNumber: 1, column: 8 });
      await new Promise((resolve) => setTimeout(resolve, 70));
      expect(report).toHaveBeenCalledWith(failure);
    } finally {
      instance.getModel()?.dispose();
      instance.dispose();
      container.remove();
      report.mockRestore();
    }
  });
});
