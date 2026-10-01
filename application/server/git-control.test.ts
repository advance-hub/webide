import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { Workbench } from './app';
import { loadConfig } from './config';
import { type Project, type Workspace, command } from './git';
import { ensureMergeRequest } from './git-control';
import { LocalRuntime } from './runtime';
import { hash, newID, now } from './store';

test('real Git smart-HTTP bridge and committed bundle publication preserve dirty files and reuse GitLab MR', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'webide-git-control-'));
  const token = 'fixture-source-token';
  let creates = 0;
  let failMR = true;
  const authorizations: string[] = [];
  const source = http.createServer((request, response) => {
    const url = new URL(request.url!, 'http://fixture');
    if (url.pathname.startsWith('/api/')) {
      assert.equal(request.headers['private-token'], token);
      response.setHeader('Content-Type', 'application/json');
      if (failMR) {
        response.statusCode = 403;
        response.end('{}');
        return;
      }
      if (request.method === 'POST') {
        creates++;
      }
      const record = {
        source_branch: 'feature/one',
        target_branch: 'main',
        web_url: `${origin}/repo/-/merge_requests/1`,
      };
      response.statusCode = request.method === 'POST' ? 201 : 200;
      response.end(JSON.stringify(request.method === 'POST' ? record : creates ? [record] : []));
      return;
    }
    const auth = request.headers.authorization || '';
    authorizations.push(auth);
    if (auth !== 'Basic ' + Buffer.from(`oauth2:${token}`).toString('base64')) {
      response.writeHead(401, { 'WWW-Authenticate': 'Basic realm="fixture"' });
      response.end();
      return;
    }
    const child = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.slice(1),
        REQUEST_METHOD: request.method,
        CONTENT_TYPE: String(request.headers['content-type'] || ''),
        HTTP_GIT_PROTOCOL: String(request.headers['git-protocol'] || ''),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let headers = Buffer.alloc(0);
    let parsed = false;
    child.stdout.on('data', (chunk) => {
      if (parsed) {
        response.write(chunk);
        return;
      }
      headers = Buffer.concat([headers, chunk]);
      const end = headers.indexOf('\r\n\r\n');
      if (end < 0) {
        return;
      }
      for (const row of headers.subarray(0, end).toString().split('\r\n')) {
        const colon = row.indexOf(':');
        const name = row.slice(0, colon);
        const value = row.slice(colon + 1).trim();
        if (name.toLowerCase() === 'status') {
          response.statusCode = Number(value.split(' ')[0]);
        } else {
          response.setHeader(name, value);
        }
      }
      parsed = true;
      response.write(headers.subarray(end + 4));
      headers = Buffer.alloc(0);
    });
    child.once('close', () => response.end());
    child.once('error', () => {
      response.statusCode = 500;
      response.end();
    });
    request.pipe(child.stdin);
    child.stdin.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => source.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${(source.address() as { port: number }).port}`;
  const config = { ...loadConfig({}), data: path.join(root, 'data'), port: 0 };
  const wb = new Workbench(config, (store) => {
    const driver = new LocalRuntime(config, store);
    driver.inspect = async () => ({ exists: true, ideReady: true, phase: 'fixture' });
    return driver;
  });
  try {
    const seed = path.join(root, 'seed');
    await command('git', ['init', '-b', 'main', seed]);
    await command('git', ['-C', seed, 'config', 'user.email', 'fixture@example.invalid']);
    await command('git', ['-C', seed, 'config', 'user.name', 'Fixture']);
    await writeFile(path.join(seed, 'hello.txt'), 'base');
    await command('git', ['-C', seed, 'add', '.']);
    await command('git', ['-C', seed, 'commit', '-m', 'base']);
    await command('git', ['clone', '--bare', seed, path.join(root, 'repo.git')]);
    await command('git', [`--git-dir=${path.join(root, 'repo.git')}`, 'config', 'http.receivepack', 'true']);
    await wb.listen();
    config.publicURL = `http://127.0.0.1:${(wb.server.address() as { port: number }).port}`;
    const owner = 'local-developer';
    const machine = { id: newID(), owner, driver: 'local' as const, createdAt: now() };
    wb.store.put('machine', machine);
    await wb.driver.provision(machine);
    const project: Project = {
      id: newID(),
      owner,
      name: 'fixture',
      url: origin + '/repo.git',
      branch: 'main',
      sha: '',
      status: 'queued',
      createdAt: now(),
    };
    wb.store.secret(`project:${project.id}`, { url: origin, provider: 'gitlab', token });
    await wb.repositories.import(project);
    const workspace: Workspace = {
      id: newID(),
      owner,
      machineId: machine.id,
      projectId: project.id,
      branch: 'feature/one',
      baseBranch: 'main',
      status: 'ready',
      createdAt: now(),
      updatedAt: now(),
    };
    wb.store.put('workspace', workspace);
    await wb.driver.prepare(workspace, project, wb.repositories);
    await wb.gitControl.install(workspace, project);
    const directory = wb.driver.projectDirectory(workspace);
    await command('git', ['-C', directory, 'config', 'user.email', 'fixture@example.invalid']);
    await command('git', ['-C', directory, 'config', 'user.name', 'Fixture']);
    await writeFile(path.join(directory, 'hello.txt'), 'committed');
    await command('git', ['-C', directory, 'commit', '-am', 'feature']);
    await writeFile(path.join(directory, 'dirty.txt'), 'keep uncommitted');
    await command('git', ['-C', directory, 'push', 'origin', 'HEAD']);
    const sha = (await command('git', ['-C', directory, 'rev-parse', 'HEAD'])).trim();
    await assert.rejects(() => wb.gitControl.publish(workspace, project, {}), /已推送/);
    assert.equal(wb.store.get<Workspace>('workspace', workspace.id)?.publishedSha, sha);
    failMR = false;
    assert.equal((await wb.gitControl.publish(workspace, project, {})).sha, sha);
    assert.match((await wb.gitControl.publish(workspace, project, {})).mergeRequestUrl, /merge_requests\/1/);
    assert.equal(creates, 1);
    assert.equal(await readFile(path.join(directory, 'dirty.txt'), 'utf8'), 'keep uncommitted');
    const lease = hash(`${machine.id}:${project.id}`).slice(0, 32);
    const url = `${config.publicURL}/git/${lease}.git/info/refs?service=git-upload-pack`;
    assert.equal((await fetch(url, { headers: { Cookie: 'workbench_session=ignored' } })).status, 401);
    const credential = wb.store.secret(`git-lease:${lease}`) as { token: string };
    assert.equal(
      (
        await fetch(url + '&target=other', {
          headers: { Authorization: 'Basic ' + Buffer.from(`${lease}:${credential.token}`).toString('base64') },
        })
      ).status,
      400,
    );
    const common = (
      await command('git', ['-C', directory, 'rev-parse', '--path-format=absolute', '--git-common-dir'])
    ).trim();
    assert.ok(!(await readFile(path.join(common, 'clouddev-bridge.json'), 'utf8')).includes(token));
    assert.ok(authorizations.includes('Basic ' + Buffer.from(`oauth2:${token}`).toString('base64')));
  } finally {
    await wb.close();
    await new Promise<void>((resolve) => source.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});

test('GitHub Enterprise and Gitee MR/PR adapters use the provider contract and reuse existing requests', async () => {
  for (const provider of ['github', 'gitee'] as const) {
    let created = false;
    let count = 0;
    const server = http.createServer((request, response) => {
      assert.equal(request.headers.authorization, `${provider === 'gitee' ? 'token' : 'Bearer'} fixture-token`);
      assert.ok(
        request.url?.startsWith(
          provider === 'github' ? '/api/v3/repos/team/repo/pulls' : '/api/v5/repos/team/repo/pulls',
        ),
      );
      const result = { head: { ref: 'feature' }, base: { ref: 'main' }, html_url: `${origin}/team/repo/pulls/1` };
      if (request.method === 'POST') {
        count++;
        created = true;
        response.statusCode = 201;
        response.end(JSON.stringify(result));
      } else {
        const query = new URL(request.url!, origin).searchParams;
        assert.equal(query.get('head'), provider === 'github' ? 'team:feature' : 'feature');
        response.end(JSON.stringify(created ? [result] : []));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    try {
      const project = { url: origin + '/team/repo.git' } as Project;
      const connection = { url: origin, provider, token: 'fixture-token' };
      assert.equal(
        await ensureMergeRequest(connection, project, 'feature', 'main', 'Fixture'),
        `${origin}/team/repo/pulls/1`,
      );
      await ensureMergeRequest(connection, project, 'feature', 'main', 'Fixture');
      assert.equal(count, 1);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }
});
