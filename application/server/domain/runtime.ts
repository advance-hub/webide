import type { Project, Workspace } from './models';
import type { RepositorySource } from './repository-source';
import type { Entity } from '../platform/store';

export interface Machine extends Entity {
  driver: 'local' | 'sandbox';
  envId?: string;
  createdAt: string;
}
export interface Environment {
  exists: boolean;
  phase: string;
  ideReady: boolean;
  endpoint?: string;
  headers?: Record<string, string>;
  [key: string]: unknown;
}
export interface RuntimeDriver {
  readonly name: 'local' | 'sandbox';
  root(workspace: Workspace): string;
  projectDirectory(workspace: Workspace): string;
  provision(machine: Machine): Promise<void>;
  prepare(workspace: Workspace, project: Project, repositories: RepositorySource, reset?: boolean): Promise<void>;
  start(workspace: Workspace): Promise<void>;
  stop(workspace: Workspace): Promise<void>;
  inspect(workspace: Workspace): Promise<Environment>;
  helper(workspace: Workspace, name: string, input: Record<string, unknown>): Promise<Record<string, unknown>>;
  remove(workspace: Workspace, project: Project, repositories: RepositorySource): Promise<void>;
  release(machine: Machine): Promise<void>;
  close(): Promise<void>;
  exportBranch?(workspace: Workspace, target: string): Promise<string>;
  exportMachine?(machine: Machine, target: string): Promise<void>;
  restoreMachine?(machine: Machine, action: 'stage' | 'apply' | 'commit' | 'rollback', archive?: string): Promise<void>;
  upgradeMachine?(machine: Machine): Promise<void>;
}

export function startupRecord(workspace: Workspace): NonNullable<Workspace['startup']> {
  return (workspace.startup ||= {
    steps: [],
    runtime: { source: workspace.driver || 'local' },
    development: { configured: false, ready: false },
  });
}
