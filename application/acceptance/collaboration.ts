import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { chromium } from 'playwright';

import { type Project, type Workspace } from '../server/domain/models';
import { type Machine } from '../server/domain/runtime';
import { loadConfig } from '../server/platform/config';
import { command } from '../server/platform/process';
import { hash, newID, now } from '../server/platform/store';
import { Workbench } from '../server/workbench';

import { appendDocument, openDocument, openTerminal, readDocument, saveDocument, undoDocument } from './browser-editor';

import type { BrowserContext, Page } from 'playwright';

async function harnessHashes() {
  return Object.fromEntries(
    await Promise.all(
      [import.meta.filename, path.join(import.meta.dirname, 'browser-editor.ts')].map(async (file) => [
        path.basename(file),
        createHash('sha256')
          .update(await readFile(file))
          .digest('hex'),
      ]),
    ),
  );
}

// 记录启动时源码，结束时再次核对，避免运行中的修改使证据对应到另一版本。
const loadedHarnessHashes = await harnessHashes();
const output = path.resolve(
  process.env.WEBIDE_ACCEPTANCE_OUTPUT || 'output/runtime-profiles/collaboration-20261002/result.json',
);
const root = await mkdtemp(path.join(os.tmpdir(), 'webide-collaboration-'));
const started = Date.now();
const rounds = Number(process.env.WEBIDE_COLLABORATION_ROUNDS || 3);
assert(Number.isInteger(rounds) && rounds > 0 && rounds <= 5);
const accounts = ['alice', 'bob', 'carol', 'dave', 'eve'];
const mode = process.env.WEBIDE_COLLABORATION_WATCHER_MODE || 'per-client';
const config = {
  ...loadConfig({
    WORKBENCH_RUNTIME_DRIVER: 'sandbox',
    WORKBENCH_LOCAL_DEMO: '0',
    WORKBENCH_VOLUME_BACKEND: 'docker',
    WORKBENCH_DOCKER_CONTEXT: process.env.WEBIDE_ACCEPTANCE_DOCKER_CONTEXT,
    OPEN_SANDBOX_URL: process.env.WEBIDE_ACCEPTANCE_URL,
    OPEN_SANDBOX_API_KEY: process.env.WEBIDE_ACCEPTANCE_KEY,
    OPEN_SANDBOX_IMAGE: process.env.WEBIDE_ACCEPTANCE_IMAGE,
    OPEN_SANDBOX_PLATFORM: process.env.WEBIDE_ACCEPTANCE_PLATFORM || 'linux/amd64',
    OPEN_SANDBOX_CPU: '4',
    OPEN_SANDBOX_MEMORY: '4Gi',
    OPENSUMI_NODE_WATCHER_MODE: mode,
  }),
  data: path.join(root, 'control'),
  port: 0,
  gitBridgeURL: 'https://control-plane.fixture.invalid',
};
assert(config.sandboxURL && config.sandboxKey && config.sandboxImage, '必须使用显式隔离的 OpenSandbox 配置');
const workbench = new Workbench(config);
const samples: Array<{
  scenario: string;
  round: number;
  elapsedMs: number;
  rssMiB: number;
  processes: unknown;
  hostLoad: number[];
}> = [];
const steps: Array<{ name: string; ms: number }> = [];
const errors: Array<{ account: string; phase: string; message: string; expected: boolean; reason?: string }> = [];
const transitions = new WeakMap<Page, { reason: string; until: number }>();
const owned: Workspace[] = [];
const result: Record<string, unknown> = {
  schemaVersion: 1,
  startedAt: now(),
  image: config.sandboxImage,
  node: process.version,
  hostPlatform: `${process.platform}/${process.arch}`,
  runtimePlatform: config.sandboxPlatform,
  watcherMode: mode,
  rounds,
  harnessSha256: loadedHarnessHashes,
  scope:
    '实际 IDE Server 与其扩展宿主、语言服务、watcher、终端进程的 RSS 合计；不含浏览器、控制面验收入口与 OpenSandbox 守护进程。',
  fixture: '同一个小型 TypeScript 仓库，镜像内置扩展，五个独立认证账户与 Chromium 上下文。',
  steps,
  samples,
  browserErrors: errors,
  pass: false,
};
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
let contexts: BrowserContext[] = [];
const sessions: Record<string, string> = {};
let phase = 'prepare';
const step = async (name: string, run: () => Promise<void>) => {
  phase = name;
  const started = Date.now();
  await run();
  steps.push({ name, ms: Date.now() - started });
  process.stdout.write(`${name}: passed\n`);
};
async function until(check: () => Promise<boolean>, label: string, timeout = 180000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await delay(500);
  }
  throw new Error(`${label} 超时`);
}
async function request(actor: string, route: string, body?: unknown, expected = 200) {
  const response = await fetch(config.publicURL + '/api' + route, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Cookie: `workbench_session=${sessions[actor]}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await response.json();
  assert.equal(response.status, expected, `${route}: ${JSON.stringify(data)}`);
  return data;
}
async function ready(id: string) {
  await until(async () => {
    const value = workbench.store.get<Workspace>('workspace', id)!;
    if (value.status === 'failed') {
      throw new Error(value.error);
    }
    return value.status === 'ready';
  }, 'IDE 启动');
  return workbench.store.get<Workspace>('workspace', id)!;
}
async function createWorkspace(actor: string): Promise<Workspace> {
  const source = path.join(root, actor);
  await command('git', ['init', '-b', 'main', source]);
  await command('git', ['-C', source, 'config', 'user.email', 'fixture@example.invalid']);
  await command('git', ['-C', source, 'config', 'user.name', 'Fixture']);
  await writeFile(path.join(source, 'README.md'), '# 五人协同隔离验收\n');
  await writeFile(path.join(source, 'collaboration.ts'), 'export const collaboration = "Node 24";\n');
  for (let index = 0; index < 100; index++) {
    await writeFile(path.join(source, `fixture-${index}.ts`), `export const value${index} = ${index};\n`);
  }
  await command('git', ['-C', source, 'add', '.']);
  await command('git', ['-C', source, 'commit', '-m', 'fixture']);
  const project = workbench.store.put<Project>('project', {
    id: newID(),
    owner: actor,
    name: '五人协同验收',
    url: source,
    branch: 'main',
    status: 'importing',
    createdAt: now(),
  } as Project);
  await workbench.repositories.import(project);
  const workspace = await request(
    actor,
    '/workspaces',
    { projectId: project.id, branch: 'feature/collaboration', baseBranch: 'main' },
    202,
  );
  owned.push(workspace);
  return ready(workspace.id);
}
async function pagesFor(workspaces: Workspace[]): Promise<Page[]> {
  contexts = [];
  const pages: Page[] = [];
  for (let index = 0; index < accounts.length; index++) {
    const actor = accounts[index];
    const workspace = workspaces[index];
    const context = await browser!.newContext({
      viewport: { width: 1440, height: 1000 },
      permissions: ['clipboard-read', 'clipboard-write'],
    });
    contexts.push(context);
    await context.addCookies([
      { name: 'workbench_session', value: sessions[actor], url: config.publicURL, httpOnly: true, sameSite: 'Strict' },
    ]);
    const page = await context.newPage();
    page.setDefaultTimeout(60000);
    page.on('pageerror', (error) => {
      const transition = transitions.get(page);
      // 仅在主动断网、关闭或撤权期间标记 RPC 关闭；原始错误仍全部保存。
      const expected = Boolean(
        transition && transition.until >= Date.now() && /^RPC connection closed(?:\n|$)/.test(error.message),
      );
      errors.push({
        account: actor,
        phase,
        message: error.message,
        expected,
        reason: expected ? transition?.reason : undefined,
      });
    });
    await page.goto(config.publicURL + '/#/workspaces', { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '进入 IDE', exact: true }).first().waitFor({ state: 'visible' });
    if (index > 0 && workspaces.every((w) => w.id === workspaces[0].id)) {
      assert.equal(await page.getByRole('button', { name: '管理', exact: true }).count(), 0);
    }
    const entry = await request(actor, `/workspaces/${workspace.id}/enter`, {});
    await page.goto(entry.url, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.title.endsWith('— OpenSumi'));
    assert.equal(
      await page.evaluate(
        () =>
          (window as unknown as { __OPENSUMI_WORKSPACE__: { user: { id: string } } }).__OPENSUMI_WORKSPACE__.user.id,
      ),
      hash(actor),
    );
    await openDocument(page, 'collaboration.ts');
    process.stdout.write(`${actor}: 实际编辑器已打开\n`);
    pages.push(page);
  }
  for (let index = 0; index < pages.length; index++) {
    const page = pages[index];
    const actor = accounts[index];
    const workspace = workspaces[index];
    const terminalMarker = `TERMINAL_${actor}`;
    await workbench.sandbox!.run(workspace.envId!, `rm -f '/tmp/webide-terminal-${terminalMarker}'`);
    const receipt = await openTerminal(page, terminalMarker);
    await until(
      async () =>
        (await workbench.sandbox!.run(workspace.envId!, `cat '${receipt}' 2>/dev/null || true`)) === terminalMarker,
      '浏览器终端执行回执',
      15000,
    );
    await workbench.sandbox!.run(workspace.envId!, `rm '${receipt}'`);
    process.stdout.write(`${actor}: 实际终端已执行\n`);
  }
  return pages;
}
async function equalDocuments(pages: Page[], markers: string[]): Promise<string> {
  let texts: string[] = [];
  await until(
    async () => {
      texts = [];
      for (const page of pages) {
        texts.push(await readDocument(page));
      }
      return texts.every((text) => text === texts[0] && markers.every((marker) => text.includes(marker)));
    },
    '五份完整文档收敛',
    45000,
  );
  return texts[0];
}
async function diskText(workspace: Workspace): Promise<string> {
  return workbench.sandbox!.run(
    workspace.envId!,
    `cat '${workbench.driver.projectDirectory(workspace)}/collaboration.ts'`,
  );
}
const processProbe =
  "const fs=require('node:fs'); const rows=[]; for(const name of fs.readdirSync('/proc').filter(x=>/^\\d+$/.test(x))) { try {const status=fs.readFileSync('/proc/'+name+'/status','utf8'); rows.push({pid:+name,ppid:+status.match(/^PPid:\\s+(\\d+)/m)[1],rssKiB:+(status.match(/^VmRSS:\\s+(\\d+)/m)?.[1]||0),command:fs.readFileSync('/proc/'+name+'/cmdline','utf8').split('\\0').join(' ').slice(0,400)});} catch{}} process.stdout.write(JSON.stringify(rows));";
async function processTree(workspace: Workspace) {
  const environment = await workbench.driver.inspect(workspace);
  const pid = (environment.runtime as { pid: number }).pid;
  const rows = JSON.parse(
    await workbench.sandbox!.run(workspace.envId!, `node -e '${processProbe.replaceAll("'", "'\\''")}'`),
  ) as Array<{ pid: number; ppid: number; rssKiB: number; command: string }>;
  const ids = new Set([pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (ids.has(row.ppid) && !ids.has(row.pid)) {
        ids.add(row.pid);
        changed = true;
      }
    }
  }
  const processes = rows.filter((row) => ids.has(row.pid));
  assert(processes.some((row) => row.pid === pid));
  return processes;
}
async function sample(scenario: string, round: number, workspaces: Workspace[]) {
  const unique = [...new Map(workspaces.map((w) => [w.id, w])).values()];
  const trees = await Promise.all(unique.map(processTree));
  samples.push({
    scenario,
    round,
    elapsedMs: Date.now() - started,
    rssMiB: trees.flat().reduce((sum, row) => sum + row.rssKiB / 1024, 0),
    processes: trees,
    hostLoad: os.loadavg(),
  });
}
async function measure(scenario: string, round: number, workspaces: Workspace[]) {
  await delay(30000);
  for (let index = 0; index < 30; index++) {
    await sample(scenario, round, workspaces);
    {
      const trees = samples.at(-1)!.processes as Array<Array<{ command: string }>>;
      for (const tree of trees) {
        assert.equal(
          tree.filter((row) => /\/ext\.process\.js(?: |$)/.test(row.command)).length,
          scenario === 'shared-workspace' ? 5 : 1,
          '每个独立浏览器必须拥有实际扩展宿主，不能以未激活的空连接测量容量',
        );
        assert.equal(
          tree.filter((row) => /(?:^|\/)opencode(?: |$)/.test(row.command)).length,
          0,
          '没有发送 AI 请求或打开历史时，不应为浏览器预启动 OpenCode',
        );
      }
    }
    await delay(1000);
  }
}
async function closePages() {
  for (const context of contexts) {
    for (const page of context.pages()) {
      transitions.set(page, { reason: '主动关闭浏览器', until: Infinity });
    }
    await context.close();
  }
  contexts = [];
}
try {
  if (process.env.WEBIDE_ACCEPTANCE_PREFLIGHT === '1') {
    await step('同一隔离环境先完成控制面六阶段回归', async () => {
      const preflightOutput = path.join(path.dirname(output), 'control-plane.json');
      process.stdout.write(
        await command(
          process.execPath,
          [
            path.join(config.root, 'node_modules/tsx/dist/cli.mjs'),
            path.join(config.root, 'application/acceptance/opensandbox.ts'),
          ],
          { env: { ...process.env, WEBIDE_ACCEPTANCE_OUTPUT: preflightOutput }, timeout: 600000 },
        ),
      );
      const preflight = JSON.parse(await readFile(preflightOutput, 'utf8'));
      assert.equal(preflight.pass, true);
      result.controlPlane = { pass: true, steps: preflight.steps };
    });
  }
  await until(
    () =>
      workbench.sandbox!.health().then(
        () => true,
        () => false,
      ),
    '隔离 OpenSandbox 启动',
  );
  await workbench.listen();
  config.port = (workbench.server.address() as { port: number }).port;
  config.publicURL = `http://127.0.0.1:${config.port}`;
  for (const actor of [...accounts, 'outsider']) {
    workbench.store.put('user', { id: actor, owner: actor, username: actor, name: actor });
    sessions[actor] = workbench.store.createSession(actor);
  }
  browser = await chromium.launch({ headless: true, args: ['--disable-background-timer-throttling'] });
  const shared = await createWorkspace('alice');
  await step('邀请四名成员与所有者管理权限', async () => {
    const ownerContext = await browser!.newContext({ viewport: { width: 1440, height: 1000 } });
    try {
      await ownerContext.addCookies([{ name: 'workbench_session', value: sessions.alice, url: config.publicURL }]);
      const page = await ownerContext.newPage();
      await page.goto(config.publicURL + '/#/workspaces');
      await page.getByRole('button', { name: '管理', exact: true }).first().click();
      for (const actor of accounts.slice(1)) {
        await page.getByRole('button', { name: `管理 ${shared.branch} 的成员` }).click();
        await page.getByRole('textbox', { name: '成员用户名' }).fill(actor);
        const response = page.waitForResponse(
          (value) => value.url().endsWith(`/workspaces/${shared.id}/members`) && value.request().method() === 'POST',
        );
        await page.getByRole('textbox', { name: '成员用户名' }).press('Enter');
        assert.equal((await response).status(), 200);
        await page.getByRole('textbox', { name: '成员用户名' }).waitFor({ state: 'hidden' });
      }
      await mkdir(path.dirname(output), { recursive: true });
      await page.screenshot({ path: path.join(path.dirname(output), 'members-ui.png'), fullPage: true });
    } finally {
      await ownerContext.close();
    }
    await request('outsider', `/workspaces/${shared.id}/enter`, {}, 404);
    await request('bob', `/workspaces/${shared.id}/delete`, {}, 404);
    await request('bob', `/workspaces/${shared.id}/members`, { username: 'outsider' }, 404);
  });
  for (let round = 1; round <= rounds; round++) {
    const workspaces = accounts.map(() => shared);
    phase = `同一工作区第${round}轮认证编辑器与终端`;
    const pages = await pagesFor(workspaces);
    await equalDocuments(pages, ['export const collaboration = "Node 24";']);
    const markers = accounts.map((actor) => `// ${actor}_round_${round}\n`);
    await step(`同一工作区第${round}轮五人并发编辑与真实磁盘保存`, async () => {
      for (let index = 0; index < contexts.length; index++) {
        transitions.set(pages[index], { reason: '主动断网', until: Infinity });
        await contexts[index].setOffline(true);
      }
      for (let index = 0; index < pages.length; index++) {
        await appendDocument(pages[index], markers[index]);
      }
      for (let index = 0; index < pages.length; index++) {
        const text = await readDocument(pages[index]);
        assert(text.includes(markers[index]));
        assert(markers.filter((_, other) => other !== index).every((marker) => !text.includes(marker)));
      }
      for (let index = 0; index < contexts.length; index++) {
        await contexts[index].setOffline(false);
        transitions.set(pages[index], { reason: '恢复网络后一秒内的关闭回调', until: Date.now() + 1000 });
      }
      const expected = await equalDocuments(pages, markers);
      await saveDocument(pages[0]);
      await until(async () => (await diskText(shared)).trimEnd() === expected.trimEnd(), '磁盘保存', 30000);
    });
    await step(`同一工作区第${round}轮撤销重做与离线重连`, async () => {
      await undoDocument(pages[0]);
      await equalDocuments(pages, markers.slice(1));
      assert(!(await readDocument(pages[0])).includes(markers[0]));
      await undoDocument(pages[0], true);
      await equalDocuments(pages, markers);
      transitions.set(pages[1], { reason: '主动断网', until: Infinity });
      await contexts[1].setOffline(true);
      await appendDocument(pages[1], `// offline_${round}\n`);
      await appendDocument(pages[2], `// online_${round}\n`);
      await contexts[1].setOffline(false);
      transitions.set(pages[1], { reason: '恢复网络后一秒内的关闭回调', until: Date.now() + 1000 });
      await equalDocuments(pages, [`offline_${round}`, `online_${round}`]);
      transitions.set(pages[3], { reason: '主动刷新', until: Date.now() + 1000 });
      await pages[3].reload({ waitUntil: 'domcontentloaded' });
      await openDocument(pages[3], 'collaboration.ts');
      await equalDocuments(pages, markers);
      await saveDocument(pages[4]);
    });
    await step(`同一工作区第${round}轮内存采样`, async () => measure('shared-workspace', round, workspaces));
    if (round === rounds) {
      await step('同一 Server 五个活跃浏览器与终端下停止并回收全部进程', async () => {
        const processes = await processTree(shared);
        for (const page of pages) {
          transitions.set(page, { reason: '主动停止 Server', until: Infinity });
        }
        await request('alice', `/workspaces/${shared.id}/stop`, {}, 202);
        await until(
          async () => workbench.store.get<Workspace>('workspace', shared.id)?.status === 'stopped',
          '共享 Server 停止',
        );
        await workbench.sandbox!.run(shared.envId!, processes.map(({ pid }) => `test ! -d /proc/${pid}`).join(' && '));
      });
    }
    await closePages();
  }
  await request('alice', `/workspaces/${shared.id}/start`, {}, 202);
  await ready(shared.id);
  await step('活跃连接移除成员并维持其他四人编辑', async () => {
    const pages = await pagesFor(accounts.map(() => shared));
    transitions.set(pages[4], { reason: '主动撤销成员', until: Infinity });
    await request('alice', `/workspaces/${shared.id}/members`, { username: 'eve', remove: true });
    await request('eve', `/workspaces/${shared.id}/enter`, {}, 404);
    await appendDocument(pages[0], '// remaining_four\n');
    await equalDocuments(pages.slice(0, 4), ['remaining_four']);
    const revoked = await pages[4].reload({ waitUntil: 'domcontentloaded' });
    assert.equal(revoked?.status(), 401);
    await closePages();
    for (const actor of accounts.slice(1, 4)) {
      await request('alice', `/workspaces/${shared.id}/members`, { username: actor, remove: true });
    }
  });
  const separate: Workspace[] = [shared];
  for (const actor of accounts.slice(1)) {
    separate.push(await createWorkspace(actor));
  }
  await step('五台开发机的真实操作系统与账户隔离', async () => {
    assert.equal(new Set(separate.map((w) => w.envId)).size, 5);
    await workbench.sandbox!.run(
      shared.envId!,
      `printf private > '${workbench.driver.projectDirectory(shared)}/owner-only.txt'`,
    );
    for (const workspace of separate.slice(1)) {
      await workbench.sandbox!.run(
        workspace.envId!,
        `test ! -e '${workbench.driver.projectDirectory(shared)}/owner-only.txt'`,
      );
    }
    await request('bob', `/workspaces/${shared.id}/environment`, undefined, 404);
  });
  for (let round = 1; round <= rounds; round++) {
    phase = `独立工作区第${round}轮认证编辑器与终端`;
    const pages = await pagesFor(separate);
    await step(`独立工作区第${round}轮五人编辑与内容隔离`, async () => {
      for (let index = 0; index < pages.length; index++) {
        const marker = `// independent_${accounts[index]}_${round}\n`;
        await appendDocument(pages[index], marker);
        await saveDocument(pages[index]);
        const text = await readDocument(pages[index]);
        assert(text.includes(marker));
        for (const other of accounts.filter((actor) => actor !== accounts[index])) {
          assert(!text.includes(`independent_${other}_${round}`));
        }
        await until(async () => (await diskText(separate[index])).includes(marker), '独立工作区保存');
      }
    });
    await step(`独立工作区第${round}轮内存采样`, async () => measure('independent-workspaces', round, separate));
    if (round < rounds) {
      await closePages();
    }
  }
  await step('五个活跃浏览器下停止 Server 与回收采样进程', async () => {
    const last = samples.filter((s) => s.scenario === 'independent-workspaces').at(-1)!;
    const pids = last.processes as Array<Array<{ pid: number }>>;
    for (const context of contexts) {
      for (const page of context.pages()) {
        transitions.set(page, { reason: '主动停止 Server', until: Infinity });
      }
    }
    for (let index = 0; index < separate.length; index++) {
      await request(accounts[index], `/workspaces/${separate[index].id}/stop`, {}, 202);
      await until(
        async () => workbench.store.get<Workspace>('workspace', separate[index].id)?.status === 'stopped',
        '活跃 Server 停止',
      );
      await workbench.sandbox!.run(
        separate[index].envId!,
        pids[index].map(({ pid }) => `test ! -d /proc/${pid}`).join(' && '),
      );
    }
    await closePages();
  });
  result.summary = Object.fromEntries(
    ['shared-workspace', 'independent-workspaces'].map((scenario) => {
      const values = Array.from({ length: rounds }, (_, i) => {
        const rows = samples
          .filter((s) => s.scenario === scenario && s.round === i + 1)
          .map((s) => s.rssMiB)
          .sort((a, b) => a - b);
        return rows[Math.ceil(rows.length * 0.95) - 1];
      });
      const sorted = [...values].sort((a, b) => a - b);
      return [scenario, { roundP95RssMiB: values, medianP95RssMiB: sorted[Math.floor(sorted.length / 2)] }];
    }),
  );
  result.unexpectedBrowserErrors = errors.filter((error) => !error.expected).length;
  assert.equal(result.unexpectedBrowserErrors, 0, JSON.stringify(errors.filter((error) => !error.expected)));
  result.pass = true;
} catch (error) {
  result.error = (error as Error).stack;
  // SDK 失败时仍通过本轮专属 daemon 读取状态，保留 OOM 与资源压力证据。
  result.failureHost = { load: os.loadavg(), freeMiB: os.freemem() / 1024 / 1024 };
  for (const [name, args] of [
    ['failure-containers.txt', ['ps', '-a', '--format', '{{.ID}} {{.Names}} {{.Status}}']],
    ['failure-resource.txt', ['stats', '--no-stream', '--format', '{{.Name}} {{.MemUsage}} {{.CPUPerc}} {{.PIDs}}']],
  ] as const) {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(
      path.join(path.dirname(output), name),
      await command('docker', ['--context', config.dockerContext, ...args], { timeout: 45000 }).catch(String),
    );
  }
  for (const workspace of owned) {
    const current = workbench.store.get<Workspace>('workspace', workspace.id) || workspace;
    const args = [
      '--context',
      config.dockerContext,
      'exec',
      `sandbox-${current.envId}`,
      'sh',
      '-c',
      'for file in /workspace/workspaces/*/.platform/ide.log; do tail -120 "$file"; done; ps -eo pid,ppid,rss,comm; cat /sys/fs/cgroup/memory.events; cat /sys/fs/cgroup/memory.current',
    ];
    await writeFile(
      path.join(path.dirname(output), `failure-runtime-${workspace.id}.txt`),
      await command('docker', args, { timeout: 45000 }).catch(String),
    );
  }
  throw error;
} finally {
  for (let index = 0; index < contexts.length; index++) {
    const page = contexts[index].pages()[0];
    if (page && !result.pass) {
      await page.screenshot({ path: path.join(path.dirname(output), `failure-${index}.png`) }).catch(() => {});
      await writeFile(
        path.join(path.dirname(output), `failure-${index}.txt`),
        await page
          .locator('body')
          .innerText()
          .catch(() => '页面已关闭'),
      ).catch(() => {});
    }
  }
  await closePages();
  await browser?.close();
  const cleanupErrors: string[] = [];
  for (const workspace of owned) {
    await workbench.driver
      .stop(workbench.store.get<Workspace>('workspace', workspace.id) || workspace)
      .catch((error: Error) => cleanupErrors.push(error.message));
  }
  for (const machine of workbench.store.list<Machine>('machine')) {
    await workbench.driver.release(machine).catch((error: Error) => cleanupErrors.push(error.message));
  }
  await workbench.close().catch((error: Error) => cleanupErrors.push(error.message));
  result.cleanupErrors = cleanupErrors;
  if (cleanupErrors.length) {
    result.pass = false;
    process.exitCode = 1;
  }
  result.finishedAt = now();
  result.unexpectedBrowserErrors = errors.filter((error) => !error.expected).length;
  result.harnessSha256AtFinish = await harnessHashes();
  result.harnessChanged = JSON.stringify(loadedHarnessHashes) !== JSON.stringify(result.harnessSha256AtFinish);
  if (result.harnessChanged) {
    result.pass = false;
    process.exitCode = 1;
  }
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(result, null, 2) + '\n');
  await rm(root, { recursive: true, force: true });
}
