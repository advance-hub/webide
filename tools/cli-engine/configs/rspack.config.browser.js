const path = require('path');

const CopyPlugin = require('@rspack/core').CopyRspackPlugin;
const LightningCssMinimizerRspackPlugin = require('@rspack/core').LightningCssMinimizerRspackPlugin;
const CssExtractRspackPlugin = require('@rspack/core').CssExtractRspackPlugin;
const { ProvidePlugin } = require('@rspack/core');
const SwcJsMinimizerRspackPlugin = require('@rspack/core').SwcJsMinimizerRspackPlugin;

const { AssetManifestPlugin } = require('@opensumi/ide-dev-tool/asset-manifest');

const { lessLoader } = require('./rspack-util');

const tsConfigPath = path.join(__dirname, './tsconfig.json');
const dir = path.join(__dirname, '../src/browser');
const distDir = path.join(__dirname, '../lib/browser');
const nodeEnv = process.env.NODE_ENV || 'development';

/**
 * @type {import('@rspack/core').Configuration}
 */
module.exports = {
  entry: `${dir}/index.ts`,
  output: {
    filename: 'browser.js',
    path: distDir,
  },
  resolve: {
    modules: ['node_modules', path.join(__dirname, '../node_modules'), path.join(__dirname, '../../../node_modules')],
    extensions: ['.ts', '.tsx', '.js', '.json', '.less'],
    tsConfig: { configFile: tsConfigPath },
    fallback: {
      net: false,
      path: false,
      os: false,
      crypto: false,
      fs: false,
    },
  },
  experiments: {
    css: false,
    asyncWebAssembly: true, // 启用 WebAssembly 支持
  },
  bail: true,
  mode: nodeEnv,
  devtool: false,
  module: {
    // https://github.com/webpack/webpack/issues/196#issuecomment-397606728
    exprContextCritical: false,
    rules: [
      {
        test: /\.tsx?$/,
        use: [
          {
            loader: require.resolve('ts-loader'),
            options: {
              compiler: 'typescript-api',
              happyPackMode: true,
              transpileOnly: true,
              onlyCompileBundledFiles: true,
              configFile: tsConfigPath,
              compilerOptions: {
                target: 'es2015',
              },
            },
          },
        ],
      },
      {
        test: /\.png$/,
        type: 'asset/resource',
      },
      {
        test: /\.css$/,
        use: [CssExtractRspackPlugin.loader, require.resolve('css-loader')],
      },
      {
        test: /\.module.less$/,
        use: [
          {
            loader: require.resolve('style-loader'),
          },
          {
            loader: require.resolve('css-loader'),
            options: {
              sourceMap: true,
              esModule: false,
              modules: { exportLocalsConvention: 'as-is' },
            },
          },
          lessLoader(),
        ],
      },
      {
        test: /^((?!\.module).)*less$/,
        use: [
          {
            loader: require.resolve('style-loader'),
          },
          {
            loader: require.resolve('css-loader'),
          },
          lessLoader(),
        ],
      },
      {
        test: /\.svg$/,
        type: 'asset/resource',
        generator: {
          filename: 'images/[name][ext][query]',
        },
      },
      {
        test: /\.(woff(2)?|ttf|eot)(\?v=\d+\.\d+\.\d+)?$/,
        type: 'asset/resource',
        generator: {
          filename: 'fonts/[name][ext][query]',
        },
      },
    ],
  },
  resolveLoader: {
    modules: ['node_modules', path.join(__dirname, '../node_modules')],
    extensions: ['.ts', '.tsx', '.js', '.json', '.less'],
    mainFields: ['loader', 'main'],
  },
  optimization: {
    nodeEnv,
    minimizer: [new SwcJsMinimizerRspackPlugin(), new LightningCssMinimizerRspackPlugin()],
  },
  plugins: [
    new AssetManifestPlugin({ filename: 'assets.json', entrypoints: true }),
    new CssExtractRspackPlugin({
      filename: 'main.css',
    }),
    new CopyPlugin({
      patterns: [
        { from: path.join(dir, 'vendor'), to: distDir },
        { from: path.join(dir, 'index.html'), to: distDir },
      ],
    }),
    new ProvidePlugin({
      process: require.resolve('process/browser.js'),
      Buffer: [require.resolve('buffer/'), 'Buffer'],
    }),
  ],
};
