const path = require('path');

const { ProvidePlugin } = require('@rspack/core');
const { ProgressPlugin } = require('@rspack/core');

const tsConfigPath = path.join(__dirname, '../tsconfig.json');
const distDir = path.join(__dirname, '../app/dist/extension');

/**
 * @type {import('@rspack/core').Configuration}
 */
const nodeTarget = {
  name: 'extension-node',
  entry: path.join(__dirname, '../src/extension/index'),
  target: 'node',
  output: {
    filename: 'index.js',
    path: distDir,
    // The worker also emits async chunks such as 35.index.worker.js.
    clean: { keep: /(?:^|\.)index\.worker\.js(?:\.map)?$/ },
  },
  node: false,
  resolve: {
    byDependency: { commonjs: { conditionNames: ['module-sync', '...'] } },
    modules: ['node_modules', path.join(__dirname, '../node_modules'), path.join(__dirname, '../../../node_modules')],
    mainFields: ['main'],
    extensions: ['.ts', '.tsx', '.js', '.json', '.less'],
    tsConfig: { configFile: tsConfigPath },
  },
  mode: 'development',
  devtool: 'source-map',
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
      { test: /\.css$/, loader: require.resolve('null-loader') },
      { test: /\.less$/, loader: require.resolve('null-loader') },
    ],
  },
  externals: [
    function ({ request }, callback) {
      if (['node-pty', '@parcel/watcher', '@vscode/spdlog'].indexOf(request) !== -1) {
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
};

/**
 * @type {import('@rspack/core').Configuration}
 */
const workerTarget = {
  name: 'extension-worker',
  dependencies: ['extension-node'],
  entry: path.join(__dirname, '../src/extension/index.worker'),
  target: 'webworker',
  output: {
    // disable Rspack default publicPath
    publicPath: '',
    filename: 'index.worker.js',
    path: distDir,
  },
  resolve: {
    byDependency: { commonjs: { conditionNames: ['module-sync', '...'] } },
    modules: ['node_modules', path.join(__dirname, '../node_modules'), path.join(__dirname, '../../../node_modules')],
    extensions: ['.ts', '.tsx', '.js', '.json', '.less'],
    tsConfig: { configFile: tsConfigPath },
    fallback: {
      net: false,
      path: false,
      os: false,
      crypto: false,
    },
  },
  mode: 'development',
  devtool: 'source-map',
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
      { test: /\.css$/, loader: require.resolve('null-loader') },
      { test: /\.less$/, loader: require.resolve('null-loader') },
    ],
  },
  externals: [
    function ({ request }, callback) {
      if (['node-pty', '@parcel/watcher', '@vscode/spdlog', 'nfsw'].indexOf(request) !== -1) {
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
    !process.env.CI && new ProgressPlugin(),
    new ProvidePlugin({
      process: require.resolve('process/browser.js'),
      Buffer: [require.resolve('buffer/'), 'Buffer'],
    }),
  ].filter(Boolean),
};

module.exports = [nodeTarget, workerTarget];

module.exports.parallelism = 1;
