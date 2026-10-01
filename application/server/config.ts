import path from 'node:path';

export interface Config {
  root: string;
  data: string;
  host: string;
  port: number;
  publicURL: string;
  ideHost: string;
  localDemo: boolean;
  driver: 'local' | 'sandbox';
  nodeWatcherMode: 'per-client' | 'shared';
  sandboxURL: string;
  sandboxKey: string;
  sandboxImage: string;
  storageMode: 'pvc' | 'retained';
  storageClass: string;
  sandboxCPU: string;
  sandboxMemory: string;
  adminUsers: string[];
  dockerContext: string;
  volumeBackend: 'docker' | 'external';
  gitlabURL: string;
  machineLimit: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const root = path.resolve(import.meta.dirname, '../..');
  const port = Number(env.WORKBENCH_PORT || 8790);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('WORKBENCH_PORT must be a valid port');
  }
  const host = env.WORKBENCH_HOST || '127.0.0.1';
  const localDemo = env.WORKBENCH_LOCAL_DEMO !== '0';
  if (localDemo && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
    throw new Error('Local demo mode must bind to a loopback address');
  }
  const driver = env.WORKBENCH_RUNTIME_DRIVER || 'local';
  if (driver !== 'local' && driver !== 'sandbox') {
    throw new Error('WORKBENCH_RUNTIME_DRIVER must be local or sandbox');
  }
  const nodeWatcherMode = env.OPENSUMI_NODE_WATCHER_MODE || 'per-client';
  if (nodeWatcherMode !== 'per-client' && nodeWatcherMode !== 'shared') {
    throw new Error('OPENSUMI_NODE_WATCHER_MODE must be per-client or shared');
  }
  const storageMode = env.WORKBENCH_STORAGE_MODE || 'pvc';
  if (storageMode !== 'pvc' && storageMode !== 'retained') {
    throw new Error('WORKBENCH_STORAGE_MODE must be pvc or retained');
  }
  const machineLimit = Number(env.WORKBENCH_MACHINE_LIMIT || 20);
  if (!Number.isInteger(machineLimit) || machineLimit < 1 || machineLimit > 20) {
    throw new Error('WORKBENCH_MACHINE_LIMIT must be between 1 and 20');
  }
  const volumeBackend = env.WORKBENCH_VOLUME_BACKEND || 'external';
  if (volumeBackend !== 'docker' && volumeBackend !== 'external') {
    throw new Error('WORKBENCH_VOLUME_BACKEND must be docker or external');
  }
  return {
    root,
    data: path.resolve(env.WORKBENCH_DATA_DIR || path.join(root, 'application/.data')),
    host,
    port,
    publicURL: env.WORKBENCH_PUBLIC_URL || `http://127.0.0.1:${port}`,
    ideHost: env.WORKBENCH_IDE_HOST || 'localhost',
    localDemo,
    driver,
    nodeWatcherMode,
    sandboxURL: env.OPEN_SANDBOX_URL || '',
    sandboxKey: env.OPEN_SANDBOX_API_KEY || '',
    sandboxImage: env.OPEN_SANDBOX_IMAGE || '',
    storageMode,
    storageClass: env.WORKBENCH_STORAGE_CLASS || '',
    sandboxCPU: env.OPEN_SANDBOX_CPU || '2',
    sandboxMemory: env.OPEN_SANDBOX_MEMORY || '2Gi',
    adminUsers: (env.WORKBENCH_ADMIN_USERS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    gitlabURL: env.GITLAB_URL || 'https://github.com',
    dockerContext: env.WORKBENCH_DOCKER_CONTEXT || '',
    volumeBackend,
    machineLimit,
  };
}

export class HTTPError extends Error {
  constructor(
    public status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function requireString(value: unknown, label: string, limit = 200): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > limit) {
    throw new HTTPError(400, `${label}无效`);
  }
  return value.trim();
}

export function safeRelativePath(value: string): string {
  if (value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value) || value.split('/').includes('..')) {
    throw new HTTPError(400, '路径必须位于项目内');
  }
  return value;
}
