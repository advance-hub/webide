import assert from 'node:assert/strict';

import { activateTab, appendDocument, focusEditor, modifier, readDocument, saveDocument } from './browser-editor';

import type { Page } from 'playwright';

export const languageFixture = 'export function probeNumber(value: number): number { return value + 1; }\n';
export const searchToken = 'WEBIDE_MEMORY_SEARCH_TOKEN';

async function replaceDocument(page: Page, text: string): Promise<void> {
  await page.keyboard.press('Escape');
  await focusEditor(page);
  await page.keyboard.press(`${modifier}+a`);
  await page.keyboard.press('Backspace');
  // 原生 EditContext 的多行输入和异步粘贴各有处理链；逐行键盘输入并核对模型的实际渲染。
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index++) {
    if (index) {
      await page.keyboard.press('Escape');
      await page.keyboard.press('Enter');
    }
    if (lines[index]) {
      await page.keyboard.insertText(lines[index]);
    }
  }
  await page.keyboard.press('Escape');
  await page.waitForFunction((expected) => {
    const editor = [...document.querySelectorAll<HTMLElement>('#workbench-editor .monaco-editor')]
      .filter((element) => element.offsetHeight > 0)
      .at(-1);
    const actual = editor?.querySelector('.view-lines')?.textContent || '';
    return actual.replace(/[\s\u200b]/g, '') === expected.replace(/\s/g, '');
  }, text);
  assert.equal((await readDocument(page)).replace(/\s/g, ''), text.replace(/\s/g, ''), '替换后必须核对完整文档');
}

async function quickOpenFile(page: Page, filename: string): Promise<number> {
  const input = page.locator('#opensumi-quickpick-input');
  const started = Date.now();
  const deadline = started + 60000;
  // 已打开标签也可能拥有同名标签文本；只等待并选择本次 Quick Open 列表中的真实结果。
  const result = page.locator('quick-open-container').getByLabel(filename, { exact: true }).first();
  let closed = 0;
  for (;;) {
    const remaining = () => Math.max(1, deadline - Date.now());
    assert(Date.now() < deadline, `Quick Open ${filename} 在总期限内未返回实际文件，弹层关闭 ${closed} 次`);
    await page.keyboard.press('Escape');
    await focusEditor(page);
    await page.keyboard.press(`${modifier}+p`);
    await input.waitFor({ state: 'visible', timeout: remaining() });
    await input.fill('', { timeout: remaining() });
    await input.fill(filename, { timeout: remaining() });
    // 初始化期间的异步焦点切换可能关闭弹层；仅重开已关闭的弹层，不重试缺失结果或延长期限。
    const outcome = await Promise.race([
      result.waitFor({ state: 'visible', timeout: remaining() }).then(() => 'result'),
      input.waitFor({ state: 'hidden', timeout: remaining() }).then(() => 'closed'),
    ]);
    if (outcome === 'result') {
      break;
    }
    closed++;
    process.stdout.write(
      `Quick Open ${filename}: 弹层提前关闭，第 ${closed} 次重新打开，耗时 ${Date.now() - started} ms\n`,
    );
  }
  const elapsed = Date.now() - started;
  await result.click();
  await input.waitFor({ state: 'hidden' });
  await page.getByRole('tab', { name: filename, exact: true, selected: true }).waitFor({ state: 'visible' });
  await focusEditor(page);
  return elapsed;
}

/** 使用真实补全和类型错误验证语义服务，防止通过关闭语言能力降低内存。 */
export async function verifyLanguageFeatures(page: Page): Promise<{ completionMs: number; diagnosticMs: number }> {
  await quickOpenFile(page, 'language-features.ts');
  assert.match(await readDocument(page), /^export function probeNumber\(/);
  await replaceDocument(page, languageFixture);
  const completionStart = Date.now();
  await appendDocument(page, '\nprobeNu');
  await page.keyboard.press('Control+Space');
  const suggestion = page
    .locator('.suggest-widget.visible .monaco-list-row')
    .filter({ hasText: 'probeNumber' })
    // 单词补全只有文本图标；要求函数类型，确认实际语言服务提供了语义补全。
    .filter({ has: page.locator('.codicon-symbol-function, .codicon-symbol-method') })
    .first();
  await suggestion.waitFor({ state: 'visible' });
  const completionMs = Date.now() - completionStart;
  await suggestion.click();
  await page.keyboard.press('Escape');
  assert.match((await readDocument(page)).trimEnd(), /\nprobeNumber(?:\([^\n]*\))?$/);
  await page.keyboard.press('Escape');
  await replaceDocument(page, languageFixture);
  await page.locator('#workbench-editor .monaco-editor:visible .squiggly-error').last().waitFor({ state: 'hidden' });
  const diagnosticStart = Date.now();
  await replaceDocument(page, `${languageFixture}\nexport const invalidMemoryProbe: number = "invalid";\n`);
  await page.locator('#workbench-editor .monaco-editor:visible .squiggly-error').last().waitFor({ state: 'visible' });
  // 使用问题导航展示真实诊断，避免编辑器的装饰光标层拦截对细下划线的鼠标悬停。
  const message = page
    .getByText(/Type 'string' is not assignable to type 'number'/)
    .filter({ visible: true })
    .last();
  const deadline = Date.now() + 60000;
  do {
    await page.keyboard.press('F8');
    try {
      await message.waitFor({ timeout: 1000 });
      break;
    } catch (error) {
      if ((error as Error).name !== 'TimeoutError' || Date.now() >= deadline) {
        throw error;
      }
      // 问题导航可能打开上一版本的诊断；关闭后重新导航，直到真实语义结果抵达。
      await page.keyboard.press('Escape');
      await focusEditor(page);
    }
  } while (Date.now() < deadline);
  await message.waitFor({ timeout: 1000 });
  const diagnosticMs = Date.now() - diagnosticStart;
  await page.keyboard.press('Escape');
  await replaceDocument(page, languageFixture);
  await saveDocument(page);
  await quickOpenFile(page, 'collaboration.ts');
  return { completionMs, diagnosticMs };
}

export async function verifySearchAndQuickOpen(page: Page): Promise<{ searchMs: number; quickOpenMs: number }> {
  const input = page.getByRole('textbox', { name: 'Enter search content' });
  await activateTab(page.locator('#opensumi-left-tabbar #search').filter({ visible: true }).first());
  await input.waitFor({ state: 'visible' });
  await input.fill('');
  await input.press('Enter');
  await page.waitForFunction(() => !/\d+ results found in \d+ files/.test(document.body.innerText));
  const searchStart = Date.now();
  await input.fill(searchToken);
  await input.press('Enter');
  await page.waitForFunction(() => /\b8 results found in 8 files\b/.test(document.body.innerText));
  const searchMs = Date.now() - searchStart;
  await input.fill('');
  await input.press('Enter');
  const quickOpenMs = await quickOpenFile(page, 'collaboration.ts');
  assert.match(await readDocument(page), /export const collaboration/);
  return { searchMs, quickOpenMs };
}
