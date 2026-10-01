const path = require('path');

const rspack = require('@rspack/core');

const tsConfigPath = path.join(__dirname, './tsconfig.json');
const srcDir = path.join(__dirname, './src');
const distDir = path.join(__dirname, './dist');

/**
 * @type {import('@rspack/core').Configuration}
 */
module.exports = {
  entry: path.join(srcDir, './index.ts'),
  target: 'node',
  output: {
    filename: 'cli.js',
    path: distDir,
  },
  devtool: false,
  mode: 'production',
  node: false,
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.json', '.less'],
    mainFields: ['loader', 'main'],
    tsConfig: { configFile: tsConfigPath },
  },
  module: {
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
    extensions: ['.ts', '.tsx', '.js', '.json', '.less'],
    mainFields: ['loader', 'main'],
  },
  plugins: [!process.env.CI && new rspack.ProgressPlugin()].filter(Boolean),
};
