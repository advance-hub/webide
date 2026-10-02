import type { Project as PublicProject, Workspace as PublicWorkspace } from '../../shared/contracts';
import type { Entity } from '../platform/store';

export type Project = PublicProject & Entity;
export type Workspace = PublicWorkspace & Entity;
export interface Connection {
  url: string;
  token?: string;
  provider?: 'gitlab' | 'gitee' | 'github';
  account?: string;
}
