import path from 'node:path';

import { type Configuration, rspack } from '@rspack/core';

const production = process.env.NODE_ENV === 'production';
const config: Configuration = {
  context: import.meta.dirname,
  mode: production ? 'production' : 'development',
  entry: './src/main.tsx',
  output: {
    path: path.join(import.meta.dirname, 'dist'),
    filename: '[name].[contenthash:8].js',
    chunkFilename: '[name].[contenthash:8].js',
    clean: true,
  },
  resolve: { extensions: ['.tsx', '.ts', '.js'] },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        exclude: /node_modules/,
        use: {
          loader: 'builtin:swc-loader',
          options: {
            jsc: {
              parser: { syntax: 'typescript', tsx: true },
              transform: { react: { runtime: 'automatic' } },
              target: 'es2022',
            },
          },
        },
      },
      { test: /\.css$/, use: [production ? rspack.CssExtractRspackPlugin.loader : 'style-loader', 'css-loader'] },
      { test: /\.(svg|png|woff2?)$/, type: 'asset/resource' },
    ],
  },
  plugins: [
    new rspack.HtmlRspackPlugin({
      templateContent:
        '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="icon" href="data:,"><title>OpenSumi 云开发</title></head><body><div id="root"></div></body></html>',
    }),
    ...(production ? [new rspack.CssExtractRspackPlugin({ filename: '[name].[contenthash:8].css' })] : []),
  ],
  devServer: {
    host: '127.0.0.1',
    port: 8792,
    proxy: [{ context: ['/api'], target: 'http://127.0.0.1:8790', changeOrigin: false }],
  },
  performance: { hints: false },
};
export default config;
