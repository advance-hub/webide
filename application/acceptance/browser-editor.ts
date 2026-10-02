import assert from 'node:assert/strict';

import type { Page } from 'playwright';

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';

/** 操作实际 Monaco 编辑器，验收不向生产页面加入内部调试入口。 */
export async function focusEditor(page: Page): Promise<void> {
  await page.bringToFront();
  await page.locator('#workbench-editor .monaco-editor:visible').last().waitFor({ state: 'visible' });
  const native = page.locator('#workbench-editor .monaco-editor:visible .native-edit-context').last();
  const input = (await native.count())
    ? native
    : page.locator('#workbench-editor .monaco-editor:visible textarea').last();
  await input.waitFor({ state: (await native.count()) ? 'attached' : 'visible' });
  await input.focus();
  await page.waitForTimeout(100);
}

export async function openDocument(page: Page, filename: string): Promise<void> {
  await page.bringToFront();
  await page.locator('#opensumi-left-tabbar').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  // 使用真实资源树打开同一文件，兼容工作区已经恢复该编辑器的情况。
  const file = page
    .locator('[data-id][draggable="true"]')
    .filter({ has: page.getByText(filename, { exact: true }) })
    .filter({ visible: true })
    .first();
  await file.dblclick();
  await focusEditor(page);
}

/** 全选复制读取完整文档，避免只读取可视区域而漏掉合并错误。 */
export async function readDocument(page: Page): Promise<string> {
  await focusEditor(page);
  await page.keyboard.press(`${modifier}+a`);
  await page.keyboard.press(`${modifier}+c`);
  const text = await page.evaluate(() => navigator.clipboard.readText());
  await page.keyboard.press('ArrowRight');
  return text;
}

export async function appendDocument(page: Page, value: string): Promise<void> {
  await focusEditor(page);
  await page.keyboard.press(`${modifier}+End`);
  await page.keyboard.insertText(value);
}

export async function saveDocument(page: Page): Promise<void> {
  await focusEditor(page);
  await page.keyboard.press(`${modifier}+s`);
}

export async function undoDocument(page: Page, redo = false): Promise<void> {
  await focusEditor(page);
  await page.keyboard.press(`${modifier}+${redo ? 'Shift+' : ''}z`);
}

export async function openTerminal(page: Page, marker: string): Promise<string> {
  assert(/^[A-Za-z0-9_]+$/.test(marker));
  const receipt = `/tmp/webide-terminal-${marker}`;
  await page.bringToFront();
  const input = page.getByRole('textbox', { name: 'Terminal input', exact: true }).last();
  const trigger = page.getByText('TERMINAL', { exact: true }).filter({ visible: true }).first();
  const deadline = Date.now() + 60000;
  // 终端标签可能先于终端实例出现；点击可见入口，避免快捷键把已展开面板折叠。
  while (!(await input.isVisible()) && Date.now() < deadline) {
    await trigger.click();
    await input.waitFor({ state: 'visible', timeout: 1500 }).catch(() => {});
  }
  await input.waitFor({ state: 'visible', timeout: 1000 });
  await input.focus();
  // xterm 焦点更新异步完成，先清空输入，再通过实际剪贴板粘贴完整命令。
  await page.waitForTimeout(100);
  await page.keyboard.press('Control+u');
  await page.waitForTimeout(100);
  await page.evaluate((text) => navigator.clipboard.writeText(text), `printf '%s' '${marker}' > '${receipt}'`);
  await page.keyboard.press(`${modifier}+v`);
  await page.waitForTimeout(100);
  await page.keyboard.press('Enter');
  return receipt;
}
