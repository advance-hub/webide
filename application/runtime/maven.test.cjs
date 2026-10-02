'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { spawn } = require('node:child_process');

const cli = path.join(__dirname, 'maven.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opensumi-maven-'));
  const project = path.join(root, 'project');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(project);
  fs.mkdirSync(bin);
  fs.mkdirSync(path.join(root, 'home', '.m2'), { recursive: true });
  fs.writeFileSync(path.join(bin, 'java'), '#!/bin/sh\necho \'openjdk version "21.0.1"\' >&2\n', { mode: 0o755 });
  fs.writeFileSync(
    path.join(bin, 'mvn'),
    '#!/bin/sh\nif [ "$1" = "-version" ]; then echo "Apache Maven 3.9.16"; else printf "%s\\n" "$@" > "$MAVEN_ARGS"; fi\n',
    { mode: 0o755 },
  );
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const run = (action, options = {}) => {
    const result = spawnSync(
      process.execPath,
      [cli, action, root, Buffer.from(JSON.stringify(options)).toString('base64')],
      {
        encoding: 'utf8',
        env: { ...process.env, PATH: bin + path.delimiter + process.env.PATH, MAVEN_ARGS: path.join(root, 'args') },
      },
    );
    return { ...result, report: JSON.parse(result.stdout) };
  };
  return { root, project, run };
}

test('cancelling a running Maven task terminates its process group and records cancelled', async (t) => {
  const { root, project, run } = fixture(t);
  fs.writeFileSync(path.join(project, 'pom.xml'), '<project/>');
  fs.writeFileSync(
    path.join(root, 'bin/mvn'),
    '#!/bin/sh\nif [ "$1" = "-version" ]; then echo Maven; else echo $$ > "$MAVEN_PID"; exec sleep 120; fi\n',
    { mode: 0o755 },
  );
  const id = 'c'.repeat(32),
    pidfile = path.join(root, 'pid'),
    child = spawn(process.execPath, [cli, 'build', root, Buffer.from(JSON.stringify({ id })).toString('base64')], {
      env: { ...process.env, PATH: path.join(root, 'bin') + path.delimiter + process.env.PATH, MAVEN_PID: pidfile },
    });
  let output = '';
  child.stdout.on('data', (b) => (output += b));
  const done = new Promise((r) => child.on('close', r));
  t.after(() => child.kill('SIGKILL'));
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(pidfile) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
  assert(fs.existsSync(pidfile), 'mock Maven never started');
  const pid = Number(fs.readFileSync(pidfile));
  assert.equal(run('cancel', { id }).status, 0);
  assert.equal(await done, 0);
  assert.equal(JSON.parse(output).lastStatus, 'cancelled');
  assert.throws(() => process.kill(pid, 0), /ESRCH/);
});

test('Maven prep uses the selected project, settings and persistent cache', (t) => {
  const { root, project, run } = fixture(t);
  fs.writeFileSync(path.join(project, 'pom.xml'), '<project/>');
  fs.writeFileSync(path.join(root, 'home', '.m2', 'settings.xml'), '<settings/>');
  const result = run('prepare');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.report.detected, true);
  assert.equal(result.report.lastStatus, 'done');
  const args = fs.readFileSync(path.join(root, 'args'), 'utf8');
  assert.match(args, /dependency:go-offline/);
  assert.match(args, /-Dmaven.repo.local=.*home\/\.m2\/repository/);
  assert.match(args, /-s\n.*home\/\.m2\/settings.xml/);
});

test('profiles, reactor selection and test defaults reach Maven without shell evaluation', (t) => {
  const { root, project, run } = fixture(t);
  fs.mkdirSync(path.join(project, 'core'));
  fs.writeFileSync(
    path.join(project, 'pom.xml'),
    '<project><modules><module>core</module></modules><profiles><profile><id>dev</id></profile></profiles></project>',
  );
  fs.writeFileSync(path.join(project, 'core/pom.xml'), '<project/>');
  const result = run('verify', { profiles: ['dev'], modules: ['core'], alsoMake: true, offline: true });
  assert.equal(result.status, 0, result.report.error);
  assert.deepEqual(result.report.modules, ['core']);
  assert.deepEqual(result.report.profiles, ['dev']);
  const args = fs.readFileSync(path.join(root, 'args'), 'utf8');
  assert.match(args, /-P\ndev\n/);
  assert.match(args, /-pl\ncore\n-am\n/);
  assert.match(args, /-o\nverify\n/);
  assert.doesNotMatch(args, /skipTests|maven.test.skip/);
  assert.equal(run('test', { skipTests: true }).status, 1);
  assert.equal(run('build', { profiles: ['-Dpassword=bad'] }).status, 1);
  assert.equal(run('build', { pom: '../outside.xml' }).status, 1);
  assert.equal(run('build', { offline: true, updateSnapshots: true }).status, 1);
});

test('logs retain separate task identities and redact settings credentials', (t) => {
  const { root, project, run } = fixture(t);
  fs.writeFileSync(path.join(project, 'pom.xml'), '<project/>');
  fs.writeFileSync(
    path.join(root, 'home/.m2/settings.xml'),
    '<settings><servers><server><username>private-user</username><password>fixture-secret</password></server></servers></settings>',
  );
  const first = run('build', { id: 'a'.repeat(32) });
  assert.equal(first.status, 0, first.report.error);
  fs.appendFileSync(
    first.report.log,
    '\nprivate-user fixture-secret https://another:password@example.invalid token=hidden\n',
  );
  assert.equal(run('build', { id: 'b'.repeat(32) }).status, 0);
  const output = run('log', { id: 'a'.repeat(32) });
  assert.equal(output.status, 0, output.report.error);
  assert.equal(output.report.jobId, 'a'.repeat(32));
  assert.doesNotMatch(output.report.text, /private-user|fixture-secret|another:password|hidden/);
  assert.match(output.report.text, /REDACTED/);
  assert.equal(run('log', { id: '../settings.xml' }).status, 1);
});

test('Maven uses configured subproject and rejects paths outside repository', (t) => {
  const { project, run } = fixture(t);
  fs.mkdirSync(path.join(project, '.opensumi'));
  fs.mkdirSync(path.join(project, 'backend'));
  fs.writeFileSync(path.join(project, 'backend', 'pom.xml'), '<project/>');
  fs.writeFileSync(path.join(project, '.opensumi', 'development.json'), JSON.stringify({ cwd: 'backend' }));
  assert.equal(run('inspect').report.pom, 'backend/pom.xml');
  fs.writeFileSync(path.join(project, '.opensumi', 'development.json'), JSON.stringify({ cwd: '..' }));
  const rejected = run('inspect');
  assert.equal(rejected.status, 1);
  assert.match(rejected.report.error, /超出仓库/);
});

test('missing Maven project is inspectable but cannot start a build', (t) => {
  const { run } = fixture(t);
  assert.equal(run('inspect').report.detected, false);
  const rejected = run('build');
  assert.equal(rejected.status, 1);
  assert.match(rejected.report.error, /pom.xml/);
});
