'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ensureDefaultSettings } = require('./ensure-default-settings.cjs');

test('adds new defaults to existing settings without changing an explicit icon choice', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opensumi-settings-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const defaults = path.join(directory, 'defaults.json');
  const settings = path.join(directory, 'home', 'settings.json');
  fs.writeFileSync(
    defaults,
    JSON.stringify({
      'general.icon': 'vscode-icons',
      'git.autofetch': false,
      'typescript.tsserver.useSyntaxServer': 'never',
    }),
  );
  ensureDefaultSettings(settings, defaults);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), {
    'general.icon': 'vscode-icons',
    'git.autofetch': false,
    'typescript.tsserver.useSyntaxServer': 'never',
  });
  fs.writeFileSync(
    settings,
    JSON.stringify({
      'general.icon': 'custom',
      'custom.value': 1,
      'typescript.tsserver.useSyntaxServer': 'auto',
    }),
  );
  ensureDefaultSettings(settings, defaults);
  assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), {
    'general.icon': 'custom',
    'custom.value': 1,
    'typescript.tsserver.useSyntaxServer': 'auto',
    'git.autofetch': false,
  });
});
