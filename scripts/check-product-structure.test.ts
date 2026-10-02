import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';

import { commentIsChinese, inspectProduct, readProduct } from './check-product-structure.ts';

test('实际产品无跨层导入、循环依赖或英文说明性注释', () => {
  assert.deepEqual(inspectProduct(readProduct(path.resolve(import.meta.dirname, '..'))), []);
});

test('共享契约拒绝浏览器、服务端和外部运行依赖', () => {
  const problems = inspectProduct([
    { file: 'application/shared/model.ts', source: "import '../src/api'; import 'react';" },
    { file: 'application/src/api.ts', source: '' },
  ]);
  assert.equal(problems.filter((problem) => problem.kind === 'dependency').length, 2);
});

test('领域与运行驱动拒绝回依赖 HTTP 层和组装根', () => {
  const problems = inspectProduct([
    { file: 'application/server/domain/model.ts', source: "import '../http/router';" },
    { file: 'application/server/runtime/local.ts', source: "import '../workbench';" },
    { file: 'application/server/http/router.ts', source: '' },
    { file: 'application/server/workbench.ts', source: '' },
  ]);
  assert.equal(problems.filter((problem) => problem.kind === 'dependency').length, 2);
});

test('检测动态导入、CommonJS 引用、缺失文件和循环', () => {
  const problems = inspectProduct([
    { file: 'application/runtime/a.cjs', source: "require('./b.cjs'); require('./missing.cjs');" },
    { file: 'application/runtime/b.cjs', source: "import('./a.cjs');" },
  ]);
  assert.equal(problems.filter((problem) => problem.kind === 'cycle').length, 1);
  assert.equal(problems.filter((problem) => problem.kind === 'unresolved').length, 1);
});

test('注释检查保留版权和机器指令，不将字符串、正则与模板当成注释', () => {
  assert.equal(commentIsChinese('// 保持进程归属校验。'), true);
  assert.equal(commentIsChinese('// Copyright OpenSumi Authors'), true);
  assert.equal(commentIsChinese('// eslint-disable-next-line no-console'), true);
  assert.equal(commentIsChinese('/** Recover the process. */'), false);
  const problems = inspectProduct([
    {
      file: 'application/src/example.tsx',
      source:
        'const url = "https://example.test"; const pattern = /https?:\\/\\//; const text = `// fixture`; // 真实注释\nconst view = <div>{/* English explanation */}</div>;',
    },
  ]);
  assert.equal(problems.filter((problem) => problem.kind === 'comment').length, 1);
});
