const path = require('path');

const SwcJsMinimizerRspackPlugin = require('@rspack/core').SwcJsMinimizerRspackPlugin;
const rspack = require('@rspack/core');

const { AssetManifestPlugin } = require('@opensumi/ide-dev-tool/asset-manifest');

/**
 * @type {import('@rspack/core').Configuration}
 */
module.exports = {
  mode: process.env.NODE_ENV || 'development',
  entry: {
    'editor.worker': '@opensumi/monaco-editor-core/esm/vs/editor/editor.worker.js',
  },
  devtool: process.env.NODE_ENV === 'production' ? false : 'source-map',
  output: {
    globalObject: 'self',
    filename: '[name].bundle.js',
    path: path.resolve(__dirname, 'worker'),
    clean: true,
    publicPath: '',
  },
  optimization:
    process.env.NODE_ENV === 'production'
      ? {
          minimize: true,
          minimizer: [new SwcJsMinimizerRspackPlugin()],
        }
      : {},
  plugins: [
    new AssetManifestPlugin(),
    new rspack.optimize.LimitChunkCountPlugin({
      maxChunks: 1,
    }),
  ],
  stats: process.env.CI ? 'errors-only' : 'normal',
};
