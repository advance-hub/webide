/* eslint no-console: 0 */

import { join, relative } from 'path';

import chalk from 'chalk';
import depcheck from 'depcheck';
import { existsSync, readdirSync } from 'fs-extra';

import { argv } from '@opensumi/ide-core-common/node/cli';

const packagesDir = join(__dirname, '../packages');

const ghostDepsWhiteLists = [
  // 来自 @opensumi/ide-core-browser 或 @opensumi/ide-core-node 的共用依赖。
  '@opensumi/di',
  'ajv',
  'fuzzy',
  'jsonc-parser',
  'classnames',
  'react',
  'react-dom',
  'fs-extra',
  'lodash',
  '@opensumi/monaco-editor-core',
  '@opensumi/vscode-debugprotocol',
  'vscode',
  'sumi',
  'vscode-textmate',
  'react-window',
  'marked',
  'vscode-languageserver-types',
  'react-is',
  'ws',
  'koa',
];

const moduleAllowList = {
  'core-common': ['electron'],
  'file-service': ['@furyjs/fury'],
};

const options = {
  ignoreBinPackage: false, // 忽略带有可执行入口的包。
  skipMissing: false, // 跳过缺失依赖的计算。
  ignoreDirs: ['bower_components', 'node_modules', 'lib', '__tests__', '__test__'],
  ignoreMatches: [
    // 开发工具相关依赖。
    '@opensumi/ide-dev-tool',
    'npm-run-all',
    'ts-node',
    'webpack-dev-server',
    '@types/*',
    'tinybench',
  ],
  ignorePatterns: ['__tests__', '__test__', '__mocks__'],
  parsers: {
    // 目标文件解析器。
    '**/*.ts': depcheck.parser.typescript,
    '**/*.tsx': depcheck.parser.typescript,
  },
  detectors: [
    // 依赖引用检测器。
    depcheck.detector.requireCallExpression,
    depcheck.detector.importDeclaration,
  ],
  specials: [
    // 特殊文件解析器。
    depcheck.special.eslint,
    depcheck.special.webpack,
  ],
};

function check(
  rootDir: string,
  targetModuleName: string,
  config = {
    unusedDependency: true,
    unusedDevDependency: true,
    missing: true,
  },
) {
  const allowList = moduleAllowList[targetModuleName] || [];

  return new Promise<void>((resolve, reject) => {
    const cwd = process.cwd();
    depcheck(rootDir, options, (unused) => {
      if (config.unusedDependency) {
        if (unused.dependencies.length > 0) {
          console.log(chalk.yellow('Unused dependencies (or dynamic import):'));
          unused.dependencies.forEach((dependency) => {
            console.log('* ' + dependency);
          });
        } else {
        }
      }

      if (config.unusedDevDependency) {
        if (unused.devDependencies.length > 0) {
          console.log(chalk.yellow('Unused devDependencies:'));
          unused.devDependencies.forEach((dependency) => {
            console.log('* ' + dependency);
          });
        }
      }

      let missed = false;
      if (config.missing) {
        let missingDeps = Object.keys(unused.missing).filter(
          (dep) => !ghostDepsWhiteLists.includes(dep) && (!rootDir.endsWith('browser') || !rootDir.endsWith('node')),
        );
        // 排除自身对模块的引用影响
        missingDeps = missingDeps.filter((dep) => !rootDir.endsWith(dep.split('ide-')[1]));
        if (missingDeps.length > 0) {
          console.log(chalk.red('Missing dependencies:'));
          missingDeps.forEach((dependency) => {
            console.log(chalk.red(`* ${dependency} used in:`));
            unused.missing[dependency].forEach((referencePath, index) => {
              console.log(`  ${index + 1}. ${relative(cwd, referencePath)}`);
            });
            if (!allowList.includes(dependency)) {
              missed = true;
            }
          });
        }
      }
      if (missed) {
        reject('has missing dependencies');
      } else {
        resolve();
      }
    });
  });
}

async function runTaskWithPackages(targetPacks: string[]) {
  for (const targetModuleName of targetPacks) {
    const packageDir = join(packagesDir, targetModuleName);

    if (packageDir.startsWith('.') || !existsSync(join(packageDir, 'package.json'))) {
      console.log(chalk.bgYellow(`${targetModuleName} is invalid module`));
      continue;
    }

    console.log(chalk.greenBright(`--- [Deps check: ${targetModuleName}] ---`));
    try {
      await check(packageDir, targetModuleName);
    } catch (error) {
      console.log(chalk.red(`${targetModuleName} has missing dependencies`));
      process.exit(1);
    }
    console.log('');
  }

  process.exit();
}

async function bootAll() {
  const packagesDirNames = readdirSync(packagesDir);

  const targetPacks = packagesDirNames.reduce((prev, modulePath) => {
    // 前端依赖都安装到了 core-browser 里面，跳过检查
    if (['core-browser'].includes(modulePath)) {
      return prev;
    }

    prev.push(modulePath);
    return prev;
  }, [] as string[]);

  runTaskWithPackages(targetPacks);
}

const targetModule = argv.module as string;

if (targetModule) {
  console.log(`Single module mode dependency check: ${targetModule}`);
  const moduleName = targetModule.replace(/@opensumi\//, '');
  runTaskWithPackages([moduleName]).catch((err) => {
    console.log(chalk.red(`${moduleName} has missing dependencies`));
    process.exit(1);
  });
} else {
  console.log('Project level dependency check');
  bootAll();
}
