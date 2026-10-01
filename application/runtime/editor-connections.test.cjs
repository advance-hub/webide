'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { install, remove } = require('./editor-connections.cjs');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opensumi-editor-connections-'));
  const input = path.join(root, 'connections.json');
  const settings = path.join(root, 'home', '.sumi', 'settings.json');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (value) => fs.writeFileSync(input, JSON.stringify(value));
  const read = () => JSON.parse(fs.readFileSync(settings, 'utf8'));
  return { root, input, settings, write, read };
}

test('defaults auto connect and later edits or added databases survive resync', (t) => {
  const f = fixture(t);
  f.write({ mysql: { endpoint: 'db.internal:3306', database: 'agent', username: 'app', password: 'initial' },
    redis: { endpoint: 'redis.internal:6379', database: '2', password: 'initial' } });
  const first = install(f.root, f.input);
  assert.equal(first.mysql, true);
  assert.equal(first.redis, true);
  assert.equal(f.read()['sqltools.connections'][0].password, 'initial');
  assert.deepEqual(f.read()['sqltools.autoConnectTo'], ['CloudDev MySQL']);
  assert.match(f.read()['redis-state-explorer.redisUrl'], /^redis:\/\/:initial@redis\.internal:6379\/2$/);
  assert.equal(fs.statSync(f.settings).mode & 0o777, 0o600);

  const changed = f.read();
  changed['sqltools.connections'][0].database = 'edited';
  changed['sqltools.connections'].push({ name: 'another db', driver: 'MySQL', server: 'other', port: 3306 });
  changed['redis-state-explorer.redisUrl'] = 'redis://other:6379/4';
  fs.writeFileSync(f.settings, JSON.stringify(changed));
  f.write({ mysql: { endpoint: 'new.internal:3306', database: 'new', username: 'next', password: 'updated' },
    redis: { endpoint: 'new-redis:6379', database: '0', password: 'updated' } });
  install(f.root, f.input);
  assert.equal(f.read()['sqltools.connections'][0].database, 'edited');
  assert.equal(f.read()['sqltools.connections'][1].name, 'another db');
  assert.equal(f.read()['redis-state-explorer.redisUrl'], 'redis://other:6379/4');
  const result = remove(f.root);
  assert.equal(result.additionalDatabases, 1);
  assert.deepEqual(f.read()['sqltools.connections'].map((v) => v.name), ['another db']);
  assert.equal(f.read()['redis-state-explorer.redisUrl'], 'redis://other:6379/4');
});

test('untouched defaults update with resource changes and are removed on sharing', (t) => {
  const f = fixture(t);
  f.write({ mysql: { endpoint: 'first:3306', database: 'one', username: 'app', password: 'old' },
    redis: { endpoint: 'first:6379', password: 'old' } });
  install(f.root, f.input);
  f.write({ mysql: { endpoint: 'second:3307', database: 'two', username: 'app', password: 'new' },
    redis: { endpoint: 'second:6380', password: 'new' } });
  install(f.root, f.input);
  assert.equal(f.read()['sqltools.connections'][0].server, 'second');
  assert.equal(f.read()['sqltools.connections'][0].password, 'new');
  assert.match(f.read()['redis-state-explorer.redisUrl'], /new@second:6380/);
  remove(f.root);
  assert.deepEqual(f.read()['sqltools.connections'], []);
  assert.deepEqual(f.read()['sqltools.autoConnectTo'], []);
  assert.equal(f.read()['redis-state-explorer.redisUrl'], undefined);
});

test('existing user connections are left in place', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.settings), { recursive: true });
  fs.writeFileSync(f.settings, JSON.stringify({ 'sqltools.connections': [{ name: 'CloudDev MySQL', password: 'mine' }] }));
  f.write({ mysql: { endpoint: 'db:3306', password: 'platform' } });
  install(f.root, f.input);
  assert.equal(f.read()['sqltools.connections'][0].password, 'mine');
  assert.equal(f.read()['sqltools.autoConnectTo'], undefined);
});

test('sharing strips an inherited password after the default was renamed', (t) => {
  const f = fixture(t);
  f.write({ mysql: { endpoint: 'db:3306', password: 'platform-secret' } });
  install(f.root, f.input);
  const settings = f.read();
  settings['sqltools.connections'][0].name = 'renamed connection';
  fs.writeFileSync(f.settings, JSON.stringify(settings));
  remove(f.root);
  assert.equal(f.read()['sqltools.connections'][0].name, 'renamed connection');
  assert.equal(f.read()['sqltools.connections'][0].password, '');
});

test('removing a saved resource also removes its inherited editor default', (t) => {
  const f = fixture(t);
  f.write({ mysql: { endpoint: 'db:3306', password: 'private' },
    redis: { endpoint: 'cache:6379', password: 'private' } });
  install(f.root, f.input);
  f.write({});
  const result = install(f.root, f.input);
  assert.equal(result.mysql, false);
  assert.equal(result.redis, false);
  assert.deepEqual(f.read()['sqltools.connections'], []);
  assert.equal(f.read()['redis-state-explorer.redisUrl'], undefined);
});

test('existing auto-connect choices are preserved while MySQL default is added', (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.settings), { recursive: true });
  fs.writeFileSync(f.settings, JSON.stringify({ 'sqltools.autoConnectTo': 'Personal DB' }));
  f.write({ mysql: { endpoint: 'db:3306', password: 'private' } });
  install(f.root, f.input);
  assert.deepEqual(f.read()['sqltools.autoConnectTo'], ['Personal DB', 'CloudDev MySQL']);
  remove(f.root);
  assert.deepEqual(f.read()['sqltools.autoConnectTo'], ['Personal DB']);
});
