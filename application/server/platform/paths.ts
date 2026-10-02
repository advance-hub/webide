import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

/** 源码和打包入口共用仓库标识，目录移动不能改变数据与静态资源的根路径。 */
export function repositoryRoot(start = import.meta.dirname): string {
  let directory = path.resolve(start);
  for (;;) {
    const manifest = path.join(directory, 'package.json');
    if (existsSync(manifest) && existsSync(path.join(directory, 'pnpm-workspace.yaml'))) {
      const value = JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string };
      if (value.name === '@opensumi/core') {
        return directory;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) {
      throw new Error('未找到 WebIDE 仓库根目录');
    }
    directory = parent;
  }
}
