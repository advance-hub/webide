const path = require('path');

const tsConfigPath = path.join(__dirname, '../tsconfig.json');
const srcDir = path.join(__dirname, '../src/main');
const distDir = path.join(__dirname, '../app/dist/main');

/** @type { import('@rspack/core').Configuration } */
module.exports = {
  entry: path.join(srcDir, './index.ts'),
  target: 'electron-main',
  output: {
    filename: 'index.js',
    path: distDir,
    clean: true,
  },
  node: false,
  resolve: {
    byDependency: { commonjs: { conditionNames: ['module-sync', '...'] } },
    modules: ['node_modules', path.join(__dirname, '../node_modules'), path.join(__dirname, '../../../node_modules')],
    mainFields: ['main'],
    extensions: ['.ts', '.tsx', '.mjs', '.js', '.json', '.less'],
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
      {
        test: /\.mjs$/,
        include: /node_modules/,
        type: 'javascript/auto',
      },
    ],
  },
  resolveLoader: {
    modules: ['node_modules', path.join(__dirname, '../node_modules')],
    extensions: ['.ts', '.tsx', '.js', '.json', '.less'],
    mainFields: ['loader', 'main'],
  },
  externals: [
    ({ request }, callback) => {
      if (['node-pty', '@parcel/watcher', '@vscode/spdlog', 'nsfw', 'electron'].includes(request)) {
        return callback(null, 'commonjs ' + request);
      }
      callback();
    },
  ],
};
