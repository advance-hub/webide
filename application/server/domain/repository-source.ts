import type { Project, Workspace } from './models';

/** 运行驱动只依赖固定基线与文件位置，不依赖仓库服务的 HTTP 或凭据实现。 */
export interface RepositorySource {
  pinWorkspace(project: Project, workspace: Workspace): Promise<string>;
  directory(project: Project): string;
  bundle(project: Project, sha: string): string;
}
