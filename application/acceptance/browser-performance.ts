import assert from 'node:assert/strict';

import {
  activateTab,
  appendDocument,
  focusEditor,
  modifier,
  openDocument,
  readDocument,
  saveDocument,
} from './browser-editor';

import type { Page } from 'playwright';

export const languageFixture = 'export function probeNumber(value: number): number { return value + 1; }\n';
export const searchToken = 'WEBIDE_MEMORY_SEARCH_TOKEN';

async function replaceDocument(page: Page, text: string): Promise<void> {
  await focusEditor(page);
  await page.keyboard.press(`${modifier}+a`);
  await page.keyboard.insertText(text);
}

/** 使用真实补全和类型错误验证语义服务，防止通过关闭语言能力降低内存。 */
export async function verifyLanguageFeatures(page: Page): Promise<{ completionMs: number; diagnosticMs: number }> {
  await openDocument(page, 'language-features.ts');
  await replaceDocument(page, languageFixture);
  await appendDocument(page, '\nprobeNu');
  const completionStart = Date.now();
  await page.keyboard.press('Control+Space');
  const suggestion = page
    .locator('.suggest-widget.visible .monaco-list-row')
    .filter({ hasText: 'probeNumber' })
    .first();
  await suggestion.waitFor({ state: 'visible' });
  const completionMs = Date.now() - completionStart;
  await suggestion.click();
  assert.match((await readDocument(page)).trimEnd(), /\nprobeNumber(?:\([^\n]*\))?$/);
  await page.keyboard.press('Escape');
  const diagnosticStart = Date.now();
  await replaceDocument(page, `${languageFixture}\nexport const invalidMemoryProbe: number = "invalid";\n`);
  const error = page.locator('#workbench-editor .monaco-editor:visible .squiggly-error').last();
  await error.waitFor({ state: 'visible' });
  await error.hover();
  await page
    .getByText(/Type 'string' is not assignable to type 'number'/)
    .filter({ visible: true })
    .last()
    .waitFor();
  const diagnosticMs = Date.now() - diagnosticStart;
  await page.keyboard.press('Escape');
  await replaceDocument(page, languageFixture);
  await saveDocument(page);
  await openDocument(page, 'collaboration.ts');
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
  await page.keyboard.press(`${modifier}+p`);
  const quickOpen = page.locator('#opensumi-quickpick-input');
  await quickOpen.waitFor({ state: 'visible' });
  await quickOpen.fill('');
  const quickOpenStart = Date.now();
  await quickOpen.fill('collaboration.ts');
  await page.getByLabel('collaboration.ts', { exact: true }).first().waitFor({ state: 'visible' });
  const quickOpenMs = Date.now() - quickOpenStart;
  await page.keyboard.press('Enter');
  await quickOpen.waitFor({ state: 'hidden' });
  assert.match(await readDocument(page), /export const collaboration/);
  return { searchMs, quickOpenMs };
}
