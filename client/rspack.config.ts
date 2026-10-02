import { createHash } from 'node:crypto';
import path from 'node:path';

import { rspack } from '@rspack/core';
import fse from 'fs-extra';
import less from 'less';

import type { Configuration, RuleSetRule } from '@rspack/core';

const clientDirectory = import.meta.dirname;
const repoRoot = path.resolve(clientDirectory, '..');
const e2eMode = process.env.OPENSUMI_E2E_MODE === '1';
const sourceMode = process.env.OPENSUMI_SOURCE_MODE === '1';
const tsconfigPath = sourceMode
  ? path.join(repoRoot, 'configs/ts/tsconfig.resolve.json')
  : path.join(clientDirectory, 'tsconfig.rspack.json');
const outputPath = e2eMode ? path.join(repoRoot, 'packages/startup/dist') : path.join(clientDirectory, 'dist');
const templatePath = path.join(repoRoot, 'tools/dev-tool/src/index.html');
const defaultWorkspace = path.join(repoRoot, 'tools/workspace');
const clientSourcePath = path.join(clientDirectory, 'src');
const notebookModulePath = path.join(repoRoot, 'packages/notebook');
const isProduction = process.env.NODE_ENV === 'production';
const sourceMapEnabled = process.env.SOURCE_MAP === '1';
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.IDE_FRONT_PORT || 8080);
const serverPort = Number(process.env.IDE_SERVER_PORT || process.env.PORT || 8000);
const withSlash = process.platform === 'win32' ? '/' : '';

fse.mkdirpSync(defaultWorkspace);

const styleLoader = isProduction ? rspack.CssExtractRspackPlugin.loader : 'style-loader';

function createWorkspacePackageAliases(): Record<string, string> {
  if (sourceMode) {
    return {};
  }

  const packagesDirectory = path.join(repoRoot, 'packages');
  return Object.fromEntries(
    fse
      .readdirSync(packagesDirectory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(packagesDirectory, entry.name))
      .map((packageDirectory) => {
        const packageJsonPath = path.join(packageDirectory, 'package.json');
        if (!fse.existsSync(packageJsonPath)) {
          return undefined;
        }
        const packageJson = fse.readJsonSync(packageJsonPath) as { name?: unknown; exports?: unknown };
        // 明确声明公共 API 的包按照 exports 契约解析。
        // 目录别名会绕过契约，破坏公开的具名子路径。
        if (packageJson.exports) {
          return undefined;
        }
        return typeof packageJson.name === 'string' && packageJson.name.startsWith('@opensumi/')
          ? [packageJson.name, packageDirectory]
          : undefined;
      })
      .filter((entry): entry is [string, string] => Boolean(entry)),
  );
}

const workspacePackageAliases = createWorkspacePackageAliases();

function createSwcRule(): RuleSetRule {
  return {
    test: /\.tsx?$/,
    include: clientSourcePath,
    use: {
      loader: 'builtin:swc-loader',
      options: {
        detectSyntax: 'auto',
        collectTypeScriptInfo: {
          typeExports: true,
          exportedEnum: 'const-only',
        },
        jsc: {
          parser: {
            syntax: 'typescript',
            tsx: true,
            decorators: true,
          },
          transform: {
            legacyDecorator: true,
            decoratorMetadata: true,
            react: {
              runtime: 'classic',
              development: !isProduction,
              refresh: false,
            },
          },
          target: 'es2018',
          keepClassNames: true,
        },
        module: {
          type: 'es6',
        },
      },
    },
  };
}

function createTypeScriptRule(include?: string, compilerOptions: Record<string, unknown> = {}): RuleSetRule {
  return {
    test: /\.tsx?$/,
    ...(include ? { include } : { exclude: [clientSourcePath, notebookModulePath] }),
    use: {
      loader: 'ts-loader',
      options: {
        compiler: 'typescript-api',
        happyPackMode: true,
        transpileOnly: true,
        onlyCompileBundledFiles: true,
        configFile: tsconfigPath,
        compilerOptions: {
          target: 'es2018',
          sourceMap: sourceMapEnabled,
          ...compilerOptions,
        },
      },
    },
  };
}

