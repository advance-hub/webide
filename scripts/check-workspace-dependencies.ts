import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { discoverWorkspacePackages } from './check-architecture';

const dependencySections = ['dependencies', 'devDependencies', 'optionalDependencies'] as const;
const localProtocols = /^(?:workspace|file|link|portal):/;
type PackageManifest = Partial<Record<(typeof dependencySections)[number], Record<string, string>>>;

export function dependencyConflicts(root: string): { name: string; ranges: Map<string, string[]> }[] {
  // 仅检查包管理器声明的自维护工作区；下载扩展、构建产物和夹具有独立依赖契约。
  const files = [
    path.join(root, 'package.json'),
    ...discoverWorkspacePackages(root).map((pkg) => path.join(pkg.root, 'package.json')),
  ];
  const versions = new Map<string, Map<string, string[]>>();
  for (const file of files) {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as PackageManifest;
    for (const section of dependencySections) {
      for (const [name, range] of Object.entries(manifest[section] ?? {})) {
        if (localProtocols.test(range)) {
          continue;
        }
        const ranges = versions.get(name) || new Map<string, string[]>();
        const users = ranges.get(range) || [];
        users.push(path.relative(root, file));
        ranges.set(range, users);
        versions.set(name, ranges);
      }
    }
  }
  return [...versions.entries()]
    .filter(([, ranges]) => ranges.size > 1)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, ranges]) => ({ name, ranges }));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const conflicts = dependencyConflicts(path.resolve(import.meta.dirname, '..'));
  if (conflicts.length) {
    console.error('工作区依赖范围不一致：');
    for (const { name, ranges } of conflicts) {
      console.error(`\n${name}`);
      for (const [range, users] of ranges) {
        console.error(`  ${range}: ${users.join(', ')}`);
      }
    }
    process.exitCode = 1;
  } else {
    console.log('自维护工作区依赖范围一致。');
  }
}
