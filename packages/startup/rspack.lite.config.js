const path = require('path');

const CopyPlugin = require('@rspack/core').CopyRspackPlugin;
const rspack = require('@rspack/core');
const BundleAnalyzerPlugin = require('webpack-bundle-analyzer').BundleAnalyzerPlugin;
const baseDir = path.join(__dirname, 'entry/web-lite');

const { createRspackConfig } = require('@opensumi/ide-dev-tool/rspack');
module.exports = createRspackConfig(
  baseDir,
  path.join(baseDir, 'app.tsx'),
  {
    resolve: {
      alias: {
        fs: 'browserfs/dist/shims/fs.js',
        buffer: 'browserfs/dist/shims/buffer.js',
        path: 'browserfs/dist/shims/path.js',
        processGlobal: 'browserfs/dist/shims/process.js',
        bufferGlobal: 'browserfs/dist/shims/bufferGlobal.js',
        bfsGlobal: require.resolve('browserfs'),
      },
    },
    node: false,
    plugins: [
      new rspack.DefinePlugin({
        global: 'window', // This will replace global with window
      }),
      new CopyPlugin({
        patterns: [
          {
            from: path.join(__dirname, '../extension/lib/worker-host.js'),
            to: path.join(baseDir, './dist/worker-host.js'),
          },
        ],
      }),
      !process.env.CI && new rspack.ProgressPlugin(),
    ]
      .concat(process.env.analysis ? new BundleAnalyzerPlugin() : null)
      .filter(Boolean),
  },
  { BrowserFS: 'bfsGlobal', process: 'processGlobal', Buffer: 'bufferGlobal' },
);
