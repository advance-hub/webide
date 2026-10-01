const fs = require('node:fs');
const path = require('node:path');

const { createWebviewRspackConfig } = require('@opensumi/ide-dev-tool/rspack');

const manifestPath = require.resolve('@opensumi/ide-webview/package.json');
const manifest = require(manifestPath);
const sourceEntry = path.resolve(path.dirname(manifestPath), manifest.exports['./host/preload']['opensumi-source']);
const entry = fs.existsSync(sourceEntry) ? sourceEntry : require.resolve('@opensumi/ide-webview/host/preload');
module.exports = createWebviewRspackConfig(entry, __dirname);
