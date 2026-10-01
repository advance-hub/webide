/* eslint-disable no-console */
const path = require('path');

const HtmlRspackPlugin = require('@rspack/core').HtmlRspackPlugin;
const CssExtractRspackPlugin = require('@rspack/core').CssExtractRspackPlugin;
const { ProvidePlugin } = require('@rspack/core');
const rspack = require('@rspack/core');
const fse = require('fs-extra');
const { BundleAnalyzerPlugin } = require('webpack-bundle-analyzer');
const { merge } = require('webpack-merge');

const { getBuildContext, getBuildCache } = require('./build-context');

const withSlash = process.platform === 'win32' ? '/' : '';

/**
 *
 * @param {string} dir
 * @param {string} entry
 * @param {import('@rspack/core').Configuration} [extraConfig]
 * @param {Record<string, string | string[]>} browserGlobals
 * @returns {import('@rspack/core').Configuration}
 */
exports.createRspackConfig = function (
  dir,
  entry,
  extraConfig,
  browserGlobals = {
    process: require.resolve('process/browser.js'),
    Buffer: [require.resolve('buffer/'), 'Buffer'],
  },
) {
  const context = getBuildContext(dir);
  const { projectRoot, tsConfigPath, modulePaths } = context;
  const reactPath = path.dirname(context.resolve('react/package.json'));
  const reactDOMPath = path.dirname(context.resolve('react-dom/package.json'));
  const HOST = process.env.HOST || '0.0.0.0';
  const IDE_FRONT_PORT = process.env.IDE_FRONT_PORT || 8080;
  const IDE_SERVER_PORT = process.env.IDE_SERVER_PORT || process.env.PORT || 8000;
  const defaultWorkspace = path.join(projectRoot, 'tools/workspace');
  fse.mkdirpSync(defaultWorkspace);
  const styleLoader =
    process.env.NODE_ENV === 'production' ? CssExtractRspackPlugin.loader : require.resolve('style-loader');
  let notebookModulePath;
  try {
    notebookModulePath = path.dirname(context.resolve('@opensumi/ide-notebook/package.json'));
  } catch (error) {
    if (error.code !== 'MODULE_NOT_FOUND') {
      throw error;
    }
  }
  console.log('front port', IDE_FRONT_PORT);

  const outputPath = dir + '/dist';
  const rspackConfig = merge(
    {
      context: path.resolve(dir),
      entry,
      profile: process.env.RSPACK_PROFILE === '1',
      output: {
        filename: 'bundle.js',
        path: outputPath,
        clean: true,
      },
      cache: getBuildCache(context, 'browser', entry),
      experiments: {
        css: false,
        asyncWebAssembly: true, // 启用 WebAssembly 支持
      },
      resolve: {
        extensions: ['.ts', '.tsx', '.js', '.json', '.less'],
        extensionAlias: {
          '.js': ['.ts', '.tsx', '.js'],
        },
        tsConfig: { configFile: tsConfigPath },
        alias: {
          react: reactPath,
          'react-dom': reactDOMPath,
        },
        fallback: {
          assert: require.resolve('assert/'),
          net: false,
          path: false,
          os: false,
          crypto: false,
          child_process: false,
          url: false,
          fs: false,
          stream: false,
        },
      },
      bail: true,
      mode: process.env.NODE_ENV || 'development',
      devtool: 'source-map',
      module: {
        // https://github.com/webpack/webpack/issues/196#issuecomment-397606728
        exprContextCritical: false,
        rules: [
          ...(notebookModulePath
            ? [
                {
                  test: /\.tsx?$/,
                  include: notebookModulePath,
                  use: [
                    {
                      loader: context.resolve('ts-loader'),
                      options: {
                        compiler: 'typescript-api',
                        happyPackMode: true,
                        transpileOnly: true,
                        onlyCompileBundledFiles: true,
                        configFile: tsConfigPath,
                        compilerOptions: {
                          module: 'esnext',
                          moduleResolution: 'bundler',
                          target: 'es2015',
                        },
                      },
                    },
                  ],
                },
              ]
            : []),
          {
            test: /\.tsx?$/,
            exclude: notebookModulePath ? [notebookModulePath] : [],
            use: [
              {
                loader: context.resolve('ts-loader'),
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
            use: [styleLoader, context.resolve('css-loader')],
          },
          {
            test: /\.module.less$/,
            use: [
              styleLoader,
              {
                loader: context.resolve('css-loader'),
                options: {
                  importLoaders: 1,
                  sourceMap: true,
                  // Framework sources are compiled to CommonJS. Keep CSS
                  // module exports compatible with TypeScript's default-import
                  // interop, matching the production Rspack configuration.
                  esModule: false,
                  modules: {
                    localIdentName: '[local]___[hash:base64:5]',
                    exportLocalsConvention: 'as-is',
                  },
                },
              },
              {
                loader: context.resolve('less-loader'),
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
              styleLoader,
              {
                loader: context.resolve('css-loader'),
                options: {
                  importLoaders: 1,
                },
              },
              {
                loader: context.resolve('less-loader'),
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
              filename: 'fonts/[name][hash:8][ext][query]',
            },
          },
        ],
      },
      resolveLoader: {
        modules: modulePaths,
        extensions: ['.ts', '.tsx', '.js', '.json', '.less'],
        mainFields: ['loader', 'main'],
      },
      optimization: {
        nodeEnv: process.env.NODE_ENV,
        minimize: false,
      },
      plugins: [
        new HtmlRspackPlugin({
          template: __dirname + '/index.html',
        }),
        new CssExtractRspackPlugin({
          filename: '[name].[chunkhash:8].css',
          chunkFilename: '[id].css',
        }),
        new rspack.DefinePlugin({
          'process.env.IS_DEV': JSON.stringify(process.env.NODE_ENV === 'development' ? 1 : 0),
          'process.env.ENABLE_AI': JSON.stringify(process.env.ENABLE_AI === '1' ? '1' : '0'),
          'process.env.ENABLE_NOTEBOOK': JSON.stringify(process.env.ENABLE_NOTEBOOK === '1' ? '1' : '0'),
          'process.env.ENABLE_COLLABORATION': JSON.stringify(process.env.ENABLE_COLLABORATION === '1' ? '1' : '0'),
          'process.env.COLLABORATION_PORT': JSON.stringify(process.env.COLLABORATION_PORT || '12345'),
          'process.env.NOTEBOOK_SERVER_HOST': JSON.stringify(process.env.NOTEBOOK_SERVER_HOST || 'localhost:8888'),
          'process.env.WORKSPACE_DIR': JSON.stringify(process.env.MY_WORKSPACE || defaultWorkspace),
          'process.env.SUPPORT_LOAD_WORKSPACE_BY_HASH': JSON.stringify(process.env.SUPPORT_LOAD_WORKSPACE_BY_HASH),
          'process.env.OPENSUMI_E2E_COMMANDS': JSON.stringify(process.env.OPENSUMI_E2E_COMMANDS),
          'process.env.EXTENSION_DIR': JSON.stringify(path.join(projectRoot, 'tools/extensions')),
          'process.env.KTLOG_SHOW_DEBUG': JSON.stringify('1'),
          'process.env.OTHER_EXTENSION_DIR': JSON.stringify(path.join(projectRoot, 'other')),
          'process.env.EXTENSION_WORKER_HOST': JSON.stringify(
            process.env.EXTENSION_WORKER_HOST ||
              `http://${HOST}:${IDE_FRONT_PORT}/assets` +
                withSlash +
                require.resolve('@opensumi/ide-extension/worker-host.js'),
          ),
          'process.env.WS_PATH': JSON.stringify(process.env.WS_PATH || `ws://${HOST}:${IDE_SERVER_PORT}`),
          'process.env.WEBVIEW_HOST': JSON.stringify(process.env.WEBVIEW_HOST || HOST),
          'process.env.STATIC_SERVER_PATH': JSON.stringify(
            process.env.STATIC_SERVER_PATH || `http://${HOST}:${IDE_SERVER_PORT}/`,
          ),
          'process.env.HOST': JSON.stringify(process.env.HOST),
        }),
        new ProvidePlugin(browserGlobals),
        !process.env.CI && new rspack.ProgressPlugin(),
        process.env.analysis && new BundleAnalyzerPlugin(),
      ].filter(Boolean),
      devServer: {
        static: {
          directory: dir + '/dist',
        },
        host: HOST,
        port: IDE_FRONT_PORT,
        allowedHosts: 'all',
        devMiddleware: {
          stats: 'errors-only',
        },
        proxy: [
          {
            context: ['/api', '/extension', '/assets', '/kaitian'],
            target: `http://${HOST}:${IDE_SERVER_PORT}`,
            changeOrigin: true,
          },
        ],
        open: process.env.SUMI_DEV_OPEN_BROWSER ? true : false,
        hot: true,
        client: {
          overlay: {
            errors: true,
            warnings: false,
            runtimeErrors: false,
          },
        },
      },
    },
    extraConfig || {},
  );

  return rspackConfig;
};

/**
 * @returns {import('@rspack/core').Configuration}
 */
exports.createWebviewRspackConfig = (entry, dir, outputPath = '/dist') => {
  const context = getBuildContext(dir);
  const { tsConfigPath, modulePaths } = context;
  const HOST = process.env.HOST || '0.0.0.0';
  const port = 8899;
  return {
    context: path.resolve(dir),
    entry,
    output: {
      filename: 'webview.js',
      path: dir + outputPath,
      clean: true,
    },
    cache: getBuildCache(context, 'webview', entry),
    resolve: {
      extensions: ['.ts', '.tsx', '.js', '.json', '.less'],
      tsConfig: { configFile: tsConfigPath },
    },
    bail: true,
    mode: process.env.NODE_ENV || 'development',
    devtool: 'source-map',
    module: {
      // https://github.com/webpack/webpack/issues/196#issuecomment-397606728
      exprContextCritical: false,
      rules: [
        {
          test: /\.tsx?$/,
          loader: context.resolve('ts-loader'),
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
      modules: modulePaths,
      extensions: ['.ts', '.tsx', '.js', '.json', '.less'],
      mainFields: ['loader', 'main'],
    },
    plugins: [
      new HtmlRspackPlugin({
        template: path.dirname(entry) + '/webview.html',
      }),
      new ProvidePlugin({
        process: require.resolve('process/browser.js'),
        Buffer: [require.resolve('buffer/'), 'Buffer'],
      }),
    ],
    devServer: {
      static: {
        directory: dir + '/public',
      },
      allowedHosts: 'all',
      port,
      host: HOST,
      open: false,
      hot: true,
      client: {
        overlay: {
          errors: true,
          warnings: false,
          runtimeErrors: false,
        },
      },
    },
  };
};

/**
 * @returns {import('@rspack/core').Configuration}
 */
exports.createNodeRspackConfig = (entry, distDir) => {
  const context = getBuildContext(typeof entry === 'string' ? path.dirname(path.resolve(entry)) : process.cwd());
  const { tsConfigPath, modulePaths } = context;
  return {
    context: context.projectRoot,
    entry,
    target: 'node',
    output: {
      filename: 'server.js',
      path: distDir,
      clean: true,
    },
    node: false,
    mode: process.env.NODE_ENV || 'development',
    devtool: 'source-map',
    optimization: {
      minimize: false,
    },
    cache: getBuildCache(context, 'node', entry),
    watch: false,
    resolve: {
      byDependency: { commonjs: { conditionNames: ['module-sync', '...'] } },
      modules: modulePaths,
      extensions: ['.ts', '.tsx', '.js', '.json'],
      tsConfig: { configFile: tsConfigPath },
    },
    module: {
      exprContextCritical: false,
      rules: [
        {
          test: /\.tsx?$/,
          use: [
            {
              loader: context.resolve('ts-loader'),
              options: {
                compiler: 'typescript-api',
                happyPackMode: true,
                transpileOnly: true,
                onlyCompileBundledFiles: true,
                configFile: tsConfigPath,
                compilerOptions: {
                  target: 'es2016',
                },
              },
            },
          ],
        },
      ],
    },
    externals: [
      function ({ request }, callback) {
        if (
          [
            'node-pty',
            'oniguruma',
            '@parcel/watcher',
            'nsfw',
            '@vscode/spdlog',
            'vm2',
            'canvas',
            '@opensumi/ripgrep',
            'vertx',
            'keytar',
            'tsconfig-paths',
          ].indexOf(request) !== -1
        ) {
          return callback(null, `commonjs ${request}`);
        }
        callback();
      },
    ],
    resolveLoader: {
      extensions: ['.ts', '.tsx', '.js', '.json'],
      mainFields: ['loader', 'main'],
      modules: modulePaths,
    },
    plugins: [!process.env.CI && new rspack.ProgressPlugin()].filter(Boolean),
  };
};
