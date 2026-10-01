const path = require('path');

const CopyPlugin = require('@rspack/core').CopyRspackPlugin;

const {
  createRspackConfig,
  createNodeRspackConfig,
  createWebviewRspackConfig,
} = require('@opensumi/ide-dev-tool/rspack');

const web = createRspackConfig(__dirname, path.join(__dirname, 'entry/web/prod/app.tsx'), {
  output: {
    // Content-addressed filename: the static server caches aggressively, so a
    // fixed name pins every browser to the first bundle it ever fetched.
    filename: 'bundle.[contenthash:8].js',
    // The webview compiler writes into dist/webview while this compiler owns dist.
    // Keep the nested output when the parent compiler rebuilds in watch mode.
    clean: {
      keep: /^webview(?:\/|$)/,
    },
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        {
          from: require.resolve('@opensumi/ide-extension/worker-host.js'),
          to: path.join(__dirname, './dist/worker-host.js'),
        },
      ],
    }),
  ],
});

const node = createNodeRspackConfig(
  path.join(__dirname, 'entry/web/prod/server.ts'),
  path.join(__dirname, 'dist-node/server'),
);

const webview = createWebviewRspackConfig(
  require.resolve('@opensumi/ide-webview/host/preload'),
  __dirname,
  '/dist/webview',
);

if (process.env.ONLY_NODE) {
  module.exports = [node];
} else {
  web.name = 'preview-browser';
  node.name = 'preview-server';
  node.dependencies = ['preview-browser'];
  webview.name = 'preview-webview';
  webview.dependencies = ['preview-server'];
  module.exports = [web, node, webview];
}

module.exports.parallelism = 1;
