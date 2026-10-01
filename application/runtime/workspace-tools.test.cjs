'use strict';
const { test } = require('node:test'),
  assert = require('node:assert/strict');
const fs = require('node:fs'),
  os = require('node:os'),
  path = require('node:path'),
  { spawnSync } = require('node:child_process');
function root(t) {
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'clouddev-tools-'));
  t.after(() => fs.rmSync(r, { recursive: true, force: true }));
  return r;
}
function cli(script, ...args) {
  return spawnSync(process.execPath, [path.join(__dirname, script), ...args], { encoding: 'utf8' });
}
const encode = (v) => Buffer.from(JSON.stringify(v)).toString('base64');
test('restore rollback preserves old files and cache; commit keeps new files and cache', (t) => {
  const r = root(t),
    stage = path.join(r, '.clouddev-restore-stage');
  fs.mkdirSync(path.join(r, 'home/.m2/repository'), { recursive: true });
  fs.writeFileSync(path.join(r, 'home/.m2/repository/cache'), 'cached');
  fs.mkdirSync(stage);
  fs.mkdirSync(path.join(stage, 'home'));
  fs.writeFileSync(path.join(stage, 'new'), 'new');
  fs.writeFileSync(path.join(r, 'old'), 'old');
  assert.equal(cli('restore-machine.cjs', r, 'apply', stage).status, 0);
  assert(!fs.existsSync(path.join(r, 'old')));
  assert.equal(cli('restore-machine.cjs', r, 'rollback').status, 0);
  assert.equal(fs.readFileSync(path.join(r, 'old'), 'utf8'), 'old');
  assert(!fs.existsSync(path.join(r, 'new')));
  fs.mkdirSync(path.join(stage, 'home'), { recursive: true });
  fs.writeFileSync(path.join(stage, 'new'), 'new');
  assert.equal(cli('restore-machine.cjs', r, 'apply', stage).status, 0);
  assert.equal(cli('restore-machine.cjs', r, 'commit').status, 0);
  assert.equal(fs.readFileSync(path.join(r, 'home/.m2/repository/cache'), 'utf8'), 'cached');
  assert(fs.existsSync(path.join(r, 'new')));
  assert(!fs.existsSync(path.join(r, '.clouddev-restore-previous')));
});
test('interrupted old-file moves roll back without removing entries not yet moved', (t) => {
  const r = root(t),
    old = path.join(r, '.clouddev-restore-previous');
  fs.mkdirSync(path.join(old, 'contents'), { recursive: true });
  fs.writeFileSync(
    path.join(old, '.journal.json'),
    JSON.stringify({ previous: ['a', 'b'], next: ['a', 'c'], phase: 'old' }),
  );
  fs.writeFileSync(path.join(old, 'contents/a'), 'a');
  fs.writeFileSync(path.join(r, 'b'), 'b');
  assert.equal(cli('restore-machine.cjs', r, 'rollback').status, 0);
  assert.equal(fs.readFileSync(path.join(r, 'a'), 'utf8'), 'a');
  assert.equal(fs.readFileSync(path.join(r, 'b'), 'utf8'), 'b');
});
test('Git conflict is preserved, then abort restores local commit', (t) => {
  const r = root(t),
    remote = path.join(r, 'remote.git'),
    p = path.join(r, 'project');
  const git = (...args) => {
    const out = spawnSync('git', args, { encoding: 'utf8' });
    assert.equal(out.status, 0, out.stderr);
    return out.stdout.trim();
  };
  git('init', '--bare', remote);
  git('clone', remote, p);
  git('-C', p, 'config', 'user.name', 'Fixture');
  git('-C', p, 'config', 'user.email', 'fixture@example.test');
  fs.writeFileSync(path.join(p, 'file'), 'base');
  git('-C', p, 'add', '.');
  git('-C', p, 'commit', '-m', 'base');
  git('-C', p, 'branch', '-M', 'main');
  git('-C', p, 'push', 'origin', 'main');
  git('-C', p, 'checkout', '-b', 'remote-change');
  fs.writeFileSync(path.join(p, 'file'), 'remote');
  git('-C', p, 'commit', '-am', 'remote');
  git('-C', p, 'push', 'origin', 'remote-change');
  git('-C', p, 'checkout', 'main');
  fs.writeFileSync(path.join(p, 'file'), 'local');
  git('-C', p, 'commit', '-am', 'local');
  const sha = git('-C', p, 'rev-parse', 'HEAD');
  const out = cli('git.cjs', r, encode({ action: 'merge', branch: 'remote-change' }));
  assert.equal(out.status, 0, out.stdout);
  const s = JSON.parse(out.stdout);
  assert.equal(s.success, false);
  assert.deepEqual(s.conflicts, ['file']);
  assert.equal(s.operation, 'merge');
  assert.equal(cli('git.cjs', r, encode({ action: 'abort' })).status, 0);
  assert.equal(git('-C', p, 'rev-parse', 'HEAD'), sha);
  assert.equal(fs.readFileSync(path.join(p, 'file'), 'utf8'), 'local');
  fs.writeFileSync(path.join(p, 'file'), 'dirty');
  assert.equal(cli('git.cjs', r, encode({ action: 'pull' })).status, 1);
  assert.equal(fs.readFileSync(path.join(p, 'file'), 'utf8'), 'dirty');
});
test('credential helper returns nothing for a different repository', (t) => {
  const r = root(t),
    f = path.join(r, 'lease.json');
  fs.writeFileSync(f, JSON.stringify({ url: 'http://bridge.test/git/one.git', lease: 'lease', token: 'capability' }));
  const get = (p) =>
    spawnSync(process.execPath, [path.join(__dirname, 'git-credential.cjs'), f, 'get'], {
      encoding: 'utf8',
      input: `protocol=http\nhost=bridge.test\npath=${p}\n\n`,
    }).stdout;
  assert.equal(get('git/two.git'), '');
  assert.match(get('git/one.git'), /password=capability/);
});
test('settings validation and revision conflicts preserve the last saved XML', (t) => {
  const r = root(t),
    f = path.join(r, 'home/.m2/settings.xml');
  const call = (v) => {
    const result = cli('maven-config.cjs', r, encode(v));
    return { ...result, value: JSON.parse(result.stdout) };
  };
  const first = call({ action: 'read' });
  assert.equal(first.status, 0);
  const xml = '<settings><mirrors/></settings>';
  assert.equal(call({ action: 'save-settings', xml, revision: first.value.revision }).status, 0);
  assert.equal(call({ action: 'save-settings', xml: '<settings/>', revision: first.value.revision }).status, 1);
  assert.equal(fs.readFileSync(f, 'utf8'), xml);
  const current = call({ action: 'read' });
  assert.equal(
    call({ action: 'save-settings', xml: '<!DOCTYPE x><settings/>', revision: current.value.revision }).status,
    1,
  );
  const preset = { name: 'CI', action: 'verify', options: { offline: true } };
  assert.deepEqual(call({ action: 'save-presets', presets: [preset] }).value.presets, [preset]);
});
test('personal preferences follow defaults while explicit project edits survive', (t) => {
  const r = root(t),
    shared = path.join(r, 'shared'),
    ws = path.join(r, 'workspace'),
    personal = require('./personal-settings.cjs');
  personal.write(path.join(shared, '.clouddev/editor-defaults.json'), {
    'editor.fontSize': 14,
    'workbench.colorTheme': 'Default Dark+',
  });
  personal.write(path.join(ws, 'home/.config/opencode/auth.json'), { fixture: { type: 'api', key: 'synthetic' } });
  personal.inherit(ws, shared);
  const settings = path.join(ws, 'home/.sumi/settings.json');
  assert.equal(personal.read(settings)['editor.fontSize'], 14);
  assert.equal(
    fs.realpathSync(path.join(ws, 'home/.config/opencode')),
    fs.realpathSync(path.join(shared, '.config/opencode')),
  );
  personal.write(settings, { ...personal.read(settings), 'editor.fontSize': 18 });
  personal.write(path.join(shared, '.clouddev/editor-defaults.json'), {
    'editor.fontSize': 16,
    'workbench.colorTheme': 'Default Light+',
  });
  personal.inherit(ws, shared);
  assert.equal(personal.read(settings)['editor.fontSize'], 18);
  assert.equal(personal.read(settings)['workbench.colorTheme'], 'Default Light+');
  assert.equal(personal.read(path.join(shared, '.config/opencode/auth.json')).fixture.key, 'synthetic');
});
