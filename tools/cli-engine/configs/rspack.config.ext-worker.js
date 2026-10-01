const path = require('path');

const { ProvidePlugin } = require('@rspack/core');

const tsConfigPath = path.join(__dirname, './tsconfig.json');
const distDir = path.join(__dirname, '../lib/browser');

module.exports = {
  entry: require.resolve('@opensumi/ide-extension/host/worker'),
  output: {
    // disable Rspack default publicPath
    publicPath: '',
    filename: 'worker-host.js',
    path: distDir,
  },
  target: 'webworker',
  node: false,
  devtool: false,
  mode: 'production',
  resolve: {
    modules: ['node_modules', path.join(__dirname, '../node_modules'), path.join(__dirname, '../../../node_modules')],
    extensions: ['.ts', '.tsx', '.js', '.json', '.less'],
    tsConfig: { configFile: tsConfigPath },
    fallback: {
      util: require.resolve('util/'),
      net: false,
      path: false,
      os: false,
      crypto: false,
    },
  },
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
  resolveLoader: {
    modules: ['node_modules', path.join(__dirname, '../node_modules')],
    extensions: ['.ts', '.tsx', '.js', '.json', '.less'],
    mainFields: ['loader', 'main'],
  },
  plugins: [
    new ProvidePlugin({
      process: require.resolve('process/browser.js'),
      Buffer: [require.resolve('buffer/'), 'Buffer'],
    }),
  ],
};
