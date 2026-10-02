import path from 'node:path';

export const EXTENSION_DIRECTORY_ENVIRONMENT = 'OPENSUMI_EXTENSION_DIR';

/* * 生产环境不继承宿主用户目录的扩展。
 * 部署可以显式挂载受管理的持久扩展卷，
 * 开发模式继续使用框架既有的 ~/.sumi/extensions 默认目录。 */
export function resolveMarketplaceExtensionDirectory(
  rootDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const configured = environment[EXTENSION_DIRECTORY_ENVIRONMENT]?.trim();
  if (configured) {
    return path.resolve(configured);
  }
  if (environment.NODE_ENV === 'production') {
    return path.join(rootDirectory, 'tools/extensions');
  }
  return undefined;
}
