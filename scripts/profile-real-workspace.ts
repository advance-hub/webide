import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { access, cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import { chromium } from 'playwright';

import { collectProcessTreeMemory } from '@opensumi/ide-dev-tool/diagnostics/process-tree';

import type { BrowserContext, Locator, Page } from 'playwright';

// Run against an isolated working copy, never a developer's live checkout.
// Example: pnpm exec tsx scripts/profile-real-workspace.ts <project.json> node 1 3 <output-directory>
interface Project {
  name: string;
  workspace: string;
  smallFile: string;
  largeFile: string;
  query: string;
  expectedSearchResult: string;
  extensionDirectory: string;
  nodeModulesLinked: boolean;
  runtimeRoot?: string;
  collaboration?: boolean;
  collaborationPort?: number;
}

const repoRoot = path.resolve(import.meta.dirname, '..');
const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
async function main() {
  const [projectFile, variant, runText, sessionsText, outputDirectory] = process.argv.slice(2);
  if (!projectFile || !['node', 'shared-node'].includes(variant) || !outputDirectory) {
    throw new Error('Expected <project.json> <node|shared-node> <run> <sessions> <output-directory>');
  }
  const run = Number(runText);
  const sessions = Number(sessionsText);
  if (![run, sessions].every((value) => Number.isSafeInteger(value) && value > 0)) {
    throw new Error('run and sessions must be positive integers');
  }
  const project: Project = JSON.parse(await readFile(path.resolve(projectFile), 'utf8'));
  if (project.nodeModulesLinked && sessions < 3) {
    throw new Error('The frontend/backend and collaboration scenarios require at least three sessions');
  }
  const runtimeRoot = project.runtimeRoot || repoRoot;
  if (!project.workspace.includes('/snapshots/')) {
    throw new Error('Only an isolated /snapshots/ workspace is accepted');
  }
  const output = path.resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  const seedWorkspace = project.workspace;
  const preparedWorkspace = path.join(output, 'workspace');
  if (
    await access(preparedWorkspace).then(
      () => true,
      () => false,
    )
  ) {
    throw new Error('Output workspace already exists; use a fresh output directory for every run');
  }
  const preparationStartedAt = Date.now();
  await cp(seedWorkspace, preparedWorkspace, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    preserveTimestamps: true,
    filter: (source) => source !== path.join(seedWorkspace, '.sumi'),
  });
  project.workspace = preparedWorkspace;
  const workspacePreparationMs = Date.now() - preparationStartedAt;
  const steps: Array<{ name: string; session: number; ms: number; ok: boolean; evidence?: unknown; error?: string }> =
    [];
  let collaborationSnapshot: (() => Promise<unknown>) | undefined;
  const errors: Array<{ session: number; phase: string; source: string; message: string }> = [];
  const errorCounts: Record<string, number> = {};
  const handshakeEvidence: Array<{ session: number; phase: string; message: string }> = [];
  function recordError(session: number, source: string, message: string) {
    const key = `${phase}:${source}`;
    errorCounts[key] = (errorCounts[key] || 0) + 1;
    if (errors.length < 200) {
      errors.push({ session, phase, source, message: message.slice(0, 2_000) });
    }
  }
  const samples: Array<{ phase: string; elapsedMs: number; service: unknown; browser: unknown }> = [];
  let phase = 'startup';
  const startedAt = Date.now();
  const pages: Page[] = [];
  const contexts: BrowserContext[] = [];
  const ownedProbeFiles: string[] = [];
  const watchDirectoryName = `aaa-runtime-profile-${process.pid}`;
  const watchDirectory = path.join(project.workspace, watchDirectoryName);
  const sharedRelative = `packages/utils/src/runtime-collaboration-${process.pid}.ts`;
  const sharedFile = path.join(project.workspace, sharedRelative);
  const result: Record<string, unknown> = {
    schemaVersion: 1,
    project,
    variant,
    run,
    sessions,
    startedAt: new Date().toISOString(),
    steps,
    errors,
    handshakeEvidence,
    samples,
    backgroundLoadAtStart: os.loadavg(),
    comparisonScope:
      'Whole IDE service tree including extension hosts, language servers, watchers and terminals; Chromium reported separately',
    seedWorkspace,
    workspacePreparationMs,
    harnessSha256: createHash('sha256')
      .update(await readFile(import.meta.filename))
      .digest('hex'),
    nodeVersion: process.version,
    platform: { os: process.platform, architecture: process.arch, cpus: os.cpus().length },
  };

  async function step(name: string, session: number, action: () => Promise<unknown>, timeoutMs = 90_000) {
    phase = name;
    const start = Date.now();
    // Individual UI and disk waits are bounded. Do not race abandoned mutations.
    try {
      const evidence = await action();
      const record = { name, session, ms: Date.now() - start, ok: true, evidence };
      steps.push(record);
      process.stdout.write(`${JSON.stringify(record)}\n`);
      return true;
    } catch (error) {
      const evidence = name.startsWith('collaboration-')
        ? await collaborationSnapshot?.().catch(() => undefined)
        : undefined;
      const record = {
        name,
        session,
        ms: Date.now() - start,
        ok: false,
        evidence,
        error: String(error).slice(0, 3_000),
      };
      steps.push(record);
      process.stdout.write(`${JSON.stringify(record)}\n`);
      await pages[Math.max(0, session)]
        ?.screenshot({ path: path.join(output, `failure-${name}-${session}.png`) })
        .catch(() => undefined);
      return false;
    } finally {
      if (Date.now() - start > timeoutMs) {
        result.overlongStep = name;
      }
    }
  }

  async function waitFor(check: () => Promise<boolean>, timeoutMs = 30_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await check()) {
        return;
      }
      await delay(100);
    }
    throw new Error(`Condition did not settle within ${timeoutMs} ms`);
  }

  async function reveal(trigger: Locator, target: Locator) {
    await trigger.waitFor({ state: 'visible', timeout: 30_000 });
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (await target.isVisible()) {
        return;
      }
      await trigger.click();
      if (
        await target
          .waitFor({ state: 'visible', timeout: 1_500 })
          .then(() => true)
          .catch(() => false)
      ) {
        return;
      }
    }
    throw new Error('View did not become visible');
  }

  async function editor(page: Page) {
    await page.bringToFront();
    const nativeInput = page.locator('#workbench-editor .monaco-editor:visible .native-edit-context');
    await page.locator('#workbench-editor .monaco-editor:visible').last().waitFor({ state: 'visible' });
    await page
      .locator(
        '#workbench-editor .monaco-editor:visible .native-edit-context, #workbench-editor .monaco-editor:visible textarea:visible',
      )
      .last()
      .waitFor({ state: 'attached' });
    const isNativeInput = (await nativeInput.count()) > 0;
    const input = isNativeInput
      ? nativeInput.last()
      : page.locator('#workbench-editor .monaco-editor:visible textarea').last();
    await input.waitFor({ state: isNativeInput ? 'attached' : 'visible', timeout: 20_000 });
    await input.focus();
    // Native EditContext focus updates Monaco's context keys asynchronously.
    await page.waitForTimeout(100);
    return input;
  }

  async function openFile(page: Page, relative: string) {
    const input = page.locator('#opensumi-quickpick-input');
    const row = page
      .getByLabel(path.basename(relative), { exact: true })
      .and(page.locator('#opensumi-quickpick-item'))
      .filter({ visible: true })
      .first();
    const firstLine = (await readFile(path.join(project.workspace, relative), 'utf8'))
      .split('\n')
      .find((line) => line.trim());
    const retries: string[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        await page.bringToFront();
        await page.keyboard.press('Escape');
        const deadline = Date.now() + 10_000;
        while (!(await input.isVisible()) && Date.now() < deadline) {
          await page.keyboard.press(`${modifier}+P`);
          await input.waitFor({ state: 'visible', timeout: 1_000 }).catch(() => undefined);
        }
        await input.fill(relative, { timeout: 5_000 });
        await row.waitFor({ state: 'visible', timeout: 10_000 });
        // Results rerender while extensions activate. Confirm using the same
        // keyboard workflow as a user instead of clicking a transient row.
        await input.press('Enter', { timeout: 5_000 });
        await input.waitFor({ state: 'hidden', timeout: 5_000 });
        await editor(page);
        await page.keyboard.press(`${modifier}+Home`);
        if (firstLine) {
          await waitFor(async () => {
            const texts = await page.locator('#workbench-editor .monaco-editor:visible .view-lines').allTextContents();
            return texts.some((text) => text.replace(/\s/g, '').includes(firstLine.replace(/\s/g, '')));
          }, 10_000);
        }
        return { file: relative, contentVerified: true, quickOpenAttempts: attempt, retries };
      } catch (error) {
        retries.push(String(error).slice(0, 1_000));
      }
    }
    throw new Error(`Quick Open failed after three attempts: ${retries.join('\n')}`);
  }

  async function search(page: Page) {
    const input = page.getByRole('textbox', { name: 'Enter search content' });
    await reveal(page.locator('#opensumi-left-tabbar #search'), input);
    await input.fill('');
    await input.press('Enter');
    await page.waitForFunction(() => !/\d+ results found in \d+ files/.test(document.body.innerText), undefined, {
      timeout: 10_000,
    });
    await input.fill(project.query);
    await input.press('Enter');
    await page.waitForFunction((expected) => document.body.innerText.includes(expected), project.expectedSearchResult, {
      timeout: 30_000,
    });
    return { query: project.query, verified: project.expectedSearchResult };
  }

  const probeContent =
    "import { pad } from './strings';\nexport const profileResult = pad(1, 3);\nexport const profileObject = { answer: 42, label: 'profile' };\n";
  function probePath(session: number) {
    return `packages/utils/src/runtime-profile-${variant}-${run}-${session}-${process.pid}.ts`;
  }

  async function replaceEditor(page: Page, text: string) {
    const input = await editor(page);
    await page.keyboard.press(`${modifier}+A`);
    await waitFor(async () => {
      const selected = await input.evaluate((element) => {
        const context = (
          element as unknown as { editContext?: { text: string; selectionStart: number; selectionEnd: number } }
        ).editContext;
        return !context || (context.selectionStart === 0 && context.selectionEnd === context.text.length);
      });
      if (!selected) {
        await page.keyboard.press(`${modifier}+A`);
      }
      return selected;
    }, 5_000);
    await page.keyboard.insertText(text);
  }

  async function saveAndVerify(page: Page, relative: string, expected: string) {
    await page.keyboard.press('Escape');
    await editor(page);
    await page.keyboard.press(`${modifier}+S`);
    await waitFor(
      async () => (await readFile(path.join(project.workspace, relative), 'utf8')).replace(/\r\n/g, '\n') === expected,
    );
    return { diskVerified: true, bytes: Buffer.byteLength(expected) };
  }

  function quote(value: string) {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  async function startTerminal(page: Page, name: string, command: string, timeoutMs: number) {
    await page.bringToFront();
    const input = page.getByRole('textbox', { name: 'Terminal input', exact: true });
    await reveal(page.getByText('TERMINAL', { exact: true }).first(), input);
    const logFile = path.join(output, `${name}.log`);
    const statusFile = path.join(output, `${name}.exit`);
    const receiptFile = path.join(output, `${name}.started`);
    await rm(statusFile, { force: true });
    await rm(receiptFile, { force: true });
    const wrapped = `printf started >${quote(receiptFile)}; (cd ${quote(project.workspace)} && ${command}) >${quote(logFile)} 2>&1; printf '%s' "$?" >${quote(statusFile)}`;
    await input.focus();
    await page.waitForTimeout(100);
    const dispatchedAt = Date.now();
    await page.keyboard.insertText(wrapped);
    await page.keyboard.press('Enter');
    await waitFor(
      async () =>
        readFile(receiptFile, 'utf8')
          .then((value) => value === 'started')
          .catch(() => false),
      10_000,
    );
    return {
      wait: async () => {
        await waitFor(
          async () =>
            readFile(statusFile, 'utf8')
              .then((value) => /^\d+$/.test(value))
              .catch(() => false),
          timeoutMs,
        );
        const exitCode = Number(await readFile(statusFile, 'utf8'));
        if (exitCode !== 0) {
          throw new Error(`${name} exited ${exitCode}; see ${logFile}`);
        }
        return {
          command,
          exitCode,
          logFile,
          invokedThrough: 'Workbench terminal',
          commandReceiptVerified: true,
          elapsedFromDispatchMs: Date.now() - dispatchedAt,
        };
      },
    };
  }

  async function terminal(page: Page, name: string, command: string, timeoutMs: number) {
    return (await startTerminal(page, name, command, timeoutMs)).wait();
  }

  const port = await new Promise<number>((resolve, reject) => {
    const socket = net.createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      if (!address || typeof address === 'string') {
        return reject(new Error('No port'));
      }
      socket.close(() => resolve(address.port));
    });
  });
  const url = `http://127.0.0.1:${port}`;
  const log = createWriteStream(path.join(output, 'server.log'));
  const server = spawn(process.execPath, [path.join(runtimeRoot, 'server/dist/main.js')], {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NODE_OPTIONS: '--max-old-space-size=512',
      PORT: String(port),
      OPENSUMI_RUNTIME_MODE: 'node',
      OPENSUMI_NODE_WATCHER_MODE: variant === 'shared-node' ? 'shared' : 'per-client',
      WORKSPACE_DIR: project.workspace,
      EXTENSION_DIR: project.extensionDirectory,
      MARKETPLACE_EXTENSION_DIR: project.extensionDirectory,
      EXTENSION_HOST_IDLE_TIMEOUT: '1000',
      EXTENSION_HOST_SHUTDOWN_TIMEOUT: '1000',
      TERMINAL_IDLE_TIMEOUT: '1000',
      TERMINAL_PERSISTENT_SESSION_TIMEOUT: '1000',
      ENABLE_COLLABORATION: project.collaboration ? '1' : '0',
      COLLABORATION_PORT: String(project.collaborationPort || 17_465),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout?.pipe(log, { end: false });
  server.stderr?.pipe(log, { end: false });
  let browserServer: Awaited<ReturnType<typeof chromium.launchServer>> | undefined;
  let browser: Awaited<ReturnType<typeof chromium.connect>> | undefined;

  async function sample(label: string) {
    if (!server.pid) {
      return;
    }
    samples.push({
      phase: label,
      elapsedMs: Date.now() - startedAt,
      service: await collectProcessTreeMemory(server.pid),
      browser:
        browserServer?.process().pid && browserServer.process().exitCode === null
          ? await collectProcessTreeMemory(browserServer.process().pid!).catch(() => undefined)
          : undefined,
    });
  }

  try {
    await waitFor(async () => {
      if (server.exitCode !== null) {
        throw new Error(`Server exited ${server.exitCode}`);
      }
      return fetch(`${url}/readyz`)
        .then((response) => response.ok)
        .catch(() => false);
    });
    result.serverReadyMs = Date.now() - startedAt;
    result.initialReadiness = await fetch(`${url}/readyz`).then((response) => response.json());
    browserServer = await chromium.launchServer({ headless: true, args: ['--disable-background-timer-throttling'] });
    browser = await chromium.connect(browserServer.wsEndpoint());
    await mkdir(watchDirectory, { recursive: true });
    await writeFile(path.join(watchDirectory, 'watch-sentinel.txt'), 'Directory expansion sentinel\n');
    if (project.collaboration) {
      await writeFile(sharedFile, 'export const sharedValue = 1;\n');
      ownedProbeFiles.push(sharedFile);
    }
    await writeFile(
      path.join(output, 'owned-processes.json'),
      JSON.stringify({
        profiler: process.pid,
        server: server.pid,
        browser: browserServer.process().pid,
        browserEndpoint: browserServer.wsEndpoint(),
      }),
    );
    for (let session = 0; session < sessions; session++) {
      if (project.nodeModulesLinked) {
        const file = path.join(project.workspace, probePath(session));
        await writeFile(file, probeContent);
        ownedProbeFiles.push(file);
      }
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      contexts.push(context);
      await context.addInitScript(() => {
        const native = window.WebSocket;
        const sockets: WebSocket[] = [];
        Object.assign(window, { __profileSockets: sockets });
        window.WebSocket = new Proxy(native, {
          construct(target, args) {
            const socket = Reflect.construct(target, args) as WebSocket;
            sockets.push(socket);
            return socket;
          },
        });
      });
      const page = await context.newPage();
      page.setDefaultTimeout(20_000);
      pages.push(page);
      page.on('websocket', (socket) => {
        socket.on('framereceived', ({ payload }) => {
          if (payload.length > 128 * 1024) {
            return;
          }
          const message = 'Runtime topology handshake already started for this physical connection';
          if (payload.toString().includes(message)) {
            handshakeEvidence.push({ session, phase, message });
          }
        });
      });
      page.on('console', (message) => {
        if (message.type() === 'error') {
          recordError(session, 'console', message.text());
        }
      });
      page.on('pageerror', (error) => recordError(session, 'pageerror', error.message));
      await step('cold-workbench-and-source', session, async () => {
        const query = new URLSearchParams({
          workspaceDir: project.workspace,
          userPreferenceDirName: `real-profile-${variant}-${run}-${session}-${process.pid}`,
        });
        await page.goto(`${url}/?${query}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForFunction(() => document.title.endsWith('— OpenSumi'), undefined, { timeout: 30_000 });
        await page.waitForTimeout(2_000);
        return openFile(page, project.smallFile);
      });
    }
    result.bootToAllEditorsMs = Date.now() - startedAt;
    await sample('all-editors-open');
    if (project.collaboration) {
      if (pages.length < 3) {
        throw new Error('Collaboration scenarios require three independent browser contexts');
      }
      const relative = sharedRelative;
      const readText = async (page: Page) =>
        page.evaluate(async (uri) => {
          const api = (
            window as unknown as {
              __OPENSUMI_E2E__?: { readEditorDocument(uri: string): Promise<string | null> };
            }
          ).__OPENSUMI_E2E__;
          if (!api?.readEditorDocument) {
            throw new Error('Collaboration tests require the E2E document reader');
          }
          return api.readEditorDocument(uri);
        }, pathToFileURL(sharedFile).toString());
      collaborationSnapshot = async () =>
        Promise.all(
          pages.map(async (page, session) => ({
            session,
            closed: page.isClosed(),
            text: page.isClosed() ? null : await readText(page),
          })),
        );
      const append = async (page: Page, value: string) => {
        await editor(page);
        await page.keyboard.press(`${modifier}+End`);
        await page.waitForTimeout(100);
        await page.keyboard.insertText(value);
        await waitFor(async () => (await readText(page))?.includes(value) ?? false, 5_000);
      };
      const converge = async (targets: Page[], markers: string[]) => {
        await waitFor(async () => {
          const texts = await Promise.all(targets.map(readText));
          return texts.every(
            (text) => text !== null && text === texts[0] && markers.every((marker) => text.includes(marker)),
          );
        });
        const text = (await readText(targets[0]))!;
        return {
          clients: targets.length,
          allEditorContentsEqual: true,
          markers,
          documentLength: text.length,
          documentSha256: createHash('sha256').update(text).digest('hex'),
          readSource: 'Monaco document model',
        };
      };
      const saveSharedDocument = async (page: Page) => {
        const expected = await readText(page);
        if (expected === null) {
          throw new Error('Shared document is not loaded');
        }
        await editor(page);
        await page.keyboard.press(`${modifier}+S`);
        await waitFor(async () => (await readFile(sharedFile, 'utf8')) === expected);
        return { savedContentVerified: true, savedSha256: createHash('sha256').update(expected).digest('hex') };
      };
      const initialized = await step('collaboration-initialize-same-document', -1, async () => {
        const opened: Array<Awaited<ReturnType<typeof openFile>>> = [];
        for (const page of pages) {
          opened.push(await openFile(page, relative));
        }
        const evidence = await converge(pages, ['sharedValue']);
        const texts = await Promise.all(pages.map(readText));
        if (texts.some((text) => text !== 'export const sharedValue = 1;\n')) {
          throw new Error('Initial shared document does not match disk exactly');
        }
        return { ...evidence, diskInitializationNotDuplicated: true, opened };
      });
      if (!initialized) {
        throw new Error('Shared document initialization failed; dependent collaboration scenarios were not run');
      }
      await step('collaboration-concurrent-edit-and-save', -1, async () => {
        // Create independent edits before merging; dispatch UI input sequentially
        // because native focus is shared by tabs in the same browser process.
        for (const index of [0, 1]) {
          await contexts[index].setOffline(true);
          await pages[index].evaluate(() =>
            (window as unknown as { __profileSockets: WebSocket[] }).__profileSockets.forEach((socket) =>
              socket.close(1000, 'profile concurrent edit partition'),
            ),
          );
        }
        await append(pages[0], '// LIVE_A\n');
        await append(pages[1], '// LIVE_B\n');
        await Promise.all([contexts[0].setOffline(false), contexts[1].setOffline(false)]);
        const evidence = await converge(pages, ['LIVE_A', 'LIVE_B']);
        return { ...evidence, ...(await saveSharedDocument(pages[0])) };
      });
      await Promise.all([contexts[0].setOffline(false), contexts[1].setOffline(false)]);
      await step('collaboration-undo-redo-keeps-remote-edit', 0, async () => {
        await append(pages[0], '// UNDO_LOCAL\n');
        await converge(pages, ['UNDO_LOCAL']);
        await append(pages[1], '// REMOTE_STAYS\n');
        await converge(pages, ['UNDO_LOCAL', 'REMOTE_STAYS']);
        await editor(pages[0]);
        await pages[0].keyboard.press(`${modifier}+Z`);
        await converge(pages, ['LIVE_A', 'LIVE_B', 'REMOTE_STAYS']);
        await waitFor(async () =>
          (await Promise.all(pages.map(readText))).every((text) => !text?.includes('UNDO_LOCAL')),
        );
        await pages[0].keyboard.press(`${modifier}+Shift+Z`);
        const evidence = await converge(pages, ['UNDO_LOCAL', 'REMOTE_STAYS']);
        return { ...evidence, remoteEditRetainedByUndo: true };
      });
      await step('collaboration-offline-merge', 1, async () => {
        await contexts[1].setOffline(true);
        await pages[1].evaluate(() =>
          (window as unknown as { __profileSockets: WebSocket[] }).__profileSockets.forEach((socket) =>
            socket.close(1000, 'profile collaboration partition'),
          ),
        );
        await append(pages[0], '// ONLINE_A\n');
        await append(pages[1], '// OFFLINE_B\n');
        await delay(3_000);
        await contexts[1].setOffline(false);
        const evidence = await converge(pages, ['LIVE_A', 'LIVE_B', 'ONLINE_A', 'OFFLINE_B']);
        return { ...evidence, offlineSeconds: 3, ...(await saveSharedDocument(pages[0])) };
      });
      await contexts[1].setOffline(false);
      await step('collaboration-reload-and-save-from-another-client', 1, async () => {
        await pages[1].reload({ waitUntil: 'domcontentloaded' });
        await pages[1].waitForFunction(() => document.title.endsWith('— OpenSumi'));
        await pages[1].waitForTimeout(2_000);
        const opened = await openFile(pages[1], relative);
        const evidence = await converge(pages, ['LIVE_A', 'LIVE_B', 'ONLINE_A', 'OFFLINE_B', 'REMOTE_STAYS']);
        return { ...evidence, ...(await saveSharedDocument(pages[1])), opened };
      });
      await step('collaboration-close-one-continue-editing', -1, async () => {
        await contexts[1].close();
        await append(pages[0], '// AFTER_ONE_LEFT\n');
        return converge([pages[0], pages[2]], ['AFTER_ONE_LEFT']);
      });
      await sample('collaboration-active');
      result.activeReadiness = await fetch(`${url}/readyz`).then((response) => response.json());
      await pages[0].screenshot({ path: path.join(output, 'workbench.png') });
    } else {
      for (let session = 0; session < pages.length; session++) {
        const page = pages[session];
        await step('cold-content-search', session, () => search(page));
        await step('warm-content-search', session, () => search(page));
        await step('large-file-open', session, () => openFile(page, project.largeFile));
        if (project.nodeModulesLinked) {
          const relative = probePath(session);
          await step('edit-save-on-disk', session, async () => {
            await openFile(page, relative);
            const text = `${probeContent}// edited session ${session}\n`;
            await replaceEditor(page, text);
            return saveAndVerify(page, relative, text);
          });
          await step('typescript-completion', session, async () => {
            await openFile(page, relative);
            await editor(page);
            await page.keyboard.press(`${modifier}+End`);
            await page.keyboard.insertText('\nprofileObject.');
            await page.keyboard.press('Control+Space');
            const suggestion = page.locator('.suggest-widget:visible').first();
            await suggestion.waitFor({ state: 'visible', timeout: 45_000 });
            await waitFor(async () => {
              const text = (await suggestion.textContent()) || '';
              return text.includes('answer') && text.includes('label');
            }, 45_000);
            await page.keyboard.press('Escape');
            return { semanticMembers: ['answer', 'label'] };
          });
          await step('restore-valid-source', session, async () => {
            await openFile(page, relative);
            await replaceEditor(page, probeContent);
            return saveAndVerify(page, relative, probeContent);
          });
        }
      }
      await delay(5_000);
      await sample('language-services-active');
      if (project.nodeModulesLinked) {
        // Send terminal input sequentially, acknowledge it, then overlap actual builds.
        // Concurrent focus/typing in different tabs can otherwise lose native terminal input.
        let frontendTask: Awaited<ReturnType<typeof startTerminal>> | undefined;
        let backendTask: Awaited<ReturnType<typeof startTerminal>> | undefined;
        await step('frontend-command-delivery', 0, async () => {
          frontendTask = await startTerminal(
            pages[0],
            'frontend',
            `pnpm --dir application exec tsc --noEmit && pnpm --dir application exec vite build --outDir ${quote(path.join(output, 'frontend-dist'))}`,
            180_000,
          );
          return { shellAcknowledged: true };
        });
        await step('backend-command-delivery', 1, async () => {
          backendTask = await startTerminal(
            pages[1],
            'backend',
            'cd application && GOTOOLCHAIN=local GOPROXY=off go build ./...',
            180_000,
          );
          return { shellAcknowledged: true };
        });
        await Promise.all([
          ...(frontendTask ? [step('frontend-pnpm-build', 0, () => frontendTask!.wait(), 180_000)] : []),
          ...(backendTask ? [step('backend-go-build', 1, () => backendTask!.wait(), 180_000)] : []),
          ...(pages.length >= 3 ? [step('search-during-build', 2, () => search(pages[2]))] : []),
          sample('builds-in-flight'),
        ]);
        await step('git-status-after-build', 0, () =>
          terminal(pages[0], 'git-status', 'git status --porcelain=v1', 30_000),
        );
        await sample('builds-complete');
        await step('scm-dirty-file-visible', 0, async () => {
          await pages[0].locator('#opensumi-left-tabbar #scm').click();
          await pages[0].getByPlaceholder(/Message/).waitFor({ state: 'visible' });
          const gitStatus = await readFile(path.join(output, 'git-status.log'), 'utf8');
          if (!gitStatus.includes('Dockerfile')) {
            throw new Error('Expected baseline modified Dockerfile in Git status');
          }
          await pages[0]
            .getByText('Dockerfile', { exact: true })
            .filter({ visible: true })
            .first()
            .waitFor({ state: 'visible' });
          return { modifiedFileVerifiedInGitAndUI: 'Dockerfile' };
        });
        await step('backend-source-open', Math.min(1, pages.length - 1), () =>
          openFile(pages[Math.min(1, pages.length - 1)], 'application/internal/runtime/local.go'),
        );
      } else {
        result.buildAndLanguageCoverage =
          'Not run: this second repository has no installed dependencies; file/search/large-file checks still use the full real source tree';
      }
      const watchFile = path.join(watchDirectory, 'watch-proof.txt');
      ownedProbeFiles.push(watchFile);
      await step('external-create-delete-all-sessions', -1, async () => {
        for (const page of pages) {
          await page.locator('#opensumi-left-tabbar #explorer').click();
          await page
            .locator('[class*="file_tree"]')
            .first()
            .evaluate((container) => {
              for (const element of Array.from(container.querySelectorAll('div'))) {
                if (element.clientHeight > 100 && element.scrollHeight > element.clientHeight) {
                  element.scrollTop = 0;
                }
              }
            });
          await page.getByLabel(watchDirectoryName, { exact: true }).filter({ visible: true }).first().dblclick();
          await page
            .getByLabel('watch-sentinel.txt', { exact: true })
            .filter({ visible: true })
            .first()
            .waitFor({ state: 'visible' });
        }
        await writeFile(watchFile, 'External file event in a real repository\n');
        await Promise.all(
          pages.map((page) =>
            page.waitForFunction(() => document.body.innerText.includes('watch-proof.txt'), undefined, {
              timeout: 30_000,
            }),
          ),
        );
        await rm(watchFile);
        await Promise.all(
          pages.map((page) =>
            page.waitForFunction(() => !document.body.innerText.includes('watch-proof.txt'), undefined, {
              timeout: 30_000,
            }),
          ),
        );
        return { sessions: pages.length, createAndDeleteVerified: true };
      });
      const burstDirectory = watchDirectory;
      await step('external-burst-200-files', -1, async () => {
        await mkdir(burstDirectory, { recursive: true });
        await Promise.all(
          Array.from({ length: 200 }, (_, index) =>
            writeFile(path.join(burstDirectory, `burst-${index}.txt`), `burst ${index}\n`),
          ),
        );
        await Promise.all(
          pages.map((page) =>
            page.waitForFunction(() => document.body.innerText.includes('burst-0.txt'), undefined, {
              timeout: 30_000,
            }),
          ),
        );
        await openFile(pages[0], `${watchDirectoryName}/burst-199.txt`);
        return { filesCreated: 200, finalFileContentVerified: true };
      });
      await rm(burstDirectory, { recursive: true, force: true });
      if (project.nodeModulesLinked) {
        await step('offline-edit-reconnect-save', 0, async () => {
          const page = pages[0];
          const relative = probePath(0);
          await openFile(page, relative);
          await contexts[0].setOffline(true);
          await page.evaluate(() => {
            const sockets = (window as unknown as { __profileSockets: WebSocket[] }).__profileSockets;
            sockets.forEach((socket) => socket.close(1000, 'profile offline simulation'));
          });
          const text = `${probeContent}// edit retained across reconnect\n`;
          await replaceEditor(page, text);
          await delay(3_000);
          await contexts[0].setOffline(false);
          await waitFor(
            () =>
              page.evaluate(() =>
                (window as unknown as { __profileSockets: WebSocket[] }).__profileSockets.some(
                  (socket) => socket.readyState === WebSocket.OPEN,
                ),
              ),
            30_000,
          );
          await saveAndVerify(page, relative, text);
          await search(page);
          return { offlineSeconds: 3, diskVerified: true, freshSearchVerified: true };
        });
        await contexts[0].setOffline(false);
      }
      await step('reload-reopen-source', 0, async () => {
        await pages[0].reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
        await pages[0].waitForFunction(() => document.title.endsWith('— OpenSumi'), undefined, { timeout: 30_000 });
        await pages[0].waitForTimeout(2_000);
        await openFile(pages[0], project.smallFile);
        return search(pages[0]);
      });
      for (let index = 0; index < 8; index++) {
        await sample('settled');
        await delay(1_000);
      }
      result.activeReadiness = await fetch(`${url}/readyz`).then((response) => response.json());
      await pages[0].screenshot({ path: path.join(output, 'workbench.png') });
    }
  } catch (error) {
    result.fatal = String(error);
  } finally {
    phase = 'teardown';
    await browser?.close().catch(() => undefined);
    await browserServer?.close().catch(() => undefined);
    await delay(3_000);
    if (server.pid && server.exitCode === null) {
      await sample('post-browser-close');
      result.postCloseReadiness = await fetch(`${url}/readyz`)
        .then((response) => response.json())
        .catch(() => undefined);
      server.kill('SIGTERM');
      await waitFor(async () => server.exitCode !== null || server.signalCode !== null, 35_000).catch(async () => {
        result.shutdownForced = true;
        server.kill('SIGKILL');
        await waitFor(async () => server.exitCode !== null || server.signalCode !== null, 5_000);
      });
    }
    log.end();
    result.serverExit = { code: server.exitCode, signal: server.signalCode };
    for (const file of ownedProbeFiles) {
      await rm(file, { force: true });
    }
    await rm(watchDirectory, { recursive: true, force: true });
    result.elapsedMs = Date.now() - startedAt;
    result.backgroundLoadAtEnd = os.loadavg();
    result.errorCounts = errorCounts;
    result.functionalPass = !result.fatal && steps.every((record) => record.ok);
    result.lifecyclePass = server.exitCode === 0 && !result.shutdownForced;
    await writeFile(path.join(output, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify({ output, functionalPass: result.functionalPass, errors: errors.length, elapsedMs: result.elapsedMs })}\n`,
    );
  }
}

void main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
