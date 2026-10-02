'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

// 从已部署服务的位置解析模块，使用它实际的生产依赖。
// 导入模块时不启动监听器，也不创建工作区子进程。
const serverRequire = createRequire(path.resolve(__dirname, '../server/dist/main.js'));
const { resolveProductRuntimeMode } = serverRequire('@opensumi/ide-startup/runtime-mode');
assert.equal(resolveProductRuntimeMode({}), 'node');
const runtimeMode = resolveProductRuntimeMode(process.env);
serverRequire('@opensumi/ide-startup');
serverRequire('@opensumi/ide-startup/node/modules');
serverRequire('./start-server.js');
const root = path.resolve(__dirname, '..');
const requiredResources = [
  'client/dist/index.html',
  'packages/extension/lib/worker-host.js',
  'packages/extension/lib/hosted/ext.process.js',
  'packages/file-service/lib/node/hosted/watcher.process.js',
  'packages/monaco/worker/manifest.json',
  'packages/monaco/worker/editor.worker.bundle.js',
  'packages/webview/lib/browser/iframe/prebuilt.js',
];
for (const resource of requiredResources) {
  assert.ok(fs.statSync(path.join(root, resource)).size > 0, `Missing runtime resource: ${resource}`);
}
const html = fs.readFileSync(path.join(root, 'client/dist/index.html'), 'utf8');
for (const [, asset] of html.matchAll(/(?:src|href)="([^"]+\.(?:js|css))"/g)) {
  if (!/^(?:https?:)?\/\//.test(asset)) {
    const filename = path.join(root, 'client/dist', asset);
    assert.ok(fs.statSync(filename).size > 0, `Missing client asset: ${asset}`);
    if (asset.endsWith('.css')) {
      const css = fs.readFileSync(filename, 'utf8');
      for (const [, reference] of css.matchAll(/url\(\s*['"]?([^'"\s)]+)/g)) {
        if (/^(?:data:|https?:|\/\/|#)/.test(reference)) continue;
        const resource = decodeURIComponent(reference.split(/[?#]/)[0]);
        const resourcePath = resource.startsWith('/')
          ? path.join(root, 'client/dist', resource)
          : path.resolve(path.dirname(filename), resource);
        assert.ok(fs.statSync(resourcePath).size > 0, `Missing CSS font or image: ${reference}`);
      }
    }
  }
}
console.log(`Production server imports, client assets and ${runtimeMode} runtime resources passed`);
