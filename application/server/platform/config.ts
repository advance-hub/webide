import path from 'node:path';

import { repositoryRoot } from './paths';

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
  sandboxPlatform?: 'linux/amd64' | 'linux/arm64';
  sandboxRequestTimeout?: number;
  adminUsers: string[];
  dockerContext: string;
  volumeBackend: 'docker' | 'kubernetes' | 'external';
  kubernetesURL?: string;
  kubernetesNamespace?: string;
  kubernetesTokenFile?: string;
  kubernetesCAFile?: string;
  gitlabURL: string;
  gitBridgeURL?: string;
  machineLimit: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const root = repositoryRoot();
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
  if (!localDemo && driver === 'local') {
    throw new Error('Multi-account deployments require sandbox OS isolation');
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
  const sandboxPlatform = env.OPEN_SANDBOX_PLATFORM || undefined;
  const sandboxRequestTimeout = Number(env.OPEN_SANDBOX_REQUEST_TIMEOUT_SECONDS || 300);
  if (!Number.isInteger(sandboxRequestTimeout) || sandboxRequestTimeout < 10 || sandboxRequestTimeout > 1200) {
    throw new Error('OPEN_SANDBOX_REQUEST_TIMEOUT_SECONDS must be between 10 and 1200');
  }
  if (sandboxPlatform && !['linux/amd64', 'linux/arm64'].includes(sandboxPlatform)) {
    throw new Error('OPEN_SANDBOX_PLATFORM must be linux/amd64 or linux/arm64');
  }
  if (!['docker', 'kubernetes', 'external'].includes(volumeBackend)) {
    throw new Error('WORKBENCH_VOLUME_BACKEND must be docker, kubernetes or external');
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
    sandboxPlatform: sandboxPlatform as Config['sandboxPlatform'],
    sandboxRequestTimeout,
    adminUsers: (env.WORKBENCH_ADMIN_USERS || '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean),
    gitlabURL: env.GITLAB_URL || 'https://github.com',
    gitBridgeURL: env.WORKBENCH_GIT_BRIDGE_URL || undefined,
    dockerContext: env.WORKBENCH_DOCKER_CONTEXT || '',
    volumeBackend: volumeBackend as Config['volumeBackend'],
    kubernetesURL: env.WORKBENCH_KUBERNETES_URL || undefined,
    kubernetesNamespace: env.WORKBENCH_KUBERNETES_NAMESPACE || 'default',
    kubernetesTokenFile: env.WORKBENCH_KUBERNETES_TOKEN_FILE || undefined,
    kubernetesCAFile: env.WORKBENCH_KUBERNETES_CA_FILE || undefined,
    machineLimit,
  };
}
