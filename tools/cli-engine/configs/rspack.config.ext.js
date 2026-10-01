const path = require('path');

const tsConfigPath = path.join(__dirname, './tsconfig.json');
const distDir = path.join(__dirname, '../lib/hosted');

const nodeEnv = process.env.NODE_ENV || 'development';

module.exports = {
  entry: require.resolve('@opensumi/ide-extension/host/process'),
  target: 'node',
  output: {
    filename: 'ext.process.js',
    path: distDir,
  },
  devtool: false,
  node: false,
  resolve: {
    byDependency: { commonjs: { conditionNames: ['module-sync', '...'] } },
    modules: ['node_modules', path.join(__dirname, '../node_modules'), path.join(__dirname, '../../../node_modules')],
    extensions: ['.ts', '.tsx', '.js', '.json', '.less'],
    tsConfig: { configFile: tsConfigPath },
  },
  mode: nodeEnv,
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
      if (['node-pty', 'nsfw', '@vscode/spdlog', 'getmac'].indexOf(request) !== -1) {
        return callback(null, `commonjs ${request}`);
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
