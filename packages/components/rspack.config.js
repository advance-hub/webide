const path = require('path');

const LightningCssMinimizerRspackPlugin = require('@rspack/core').LightningCssMinimizerRspackPlugin;
const CssExtractRspackPlugin = require('@rspack/core').CssExtractRspackPlugin;
const { ProvidePlugin } = require('@rspack/core');
const { ProgressPlugin } = require('@rspack/core');

const tsConfigPath = path.join(__dirname, '../../configs/ts/references/tsconfig.components.json');

/** @type { import('@rspack/core').Configuration } */
module.exports = {
  mode: process.env.NODE_ENV || 'development',
  entry: path.join(__dirname, './src/index.ts'),
  output: {
    filename: 'index.js',
    path: path.join(__dirname, './dist'),
  },
  optimization: {
    minimizer: [new LightningCssMinimizerRspackPlugin()],
  },
  cache: {
    type: 'persistent',
  },
  plugins: [
    new CssExtractRspackPlugin({
      filename: 'index.css',
    }),
    !process.env.CI && new ProgressPlugin(),
    new ProvidePlugin({ process: require.resolve('process/browser.js') }),
  ].filter(Boolean),
  resolve: {
    fallback: {
      path: require.resolve('path-browserify'),
      util: require.resolve('util/'),
    },
    extensions: ['.ts', '.tsx', '.js', '.json', '.less'],
    tsConfig: { configFile: tsConfigPath },
  },
  experiments: { css: false },
  module: {
    rules: [
      {
        test: /\.css$/,
        use: [CssExtractRspackPlugin.loader, 'css-loader'],
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
      {
        test: /\.tsx?$/,
        use: [
          {
            loader: 'ts-loader',
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
        test: /\.less$/,
        use: [
          CssExtractRspackPlugin.loader,
          {
            loader: 'css-loader',
            options: {
              importLoaders: 1,
              sourceMap: false,
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
    ],
  },
  stats: process.env.CI ? 'errors-only' : 'normal',
};
