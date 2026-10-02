export interface Project {
  id: string;
  name: string;
  url: string;
  branch: string;
  sha: string;
  status: string;
  error?: string;
  createdAt: string;
  baselineStatus?: string;
  baselineError?: string;
  baselineUpdatedAt?: string;
  baselineRequest?: { branch: string; sha?: string };
  baselineHistory?: { branch: string; sha: string; at: string }[];
}
export interface MavenOptions {
  jdk?: string;
  timeoutMinutes?: number;
  pom?: string;
  profiles?: string[];
  modules?: string[];
  alsoMake?: boolean;
  skipTests?: boolean;
  offline?: boolean;
  updateSnapshots?: boolean;
  clean?: boolean;
}
export interface MavenJob {
  id?: string;
  action: string;
  status: string;
  options?: MavenOptions;
  error?: string;
  startedAt: string;
  finishedAt?: string;
}
export interface MavenReport {
  jdk?: string;
  jdks?: string[];
  detected: boolean;
  pom?: string;
  java?: string;
  maven?: string;
  wrapper?: boolean;
  settings?: boolean;
  managedSettings?: boolean;
  repository?: string;
  profiles?: string[];
  modules?: string[];
  mirrors?: { id: string; mirrorOf: string }[];
  repositories?: string[];
  command?: string[];
  lastAction?: string;
  lastStatus?: string;
  lastAt?: string;
  log?: string;
  error?: string;
}
// 账户持久开发机上的独立分支工作区。
export interface Workspace {
  id: string;
  projectId: string;
  projectName?: string;
  ownerName?: string;
  accessRole?: 'owner' | 'member';
  branch: string;
  baseBranch?: string;
  sha?: string;
  publishedSha?: string;
  mergeRequestUrl?: string;
  status: string;
  error?: string;
  op?: string;
  driver?: 'local' | 'sandbox';
  envId?: string;
  machineId?: string;
  idePort?: number;
  legacyRoot?: boolean;
  startup?: {
    steps: { id: string; status: string; startedAt: string; finishedAt?: string; error?: string }[];
    runtime: { source: string; fingerprint?: string; node?: string; architecture?: string };
    development: {
      configured: boolean;
      ready: boolean;
      cached?: boolean;
      port?: number;
      error?: string;
      services?: { name: string; port: number; ready: boolean; running: boolean; error?: string }[];
    };
    maven?: MavenReport;
    editorConnections?: { mysql: boolean; redis: boolean; additionalDatabases: number; error?: string };
  };
  mavenJob?: MavenJob;
  mavenHistory?: MavenJob[];
  archived?: boolean;
  members?: string[];
  memberNames?: string[];
  note?: string;
  createdAt: string;
  updatedAt: string;
}
export interface Config {
  gitlabURL: string;
  localDemo: boolean;
  driver: 'local' | 'sandbox';
  sandboxAdmin: boolean;
}
export interface MachineOverview {
  machine: { id: string; envId?: string; driver: string; createdAt: string; backupError?: string } | null;
  policy?: { idleMinutes: number; autoBackupHours: number };
  job?: { status: string; action: string; error?: string };
  allocated: number;
  limit: number;
  workspaces: number;
  legacyWorkspaces: number;
}
export interface User {
  id: string;
  name: string;
  mode: 'demo' | 'gitlab';
}
export interface Catalog {
  environment: {
    driver: 'local' | 'sandbox';
    imageConfigured: boolean;
    cpu: string;
    memory: string;
    storageClass: string;
    storageMode?: 'pvc' | 'retained' | 'host';
  };
}
// 平台沙箱管理的公开传输模型。
export interface SandboxRecord {
  id: string;
  name?: string;
  status: string;
  statusMessage?: string;
  imageName?: string;
  snapshotId?: string;
  workspace?: string;
  application?: string;
  metadata?: Record<string, string>;
  createdAt?: string;
  expiresAt?: string;
  workspaceBranch?: string;
  workspaceOwner?: string;
  projectName?: string;
  workspaceArchived?: boolean;
}
export interface SnapshotRecord {
  id: string;
  name?: string;
  sandboxId?: string;
  createdAt?: string;
}
