const path = require('path');

const CopyPlugin = require('@rspack/core').CopyRspackPlugin;
const HtmlRspackPlugin = require('@rspack/core').HtmlRspackPlugin;
const CssExtractRspackPlugin = require('@rspack/core').CssExtractRspackPlugin;
const { ProvidePlugin } = require('@rspack/core');
const rspack = require('@rspack/core');

const tsConfigPath = path.join(__dirname, '../tsconfig.json');
const srcDir = path.join(__dirname, '../src/browser');
const distDir = path.join(__dirname, '../app/dist/browser');

/** @type { import('@rspack/core').Configuration } */
module.exports = {
  entry: path.join(srcDir, './index.ts'),
  output: {
    filename: 'bundle.js',
    path: distDir,
    clean: true,
  },
  cache: {
    type: 'persistent',
  },
  resolve: {
    modules: ['node_modules', path.join(__dirname, '../node_modules'), path.join(__dirname, '../../../node_modules')],
    extensions: ['.ts', '.tsx', '.js', '.json', '.less'],
    tsConfig: { configFile: tsConfigPath },
    fallback: {
      path: require.resolve('path-browserify'),
      net: false,

      os: false,
      crypto: false,
      child_process: false,
      url: false,
      fs: false,
    },
  },
  mode: 'development',
  devtool: 'source-map',
  experiments: { css: false },
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
        test: /\.png$/,
        type: 'asset/resource',
      },
      {
        test: /\.css$/,
        use: [CssExtractRspackPlugin.loader, 'css-loader'],
      },
      {
        test: /\.module.less$/,
        use: [
          {
            loader: 'style-loader',
          },
          {
            loader: 'css-loader',
            options: {
              sourceMap: true,
              esModule: false,
              modules: {
                exportLocalsConvention: 'as-is',
                localIdentName: '[local]___[hash:base64:5]',
              },
            },
          },
          {
            loader: 'less-loader',
            options: {
              lessOptions: {
                javascriptEnabled: true,
              },
            },
          },
        ],
      },
      {
        test: /^((?!\.module).)*less$/,
        use: [
          {
            loader: 'style-loader',
          },
          {
            loader: 'css-loader',
          },
          {
            loader: 'less-loader',
            options: {
              lessOptions: {
                javascriptEnabled: true,
              },
            },
          },
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
          filename: 'fonts/[name]-[hash:8][ext][query]',
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
    new HtmlRspackPlugin({
      template: path.join(srcDir, '/index.html'),
    }),
    new CssExtractRspackPlugin({
      filename: '[name].[chunkhash:8].css',
      chunkFilename: '[id].css',
    }),
    new CopyPlugin({
      patterns: [
        {
          from: require.resolve('@opensumi/ide-core-electron-main/browser-preload.js'),
          to: path.join(distDir, 'preload.js'),
        },
      ],
    }),
    !process.env.CI && new rspack.ProgressPlugin(),
    new ProvidePlugin({
      Buffer: [require.resolve('buffer/'), 'Buffer'],
      process: require.resolve('process/browser.js'),
    }),
  ].filter(Boolean),
};
