/** 按过期时间回收条目，并限制存活条目总量，避免认证缓存随进程运行持续增长。 */
export class ExpiringMap<T extends { expires: number }> {
  private readonly entries = new Map<string, T>();
  private nextSweep = 0;

  constructor(
    private readonly capacity: number,
    private readonly clock = () => Date.now(),
    private readonly sweepInterval = 30_000,
  ) {}

  get size(): number {
    return this.entries.size;
  }

  set(key: string, value: T): boolean {
    if (this.clock() >= this.nextSweep || this.entries.size >= this.capacity) {
      this.pruneExpired();
    }
    if (!this.entries.has(key) && this.entries.size >= this.capacity) {
      return false;
    }
    this.entries.set(key, value);
    return true;
  }

  get(key: string): T | undefined {
    const value = this.entries.get(key);
    if (value && value.expires <= this.clock()) {
      this.entries.delete(key);
      return undefined;
    }
    return value;
  }

  take(key: string): T | undefined {
    const value = this.get(key);
    this.entries.delete(key);
    return value;
  }

  pruneExpired(): void {
    const now = this.clock();
    for (const [key, value] of this.entries) {
      if (value.expires <= now) {
        this.entries.delete(key);
      }
    }
    this.nextSweep = now + this.sweepInterval;
  }

  clear(): void {
    this.entries.clear();
  }
}
