import { HTTPError } from '../platform/validation';

import type { Sandbox } from '@alibaba-group/opensandbox';

type Connect = (id: string, timeoutSeconds: number, signal: AbortSignal) => Promise<Sandbox>;
interface Entry {
  key: string;
  controller: AbortController;
  client: Promise<Sandbox>;
  users: number;
  idleSince: number;
  retired: boolean;
  disposing: boolean;
  done: Promise<void>;
  finish: () => void;
}

/** 官方 SDK 客户端按沙箱和请求超时复用；租约只拥有传输，不拥有开发机。 */
export class SandboxClients {
  private readonly cached = new Map<string, Entry>();
  private readonly live = new Set<Entry>();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private closing?: Promise<void>;
  private closeError?: unknown;

  constructor(
    private readonly connect: Connect,
    private readonly capacity = 64,
    private readonly idleMilliseconds = 30_000,
  ) {
    this.timer = setInterval(() => this.prune(), Math.min(5000, idleMilliseconds));
    this.timer.unref();
  }

  private retire(entry: Entry): void {
    entry.retired = true;
    if (this.cached.get(entry.key) === entry) {
      this.cached.delete(entry.key);
    }
    if (entry.users || entry.disposing) {
      return;
    }
    entry.disposing = true;
    void entry.client
      .then(
        (client) => client.close(),
        () => undefined,
      )
      .catch((error) => {
        this.closeError = error;
      })
      .finally(() => {
        this.live.delete(entry);
        entry.finish();
      });
  }

  private prune(): void {
    const deadline = Date.now() - this.idleMilliseconds;
    for (const entry of this.cached.values()) {
      if (!entry.users && entry.idleSince <= deadline) {
        this.retire(entry);
      }
    }
  }

  private async acquire(id: string, timeoutSeconds: number): Promise<Entry> {
    const key = JSON.stringify([id, timeoutSeconds]);
    for (;;) {
      if (this.closed) {
        throw new HTTPError(503, '沙箱传输已关闭');
      }
      const cached = this.cached.get(key);
      if (cached) {
        cached.users++;
        return cached;
      }
      if (this.live.size < this.capacity) {
        const controller = new AbortController();
        let finish!: () => void;
        const entry: Entry = {
          key,
          controller,
          users: 1,
          idleSince: Date.now(),
          retired: false,
          disposing: false,
          done: new Promise<void>((resolve) => {
            finish = resolve;
          }),
          finish: () => finish(),
          client: Promise.resolve().then(() => this.connect(id, timeoutSeconds, controller.signal)),
        };
        this.cached.set(key, entry);
        this.live.add(entry);
        return entry;
      }
      // 正在退役的客户端也占容量，完成释放后才能接纳下一份传输。
      const idle = [...this.live].filter((entry) => !entry.users).sort((a, b) => a.idleSince - b.idleSince)[0];
      if (!idle) {
        throw new HTTPError(503, '沙箱传输并发容量已满');
      }
      this.retire(idle);
      await idle.done;
    }
  }

  async use<T>(id: string, task: (client: Sandbox) => Promise<T>, timeoutSeconds: number): Promise<T> {
    const entry = await this.acquire(id, timeoutSeconds);
    try {
      const client = await entry.client;
      if (this.closed) {
        throw new HTTPError(503, '沙箱传输已关闭');
      }
      return await task(client);
    } catch (error) {
      this.retire(entry);
      throw error;
    } finally {
      entry.users--;
      entry.idleSince = Date.now();
      if (entry.retired) {
        this.retire(entry);
      }
    }
  }

  close(): Promise<void> {
    if (!this.closing) {
      this.closed = true;
      clearInterval(this.timer);
      const entries = [...this.live];
      for (const entry of entries) {
        entry.controller.abort();
        this.retire(entry);
      }
      this.closing = Promise.all(entries.map((entry) => entry.done)).then(() => {
        if (this.closeError) {
          throw this.closeError;
        }
      });
    }
    return this.closing;
  }
}