const clientDefinitions = {
  'process.env.IS_DEV': JSON.stringify(isProduction ? 0 : 1),
  'process.env.ENABLE_AI': JSON.stringify(process.env.ENABLE_AI === '1' ? '1' : '0'),
  'process.env.ENABLE_NOTEBOOK': JSON.stringify(process.env.ENABLE_NOTEBOOK === '1' ? '1' : '0'),
  'process.env.ENABLE_COLLABORATION': JSON.stringify(process.env.ENABLE_COLLABORATION === '1' ? '1' : '0'),
  'process.env.OPENSUMI_RUNTIME_TOPOLOGY_POLICY': JSON.stringify(
    e2eMode ? 'off' : process.env.OPENSUMI_RUNTIME_TOPOLOGY_POLICY || 'compatible',
  ),
  'process.env.COLLABORATION_PORT': JSON.stringify(process.env.COLLABORATION_PORT || '12345'),
  'process.env.NOTEBOOK_SERVER_HOST': JSON.stringify(process.env.NOTEBOOK_SERVER_HOST || 'localhost:8888'),
  'process.env.WORKSPACE_DIR': JSON.stringify(process.env.MY_WORKSPACE || defaultWorkspace),
  'process.env.SUPPORT_LOAD_WORKSPACE_BY_HASH': JSON.stringify(
    !['0', 'false'].includes(process.env.SUPPORT_LOAD_WORKSPACE_BY_HASH || ''),
  ),
  'process.env.OPENSUMI_E2E_COMMANDS': JSON.stringify(process.env.OPENSUMI_E2E_COMMANDS),
  'process.env.EXTENSION_DIR': JSON.stringify(
    process.env.OPENSUMI_EXTENSION_DIR || path.join(repoRoot, 'tools/extensions'),
  ),
  'process.env.KTLOG_SHOW_DEBUG': JSON.stringify(process.env.KTLOG_SHOW_DEBUG || '0'),
  'process.env.OTHER_EXTENSION_DIR': JSON.stringify(path.join(repoRoot, 'other')),
  'process.env.EXTENSION_WORKER_HOST': JSON.stringify(
    process.env.EXTENSION_WORKER_HOST ||
      `http://${host}:${port}/assets${withSlash}${path.join(repoRoot, 'packages/extension/lib/worker-host.js')}`,
  ),
  'process.env.WS_PATH': JSON.stringify(process.env.WS_PATH || `ws://${host}:${serverPort}`),
  'process.env.WEBVIEW_HOST': JSON.stringify(process.env.WEBVIEW_HOST || host),
  'process.env.STATIC_SERVER_PATH': JSON.stringify(process.env.STATIC_SERVER_PATH || `http://${host}:${serverPort}/`),
  'process.env.HOST': JSON.stringify(process.env.HOST),
};

