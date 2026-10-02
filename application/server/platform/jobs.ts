import { HTTPError } from './validation';

/* * 资源在所有队列之间共用锁，耗时任务不会阻塞停止和删除通道。 */
export class Jobs {
  private readonly active = new Set<string>();
  private readonly queues: Record<string, (() => Promise<void>)[]> = { heavy: [], quick: [], maven: [] };
  private readonly running: Record<string, number> = { heavy: 0, quick: 0, maven: 0 };
  private readonly limits: Record<string, number> = { heavy: 1, quick: 2, maven: 2 };
  private closing = false;
  private readonly waiters: (() => void)[] = [];

  enqueue(
    key: string,
    lane: 'heavy' | 'quick' | 'maven',
    task: () => Promise<void>,
    failure: (error: Error) => void,
    resources: string[] = [],
  ): void {
    const keys = [...new Set([key, ...resources])];
    if (this.closing) {
      throw new HTTPError(503, '服务正在关闭');
    }
    if (keys.some((item) => this.active.has(item))) {
      throw new HTTPError(409, '该资源已有进行中的任务');
    }
    if (this.queues[lane].length >= 20) {
      throw new HTTPError(429, '任务队列已满，请稍后重试');
    }
    keys.forEach((item) => this.active.add(item));
    this.queues[lane].push(async () => {
      try {
        await task();
      } catch (error) {
        failure(error instanceof Error ? error : new Error(String(error)));
      } finally {
        keys.forEach((item) => this.active.delete(item));
      }
    });
    queueMicrotask(() => this.pump(lane));
  }
  busy(key: string): boolean {
    return this.active.has(key);
  }

  async run<T>(keys: string[], task: () => Promise<T>): Promise<T> {
    if (this.closing) {
      throw new HTTPError(503, '服务正在关闭');
    }
    if (keys.some((key) => this.active.has(key))) {
      throw new HTTPError(409, '该资源已有进行中的任务');
    }
    keys.forEach((key) => this.active.add(key));
    try {
      return await task();
    } finally {
      keys.forEach((key) => this.active.delete(key));
      if (!this.active.size) {
        this.waiters.splice(0).forEach((resolve) => resolve());
      }
    }
  }

  private pump(lane: string): void {
    while (this.running[lane] < this.limits[lane] && this.queues[lane].length) {
      const task = this.queues[lane].shift()!;
      this.running[lane]++;
      void task().finally(() => {
        this.running[lane]--;
        this.pump(lane);
        if (!this.active.size) {
          this.waiters.splice(0).forEach((resolve) => resolve());
        }
      });
    }
  }
  async close(): Promise<void> {
    this.closing = true;
    if (!this.active.size) {
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }
}
