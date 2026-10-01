import { HTTPError } from './config';

/** Each resource is locked across both queues; heavy operations cannot delay stop/delete. */
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
  ): void {
    if (this.closing) {
      throw new HTTPError(503, '服务正在关闭');
    }
    if (this.active.has(key)) {
      throw new HTTPError(409, '该资源已有进行中的任务');
    }
    if (this.queues[lane].length >= 20) {
      throw new HTTPError(429, '任务队列已满，请稍后重试');
    }
    this.active.add(key);
    this.queues[lane].push(async () => {
      try {
        await task();
      } catch (error) {
        failure(error instanceof Error ? error : new Error(String(error)));
      } finally {
        this.active.delete(key);
      }
    });
    queueMicrotask(() => this.pump(lane));
  }
  busy(key: string): boolean {
    return this.active.has(key);
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
