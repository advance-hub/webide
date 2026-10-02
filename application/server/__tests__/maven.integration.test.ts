import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { loadConfig } from '../platform/config';
import { newID, now } from '../platform/store';
import { Workbench } from '../workbench';

import type { Workspace } from '../domain/models';
import type { Machine } from '../domain/runtime';

test(
  'Maven wrapper jobs: inspection, machine-wide exclusion, cancellation, history and credential redaction',
  { timeout: 30000 },
  async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'opensumi-maven-'));
    const config = { ...loadConfig({}), data: root, port: 0 };
    const workbench = new Workbench(config);
    try {
      const machine: Machine = { id: newID(), owner: 'local-developer', driver: 'local', createdAt: now() };
      workbench.store.put('machine', machine);
      await workbench.driver.provision(machine);
      const workspace: Workspace = {
        id: newID(),
        owner: machine.owner,
        projectId: newID(),
        machineId: machine.id,
        branch: 'main',
        status: 'ready',
        createdAt: now(),
        updatedAt: now(),
      };
      workbench.store.put('workspace', workspace);
      const directory = workbench.driver.projectDirectory(workspace);
      await mkdir(directory, { recursive: true });
      await mkdir(path.join(workbench.driver.root(workspace), 'home/.m2'), { recursive: true });
      await writeFile(
        path.join(directory, 'pom.xml'),
        '<project><modelVersion>4.0.0</modelVersion><groupId>fixture</groupId><artifactId>fixture</artifactId><version>1</version></project>',
      );
      await writeFile(
        path.join(workbench.driver.root(workspace), 'home/.m2/settings.xml'),
        '<settings><servers><server><id>private</id><username>fixture</username><password>fixture-password</password></server></servers></settings>',
      );
      // 仓库内的启动包装器执行真实子进程，测试不下载 Maven 插件。
      await writeFile(
        path.join(directory, 'mvnw'),
        `#!/bin/sh
printf '%s\n' "$*"
printf 'credential fixture-password token=fixture-token\n'
case "$*" in *test) "${process.execPath}" -e 'setTimeout(() => {}, 30000)';; esac
`,
      );
      await workbench.listen();
      config.port = (workbench.server.address() as { port: number }).port;
      config.publicURL = `http://127.0.0.1:${config.port}`;
      const request = (endpoint: string, body?: unknown) =>
        fetch(config.publicURL + `/api/workspaces/${workspace.id}/${endpoint}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      const report = (await (await request('maven')).json()) as { report: { detected: boolean; wrapper: boolean } };
      assert.equal(report.report.detected, true);
      assert.equal(report.report.wrapper, true);
      const wait = async (condition: (workspace: Workspace) => boolean) => {
        for (let attempt = 0; attempt < 120; attempt++) {
          const current = workbench.workspace(workspace.id, machine.owner);
          if (condition(current)) {
            return current;
          }
          await delay(100);
        }
        throw new Error('Maven job did not complete');
      };
      assert.equal(
        (await request('maven', { action: 'build', profiles: ['production'], skipTests: false })).status,
        202,
      );
      const built = await wait((current) => current.mavenJob?.status === 'done');
      const log = (await (await request(`maven?job=${built.mavenJob!.id}`)).json()) as { log: { text: string } };
      assert.match(log.log.text, /-P production/);
      assert.ok(!log.log.text.includes('fixture-password') && !log.log.text.includes('fixture-token'));
      assert.equal((await request('maven', { action: 'test', skipTests: true })).status, 400);
      assert.equal((await request('maven', { action: 'test' })).status, 202);
      const running = await wait((current) => current.mavenJob?.status === 'running');
      assert.equal((await request('maven', { action: 'build' })).status, 409);
      assert.equal((await request('stop', {})).status, 409);
      assert.equal((await request('maven-cancel', { id: running.mavenJob!.id })).status, 200);
      const cancelled = await wait((current) => current.mavenJob?.status === 'cancelled');
      assert.equal(cancelled.mavenHistory![0].id, built.mavenJob!.id);
      assert.equal(cancelled.status, 'ready');
    } finally {
      await workbench.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);