const config: Configuration = {
  context: repoRoot,
  entry: e2eMode
    ? path.join(repoRoot, 'packages/startup/entry/web/e2e/app.tsx')
    : path.join(clientDirectory, 'src/main.tsx'),
  target: ['web', 'es2018'],
  mode: isProduction ? 'production' : 'development',
  bail: process.env.RSPACK_STATS !== 'verbose',
  // IDE 模块图很大，源码映射会明显增加常驻内存。
  // 默认使用低内存构建，源码映射需要显式开启。
  devtool: sourceMapEnabled ? (isProduction ? 'source-map' : 'cheap-module-source-map') : false,
  cache:
    process.env.RSPACK_CACHE === '0'
      ? false
      : {
          type: 'persistent',
          // 解析缓存必须区分源码模式、编译模式和产品配置。
          name: `client-${e2eMode ? 'e2e' : 'product'}-${sourceMode ? 'source' : 'compiled'}-${isProduction ? 'production' : 'development'}`,
          version: createHash('sha256')
            .update(JSON.stringify({ clientDefinitions, sourceMapEnabled, node: process.version }))
            .digest('hex'),
          buildDependencies: [
            import.meta.filename,
            tsconfigPath,
            path.join(repoRoot, 'configs/ts/tsconfig.base.json'),
            path.join(repoRoot, 'pnpm-lock.yaml'),
          ],
        },
  node: {
    // process.ts 仅用此值判断 Node 或 CommonJS 输出。
    // 浏览器中保留未定义值，避免 Rspack 注入兼容模拟并产生警告。
    __filename: false,
    __dirname: false,
  },
  experiments: {
    asyncWebAssembly: true,
    css: false,
  },
  output: {
    filename: isProduction ? '[name].[contenthash:8].js' : 'bundle.js',
    chunkFilename: '[name].[contenthash:8].js',
    path: outputPath,
    clean: true,
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js', '.json', '.less'],
    extensionAlias: {
      // 依赖同时发布 JavaScript 与 TypeScript 时，优先使用发布的 JavaScript，
      // 例如 ansi_up；仅有源码的 .js 导入
      // 仍然回退到相应的 .ts 或 .tsx 文件。
      '.js': ['.js', '.ts', '.tsx'],
    },
    // 默认配置使用工作区包预先编译的 lib 目录。
    // 将所有 @opensumi 导入映射到 packages/*/src 会使 Rspack 保留
    // 整个框架的 TypeScript 模块图。调试框架包时，
    // 仍然可以开启源码模式，使用浏览器热更新。
    ...(sourceMode
      ? {
          tsConfig: {
            configFile: tsconfigPath,
          },
        }
      : {}),
    // 先沿用 Node 的父目录查找顺序，让 pnpm 选中嵌套的
    // 传递依赖版本；客户端工作区作为最后的回退位置，
    // 用于处理编译后样式中对 @opensumi/ide-core-browser 的自引用。
    modules: ['node_modules', path.join(clientDirectory, 'node_modules')],
    alias: {
      ...workspacePackageAliases,
      react: path.join(repoRoot, 'node_modules/react'),
      'react-dom': path.join(repoRoot, 'node_modules/react-dom'),
    },
    fallback: {
      assert: require.resolve('assert/'),
      buffer: require.resolve('buffer/'),
      process: require.resolve('process/browser.js'),
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
  module: {
    rules: [
      // 产品入口使用 Rspack 内置的快速 SWC 编译。
      createSwcRule(),
      // 框架源码需要 TypeScript 类型分析，才能生成正确的
      // 装饰器元数据；全部改用 SWC 会将已擦除的接口识别为
      // 运行时导入，导致模块链接失败。
      createTypeScriptRule(notebookModulePath, {
        module: 'esnext',
        moduleResolution: 'bundler',
      }),
      createTypeScriptRule(),
      {
        test: /\.png$/,
        type: 'asset/resource',
      },
      {
        test: /\.css$/,
        type: 'javascript/auto',
        use: [styleLoader, 'css-loader'],
      },
      {
        test: /\.module\.less$/,
        type: 'javascript/auto',
        use: [
          styleLoader,
          {
            loader: 'css-loader',
            options: {
              importLoaders: 1,
              sourceMap: sourceMapEnabled,
              // 框架源码仍然输出 CommonJS，CSS 模块对象需要
              // 使用相匹配的模块互操作语义。
              esModule: false,
              modules: {
                localIdentName: '[local]___[hash:base64:5]',
                // css-loader 7 默认会将键名转换为驼峰格式，
                // 现有样式依赖 mod_selected 这样的原始名称。
                exportLocalsConvention: 'as-is',
              },
            },
          },
          {
            loader: 'less-loader',
            options: {
              implementation: less,
              lessOptions: {
                javascriptEnabled: true,
              },
            },
          },
        ],
      },
      {
        test: /^((?!\.module).)*less$/,
        type: 'javascript/auto',
        use: [
          styleLoader,
          {
            loader: 'css-loader',
            options: {
              importLoaders: 1,
            },
          },
          {
            loader: 'less-loader',
            options: {
              implementation: less,
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
  optimization: {
    nodeEnv: isProduction ? 'production' : 'development',
    minimize: isProduction,
  },
  plugins: [
    new rspack.CopyRspackPlugin({
      patterns: [
        {
          from: path.join(repoRoot, 'packages/monaco/worker/editor.worker.bundle.js'),
          to: 'monaco/editor.worker.bundle.js',
          // Worker 已完成独立编译，保留原字节，避免客户端构建再次压缩。
          info: { minimized: true },
        },
      ],
    }),
    new rspack.HtmlRspackPlugin({
      template: templatePath,
    }),
    isProduction &&
      new rspack.CssExtractRspackPlugin({
        filename: '[name].[contenthash:8].css',
        chunkFilename: '[name].[contenthash:8].css',
      }),
    new rspack.DefinePlugin(clientDefinitions),
    new rspack.ProvidePlugin({
      process: 'process/browser.js',
      Buffer: ['buffer', 'Buffer'],
    }),
  ].filter(Boolean),
  performance: {
    hints: false,
  },
  stats:
    process.env.RSPACK_STATS === 'verbose'
      ? {
          preset: 'normal',
          errorDetails: true,
        }
      : 'errors-warnings',
  devServer: {
    static: {
      directory: outputPath,
    },
    host,
    port,
    allowedHosts: 'all',
    devMiddleware: {
      stats: 'errors-only',
    },
    proxy: [
      {
        context: ['/api', '/extension', '/assets', '/kaitian'],
        target: `http://${host}:${serverPort}`,
        changeOrigin: true,
      },
    ],
    open: Boolean(process.env.SUMI_DEV_OPEN_BROWSER),
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

export default config;
