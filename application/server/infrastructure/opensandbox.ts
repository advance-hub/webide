import { ConnectionConfig, Sandbox, SandboxManager } from '@alibaba-group/opensandbox';

import { Config } from '../platform/config';
import { HTTPError } from '../platform/validation';

import type { SandboxInfo } from '@alibaba-group/opensandbox';

export function shellQuote(value: string): string {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

/* * 所有 OpenSandbox 传输统一使用官方 JavaScript SDK。 */
export class SandboxService {
  readonly connection: ConnectionConfig;
  readonly manager: SandboxManager;

  constructor(readonly config: Config) {
    const origin = new URL(config.sandboxURL);
    if (
      !['http:', 'https:'].includes(origin.protocol) ||
      origin.username ||
      origin.password ||
      origin.search ||
      origin.pathname !== '/'
    ) {
      throw new Error('OPEN_SANDBOX_URL must be an HTTP(S) origin');
    }
    this.connection = new ConnectionConfig({
      domain: origin.host,
      protocol: origin.protocol === 'https:' ? 'https' : 'http',
      apiKey: config.sandboxKey,
      useServerProxy: true,
      requestTimeoutSeconds: config.sandboxRequestTimeout || 300,
    });
    this.manager = SandboxManager.create({ connectionConfig: this.connection });
  }

  async list(metadata?: Record<string, string>): Promise<SandboxInfo[]> {
    const records: SandboxInfo[] = [];
    for (let page = 1; page <= 100; page++) {
      const result = await this.manager.listSandboxInfos({ metadata, page, pageSize: 100 });
      records.push(...result.items);
      if (result.items.length < 100) {
        return records;
      }
    }
    throw new HTTPError(502, '沙箱数量超过管理分页上限');
  }

  record(info: SandboxInfo): Record<string, unknown> {
    return {
      id: info.id,
      name: info.metadata?.name,
      status: info.status.state,
      statusMessage: info.status.reason || info.status.message,
      imageName: info.image?.uri,
      snapshotId: info.snapshotId,
      metadata: info.metadata,
      createdAt: info.createdAt,
      expiresAt: info.expiresAt,
      workspace: info.metadata?.['opensumi.workspace'],
      application: info.metadata?.application,
    };
  }

  async withSandbox<T>(id: string, task: (sandbox: Sandbox) => Promise<T>, timeoutSeconds = 120): Promise<T> {
    const connectionConfig = new ConnectionConfig({
      domain: this.connection.domain,
      protocol: this.connection.protocol,
      apiKey: this.config.sandboxKey,
      useServerProxy: true,
      requestTimeoutSeconds: timeoutSeconds,
    });
    const sandbox = await Sandbox.connect({ sandboxId: id, connectionConfig, skipHealthCheck: true });
    try {
      return await task(sandbox);
    } finally {
      await sandbox.close();
    }
  }

  async run(id: string, script: string, timeoutSeconds = 120): Promise<string> {
    return this.withSandbox(
      id,
      async (sandbox) => {
        const execution = await sandbox.commands.run(script, { timeoutSeconds });
        const stdout = execution.logs.stdout.map((item) => item.text).join('\n');
        if (execution.error || execution.exitCode !== 0) {
          throw new Error(
            `沙箱命令失败：${
              execution.logs.stderr
                .map((item) => item.text)
                .join('\n')
                .slice(-2000) ||
              execution.error?.value ||
              execution.exitCode
            }`,
          );
        }
        return stdout;
      },
      timeoutSeconds + 15,
    );
  }

  async endpoint(id: string, port: number): Promise<{ endpoint: string; headers: Record<string, string> }> {
    return this.withSandbox(id, async (sandbox) => {
      const value = await sandbox.getEndpoint(port);
      return { endpoint: await sandbox.getEndpointUrl(port), headers: value.headers || {} };
    });
  }

  async close(): Promise<void> {
    await this.manager.close();
  }

  async health(): Promise<void> {
    const origin = new URL(this.config.sandboxURL);
    const manager = SandboxManager.create({
      connectionConfig: new ConnectionConfig({
        domain: origin.host,
        protocol: origin.protocol === 'https:' ? 'https' : 'http',
        apiKey: this.config.sandboxKey,
        requestTimeoutSeconds: 8,
      }),
    });
    try {
      await manager.listSandboxInfos({ page: 1, pageSize: 1 });
    } finally {
      await manager.close();
    }
  }
}
