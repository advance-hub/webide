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
// A branch checkout hosted on its owner’s persistent development machine.
export interface Workspace {
  id: string;
  projectId: string;
  projectName?: string;
  ownerName?: string;
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
export const busyStates = new Set(['queued', 'preparing', 'starting', 'stopping', 'resetting', 'deleting', 'updating']);
export const labels: Record<string, string> = {
  queued: '排队中',
  preparing: '准备环境中',
  starting: '启动中',
  ready: '已就绪',
  failed: '出错',
  stopped: '已停止',
  stopping: '停止中',
  resetting: '重置文件中',
  deleting: '删除中',
  updating: '更新 IDE 中',
  none: '未创建',
};
export const opLabels: Record<string, string> = {
  start: '启动工作区',
  stop: '停止 IDE',
  restart: '重启 IDE',
  reset: '重置文件',
  delete: '删除工作区',
};
export const driverLabels: Record<string, string> = {
  local: '本地直连',
  sandbox: 'OpenSandbox 沙箱',
};
export function repository(url: string) {
  try {
    return new URL(url).pathname.replace(/^\//, '').replace(/\.git$/, '');
  } catch {
    return url;
  }
}
export function date(value?: string) {
  if (!value) {
    return '暂无记录';
  }
  return new Date(value).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}
export function projectHref(id: string, tab = 'workspace') {
  return `/projects/${id}?tab=${tab}`;
}

// Platform sandbox administration (from company-code/opensandbox).
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
export class APIError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function request<T>(path: string, payload?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: payload === undefined ? {} : { 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const data = await res.json();
  if (!res.ok) {
    throw new APIError(data.error || '请求失败，请重试', res.status);
  }
  return data;
}
