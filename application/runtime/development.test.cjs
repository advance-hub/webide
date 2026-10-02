'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { run, stop, loadConfig } = require('./development.cjs');
const { startAll, services } = require('./development.cjs');

function fixture(t, config) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opensumi-development-'));
  fs.mkdirSync(path.join(root, 'project', '.opensumi'), { recursive: true });
  const save = (value) =>
    fs.writeFileSync(path.join(root, 'project', '.opensumi', 'development.json'), JSON.stringify(value));
  if (config) save(config);
  t.after(async () => {
    await stop(root);
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, save, project: path.join(root, 'project') };
}

test('multiple services have independent processes, health, logs and stop controls', async (t) => {
  const ports = [];
  for (let i = 0; i < 2; i++) {
    const listener = net.createServer();
    await new Promise((r) => listener.listen(0, '127.0.0.1', r));
    ports.push(listener.address().port);
    await new Promise((r) => listener.close(r));
  }
  const { root, project } = fixture(t, {
    version: 1,
    init: ["node -e \"require('fs').writeFileSync('initialized','yes')\""],
    services: ports.map((port, i) => ({
      name: 'service' + i,
      cwd: 'app' + i,
      command: 'node server.cjs',
      port,
      portMode: 'fixed',
    })),
  });
  for (let i = 0; i < 2; i++) {
    fs.mkdirSync(path.join(project, 'app' + i));
    fs.writeFileSync(
      path.join(project, 'app' + i, 'server.cjs'),
      `console.log('service${i}');require('http').createServer((q,s)=>s.end('service${i}')).listen(Number(process.env.PORT),'0.0.0.0')`,
    );
  }
  await run(root, 'initialize');
  assert.equal(fs.readFileSync(path.join(project, 'initialized'), 'utf8'), 'yes');
  const report = await startAll(root);
  assert.equal(report.services.length, 2);
  assert(
    report.services.every((s) => s.ready),
    JSON.stringify(report),
  );
  await stop(root, 'service0');
  const partial = await services(root);
  assert.equal(partial.services[0].running, false);
  assert.equal(partial.services[1].ready, true);
  assert.equal(await (await fetch(`http://127.0.0.1:${ports[1]}`)).text(), 'service1');
  assert.match(fs.readFileSync(path.join(root, '.platform/services/service1/development.log'), 'utf8'), /service1/);
});

test('successful init is reused, lockfile changes invalidate it, failed init remains retryable', async (t) => {
  const { root, project, save } = fixture(t, {
    version: 1,
    init: ["node -e \"require('fs').appendFileSync('runs', 'x')\""],
  });
  assert.equal((await run(root, 'initialize')).cached, false);
  assert.equal((await run(root, 'initialize')).cached, true);
  fs.writeFileSync(path.join(project, 'package-lock.json'), '{}');
  assert.equal((await run(root, 'initialize')).cached, false);
  assert.equal(fs.readFileSync(path.join(project, 'runs'), 'utf8'), 'xx');
  save({ version: 1, init: ['exit 7'] });
  await assert.rejects(run(root, 'initialize'), /Initialization failed/);
  await assert.rejects(run(root, 'initialize'), /Initialization failed/);
});

test('missing config is IDE-only; cwd escape, reserved ports and invalid phases fail', async (t) => {
  const { root, save } = fixture(t);
  assert.equal((await run(root, 'initialize')).configured, false);
  save({ version: 1, cwd: '..' });
  assert.throws(() => loadConfig(root), /inside the project/);
  save({ version: 1, run: { command: 'node server.js', port: 4317 } });
  assert.throws(() => loadConfig(root), /Invalid run/);
  await assert.rejects(run(root, 'typo'), /Unknown development phase/);
});

test('personal workspaces receive distinct application ports with an explicit fixed-port override', (t) => {
  const config = { version: 1, run: { command: 'node server.cjs', port: 3000 } };
  const { root, save } = fixture(t, config);
  const old = process.env.CLOUDDEV_PREVIEW_PORT;
  t.after(() => {
    if (old === undefined) delete process.env.CLOUDDEV_PREVIEW_PORT;
    else process.env.CLOUDDEV_PREVIEW_PORT = old;
  });
  process.env.CLOUDDEV_PREVIEW_PORT = '22003';
  assert.equal(loadConfig(root).run.port, 22003);
  process.env.CLOUDDEV_PREVIEW_PORT = '22004';
  assert.equal(loadConfig(root).run.port, 22004);
  save({ ...config, run: { ...config.run, portMode: 'fixed' } });
  assert.equal(loadConfig(root).run.port, 3000);
});

test('managed HTTP app starts, reuses its process, and stops without losing user files', async (t) => {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const { root, project } = fixture(t, { version: 1, run: { command: 'node server.cjs', port, healthPath: '/ready' } });
  fs.writeFileSync(
    path.join(project, 'server.cjs'),
    `require('http').createServer((q,s)=>{s.statusCode=q.url==='/ready'?200:404;s.end('ready')}).listen(${port},'0.0.0.0')`,
  );
  assert.equal((await run(root, 'start')).ready, true);
  const state = fs.readFileSync(path.join(root, '.platform', 'development-process.json'), 'utf8');
  assert.equal((await run(root, 'start')).port, port);
  assert.equal(fs.readFileSync(path.join(root, '.platform', 'development-process.json'), 'utf8'), state);
  fs.writeFileSync(path.join(project, 'dirty.txt'), 'unsaved work');
  await stop(root);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/ready`));
  assert.equal(fs.readFileSync(path.join(project, 'dirty.txt'), 'utf8'), 'unsaved work');
});

test('does not attach to an occupied port returning an unhealthy response', async (t) => {
  const listener = require('node:http').createServer((q, s) => {
    s.statusCode = 503;
    s.end();
  });
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => listener.close(resolve)));
  const { root } = fixture(t, { version: 1, run: { command: 'sleep 60', port: listener.address().port } });
  await assert.rejects(run(root, 'start'), /端口已被/);
});

test('run command keeps image tools on PATH and uses the configured preview port', async (t) => {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const { root, project } = fixture(t, { version: 1, run: { command: 'fixture-tool', port } });
  const bin = path.join(project, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'fixture-tool'), '#!/bin/sh\nexec node server.cjs\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(project, 'server.cjs'),
    "require('http').createServer((q,s)=>s.end(process.env.PORT)).listen(Number(process.env.PORT),'0.0.0.0')",
  );
  const previousPath = process.env.PATH;
  const previousPort = process.env.PORT;
  process.env.PATH = `${bin}:${previousPath}`;
  process.env.PORT = '4317';
  t.after(() => {
    process.env.PATH = previousPath;
    if (previousPort === undefined) delete process.env.PORT;
    else process.env.PORT = previousPort;
  });
  assert.equal((await run(root, 'start')).ready, true);
  const response = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(await response.text(), String(port));
});
