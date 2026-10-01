'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

async function stopFixture(processWorkspace) {
  const root = '/workspace/workspaces/one';
  const pidFile = root + '/.platform/ide.pid';
  const fields = Array(20).fill('0');
  fields[0] = 'S';
  fields[1] = '1';
  fields[19] = '100';
  const files = new Map([
    [pidFile, '99'],
    ['/proc/99/cmdline', 'node\0/app/server/dist/main.js\0'],
    ['/proc/99/environ', 'WORKSPACE_DIR=' + processWorkspace + '/project\0'],
    ['/proc/99/stat', '99 (node) ' + fields.join(' ')],
  ]);
  const signals = [];
  const fakeFs = {
    readFileSync(file) {
      if (!files.has(file)) throw new Error('missing fixture');
      return files.get(file);
    },
    readdirSync() {
      return ['99'];
    },
    rmSync(file) {
      files.delete(file);
    },
  };
  const fakeProcess = {
    argv: ['node', 'stop-ide.cjs', root],
    kill(pid, signal) {
      signals.push([pid, signal]);
      files.set('/proc/99/stat', '99 (node) Z 1');
    },
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'stop-ide.cjs'), 'utf8'), {
    require(name) {
      return name === 'node:fs' ? fakeFs : require(name);
    },
    process: fakeProcess,
    console,
    setTimeout,
  });
  await new Promise(setImmediate);
  assert.equal(fakeProcess.exitCode, undefined);
  return { signals, pidRetained: files.has(pidFile) };
}

test('recycled PID belonging to another IDE is never signalled', async () => {
  assert.deepEqual(await stopFixture('/workspace/workspaces/two'), { signals: [], pidRetained: true });
});

test('the acknowledged IDE for this workspace is stopped', async () => {
  assert.deepEqual(await stopFixture('/workspace/workspaces/one'), { signals: [[99, 'SIGTERM']], pidRetained: false });
});
