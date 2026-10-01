import * as path from 'path';

import execa from 'execa';
import * as fs from 'fs-extra';
import { globSync } from 'glob';

import { assertMemoryHeadroom } from './fn/memory.ts';
import { toPackageLibResourcePath } from './fn/package-resource-path.ts';

(async () => {
  const repoRoot = path.join(__dirname, '..');
  const buildConfigPath = path.join(repoRoot, 'configs/ts/tsconfig.build.json');
  const buildConfig = (await fs.readJSON(buildConfigPath)) as { references: Array<{ path: string }> };
  const projects = Array.from(
    new Set(buildConfig.references.map((reference) => path.resolve(path.dirname(buildConfigPath), reference.path))),
  );
  const buildFrom = process.env.OPENSUMI_BUILD_FROM;
  const startIndex = buildFrom
    ? projects.findIndex(
        (project) => path.basename(project) === buildFrom || path.relative(repoRoot, project) === buildFrom,
      )
    : 0;
  if (startIndex < 0) {
    throw new Error(`Unknown OPENSUMI_BUILD_FROM project: ${buildFrom}`);
  }

  const tscEntry = path.join(repoRoot, 'node_modules/@typescript/native/bin/tsc');
  const childEnv = { ...process.env };
  delete childEnv.NODE_OPTIONS;
  const largeProjects = new Set(['tsconfig.ai-native.json', 'tsconfig.extension.json', 'tsconfig.notebook.json']);

  for (const [index, project] of projects.entries()) {
    if (index < startIndex) {
      continue;
    }

    const projectName = path.basename(project);
    assertMemoryHeadroom(`Build before ${projectName}`, {
      minimumFreeMemoryMb: 1024,
      minimumFreeMemoryPercent: 20,
    });
    const maxOldSpaceMb = largeProjects.has(projectName) ? 768 : 512;
    console.log(`[TSC ${index + 1}/${projects.length}]: ${path.relative(process.cwd(), project)}`);
    await execa(
      process.execPath,
      [
        `--max-old-space-size=${maxOldSpaceMb}`,
        tscEntry,
        '--build',
        ...(process.env.OPENSUMI_BUILD_FORCE === '1' ? ['--force'] : []),
        project,
        '--pretty',
        'false',
      ],
      {
        env: childEnv,
        stdio: 'inherit',
      },
    );
  }

  for (const [directory, pattern] of [
    ['packages', '*/src/**/!(*.ts|*.tsx)'],
    ['tools', 'dev-tool/src/**/!(*.ts|*.tsx)'],
  ]) {
    console.log(`[COPY]: ${directory}/${pattern}`);
    const cwd = path.join(repoRoot, directory);
    const files = globSync(pattern, { cwd, nodir: true });
    for (const file of files) {
      const from = path.join(cwd, file);
      const to = path.join(cwd, toPackageLibResourcePath(file));
      await fs.mkdirp(path.dirname(to));
      await fs.copyFile(from, to);
    }
  }
})().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
