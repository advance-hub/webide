const path = require('path');

const CopyPlugin = require('@rspack/core').CopyRspackPlugin;

const tsConfigPath = path.join(__dirname, '../tsconfig.json');
const distDir = path.join(__dirname, '../app/dist/webview');

module.exports = {
  entry: require.resolve('@opensumi/ide-webview/electron/host-preload.js'),
  target: 'node',
  output: {
    filename: 'host-preload.js',
    path: distDir,
    clean: true,
  },
  node: false,
  resolve: {
    byDependency: { commonjs: { conditionNames: ['module-sync', '...'] } },
    modules: ['node_modules', path.join(__dirname, '../node_modules'), path.join(__dirname, '../../../node_modules')],
    extensions: ['.ts', '.tsx', '.js', '.json', '.less'],
    tsConfig: { configFile: tsConfigPath },
  },
  mode: 'development',
  devtool: 'eval',
  module: {
    // https://github.com/webpack/webpack/issues/196#issuecomment-397606728
    exprContextCritical: false,
    rules: [
      {
        test: /\.tsx?$/,
        loader: 'ts-loader',
        options: {
          compiler: 'typescript-api',
          happyPackMode: true,
          transpileOnly: true,
          onlyCompileBundledFiles: true,
          configFile: tsConfigPath,
        },
      },
    ],
  },
  externals: [
    function ({ request }, callback) {
      if (['node-pty', '@parcel/watcher', '@vscode/spdlog', 'nsfw', 'electron'].indexOf(request) !== -1) {
        return callback(null, 'commonjs ' + request);
      }
      callback();
    },
  ],
  resolveLoader: {
    modules: ['node_modules', path.join(__dirname, '../node_modules')],
    extensions: ['.ts', '.tsx', '.js', '.json', '.less'],
    mainFields: ['loader', 'main'],
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        {
          from: require.resolve('@opensumi/ide-webview/electron/plain-preload.js'),
          to: path.join(distDir, 'plain-preload.js'),
        },
      ],
    }),
  ],
};
