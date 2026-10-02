import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import { dependencyConflicts } from './check-workspace-dependencies';

function fixture(t: { after(fn: () => void): void }): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'webide-dependencies-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ workspaces: ['application', 'packages/*'] }));
  fs.writeFileSync(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - application\n  - packages/*\n');
  for (const directory of ['application', 'packages/a', 'tools/extensions/third-party']) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.writeFileSync(
      path.join(root, directory, 'package.json'),
      JSON.stringify({ name: directory, dependencies: { ws: '8.22.0' } }),
    );
  }
  return root;
}

test('依赖检查覆盖根目录与产品工作区，忽略下载扩展及嵌套第三方清单', (t) => {
  const root = fixture(t);
  fs.writeFileSync(
    path.join(root, 'tools/extensions/third-party/package.json'),
    JSON.stringify({ dependencies: { ws: '6.2.4' } }),
  );
  assert.deepEqual(dependencyConflicts(root), []);
  fs.writeFileSync(
    path.join(root, 'package.json'),
    JSON.stringify({ workspaces: ['application', 'packages/*'], devDependencies: { ws: '8.21.3' } }),
  );
  const conflicts = dependencyConflicts(root);
  assert.equal(conflicts.length, 1);
  assert.equal(conflicts[0].name, 'ws');
  assert.deepEqual(conflicts[0].ranges.get('8.21.3'), ['package.json']);
});

test('声明的业务工作区出现版本分歧时拒绝，内部 workspace 协议不参与外部版本比较', (t) => {
  const root = fixture(t);
  fs.writeFileSync(
    path.join(root, 'application/package.json'),
    JSON.stringify({ name: 'application', dependencies: { ws: '8.21.3', '@fixture/a': 'workspace:*' } }),
  );
  const conflicts = dependencyConflicts(root);
  assert.equal(conflicts.length, 1);
  assert.deepEqual(conflicts[0].ranges.get('8.21.3'), ['application/package.json']);
});
