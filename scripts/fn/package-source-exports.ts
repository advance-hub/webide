import path from 'node:path';

export interface SourcePackageManifest {
  exports?: Record<string, string | Record<string, string>>;
  name: string;
}

/* * 源码工具与编译后调用方共用发布文件允许列表。 */
export function packageSourceExports(
  packageDirectory: string,
  manifest: SourcePackageManifest,
): Record<string, string> | undefined {
  if (!manifest.exports) {
    return undefined;
  }
  const result: Record<string, string> = {};
  for (const [subpath, conditions] of Object.entries(manifest.exports)) {
    if (typeof conditions === 'string' || !conditions['opensumi-source']) {
      continue;
    }
    const source = conditions['opensumi-source'];
    if (
      (subpath !== '.' && !subpath.startsWith('./')) ||
      subpath.includes('*') ||
      !source.startsWith('./') ||
      source.includes('*') ||
      source.split('/').includes('..')
    ) {
      throw new Error(`${manifest.name}: source exports must name explicit package-local files (${subpath})`);
    }
    result[manifest.name + subpath.slice(1)] = path.resolve(packageDirectory, source);
  }
  return result;
}
