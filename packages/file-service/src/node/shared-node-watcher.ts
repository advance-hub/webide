import { Autowired } from '@opensumi/di';
import {
  DidFilesChangedParams,
  FileSystemWatcherClient,
  FileWatcherFailureParams,
  FileWatcherOverflowParams,
  RecursiveWatcherBackend,
} from '@opensumi/ide-core-common/file-watch';
import { defaultFilesWatcherExcludes, flattenExcludes } from '@opensumi/ide-core-common/file-watch/preferences';
import { Domain, ServerAppContribution } from '@opensumi/ide-core-node';
import { URI, UriComponents } from '@opensumi/ide-utils';

import { IWatcherProcessManager } from '../common/watcher';

export const SharedNodeWatcherPoolToken = Symbol('SharedNodeWatcherPool');

export type SharedWatchEvent<T> = T & { sharedWatchId: number };
export interface NodeWatchOptions {
  excludes?: string[];
  recursive?: boolean;
  pollingWatch?: boolean;
  /** Private host correlation; omitted from public file events. */
  sharedWatchId?: number;
}

interface Subscription {
  uri: UriComponents;
  options?: NodeWatchOptions;
  entry?: SharedWatch;
}

interface SharedWatch {
  key: string;
  ready: Promise<number>;
  clients: Map<number, SharedNodeWatcherLease>;
}

interface HostGroup {
  host: IWatcherProcessManager;
  ready: Promise<number>;
  leases: Set<SharedNodeWatcherLease>;
  watches: Map<string, SharedWatch>;
  byHostId: Map<number, SharedWatch>;
  cancelStartup(): void;
}

/** Server-owned transport; connection leases only own their subscriptions. */
export class SharedNodeWatcherPool {
  private groups = new Map<RecursiveWatcherBackend | undefined, HostGroup>();
  private sequence = 1;
  private stopping = false;
  private retiring = new Set<Promise<void>>();

  constructor(private readonly createHost: () => IWatcherProcessManager) {}

  async acquire(client: FileSystemWatcherClient, backend?: RecursiveWatcherBackend): Promise<SharedNodeWatcherLease> {
    if (this.stopping) {
      throw new Error('Shared Node watcher is stopping');
    }
    let group = this.groups.get(backend);
    if (!group) {
      const host = this.createHost();
      group = {
        host,
        ready: Promise.resolve(0),
        leases: new Set(),
        watches: new Map(),
        byHostId: new Map(),
        cancelStartup: () => undefined,
      };
      this.groups.set(backend, group);
      const owner = group;
      host.setClient({
        onDidFilesChanged: (event) => this.dispatch(owner, event as SharedWatchEvent<DidFilesChangedParams>, 'changes'),
        onWatcherOverflow: (event) =>
          this.dispatch(owner, event as SharedWatchEvent<FileWatcherOverflowParams>, 'overflow'),
        onWatcherFailed: (event) =>
          this.dispatch(owner, event as SharedWatchEvent<FileWatcherFailureParams>, 'failure'),
      });
      group.ready = (async () => {
        let timer: NodeJS.Timeout | undefined;
        try {
          return await Promise.race([
            (async () => {
              const pid = await host.createProcess('shared-node-watcher', backend);
              await host.whenReady;
              return pid!;
            })(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Shared Node watcher startup timed out')), 15_000);
            }),
            new Promise<never>((_, reject) => {
              owner.cancelStartup = () => reject(new Error('Shared Node watcher startup was retired'));
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
      })();
    }
    const lease = new SharedNodeWatcherLease(this, group, backend, client);
    group.leases.add(lease);
    try {
      await group.ready;
      if (this.stopping) {
        throw new Error('Shared Node watcher stopped during startup');
      }
      return lease;
    } catch (error) {
      await lease.dispose();
      throw error;
    }
  }

  private dispatch(
    group: HostGroup,
    tagged: SharedWatchEvent<DidFilesChangedParams | FileWatcherOverflowParams | FileWatcherFailureParams>,
    kind: 'changes' | 'overflow' | 'failure',
  ): void {
    const { sharedWatchId, ...event } = tagged;
    const entry = group.byHostId.get(sharedWatchId);
    // Register the correlation before asking the host to subscribe, so early
    // events are delivered and late events from retired ids are ignored.
    for (const lease of new Set(entry?.clients.values())) {
      lease.deliver(kind, event);
    }
  }

  nextId(): number {
    return this.sequence++;
  }

  async attach(group: HostGroup, id: number, lease: SharedNodeWatcherLease, subscription: Subscription): Promise<void> {
    const excludes = [...new Set([...lease.excludes, ...(subscription.options?.excludes || [])])].sort();
    const options = {
      excludes,
      recursive: !!subscription.options?.recursive,
      pollingWatch: !!subscription.options?.pollingWatch,
    };
    const uri = URI.revive(subscription.uri).toString();
    const key = JSON.stringify([uri, options]);
    let entry = group.watches.get(key);
    if (!entry) {
      const hostId = this.nextId();
      entry = { key, ready: Promise.resolve(hostId), clients: new Map([[id, lease]]) };
      group.watches.set(key, entry);
      group.byHostId.set(hostId, entry);
      const ownedEntry = entry;
      const hostOptions: NodeWatchOptions = { ...options, sharedWatchId: hostId };
      entry.ready = group.host
        .watch(subscription.uri, hostOptions)
        .then((returnedId) => {
          if (returnedId !== hostId) {
            throw new Error('Shared Node watcher returned an unexpected subscription identity');
          }
          return hostId;
        })
        .catch((error) => {
          group.byHostId.delete(hostId);
          if (group.watches.get(key) === ownedEntry) {
            group.watches.delete(key);
          }
          throw error;
        });
    }
    subscription.entry = entry;
    entry.clients.set(id, lease);
    try {
      await entry.ready;
    } catch (error) {
      entry.clients.delete(id);
      subscription.entry = undefined;
      throw error;
    }
  }

  async detach(group: HostGroup, id: number, subscription: Subscription): Promise<void> {
    const entry = subscription.entry;
    subscription.entry = undefined;
    if (!entry) {
      return;
    }
    entry.clients.delete(id);
    if (entry.clients.size) {
      return;
    }
    if (group.watches.get(entry.key) === entry) {
      group.watches.delete(entry.key);
    }
    let hostId: number;
    try {
      hostId = await entry.ready;
    } catch {
      // Failed registration has no acknowledged watch to release.
      return;
    }
    group.byHostId.delete(hostId);
    await group.host.unWatch(hostId);
  }

  async release(group: HostGroup, lease: SharedNodeWatcherLease, backend?: RecursiveWatcherBackend): Promise<void> {
    group.leases.delete(lease);
    if (group.leases.size) {
      return;
    }
    if (this.groups.get(backend) === group) {
      this.groups.delete(backend);
    }
    group.cancelStartup();
    const retirement = group.host.dispose().finally(() => {
      group.byHostId.clear();
      this.retiring.delete(retirement);
    });
    this.retiring.add(retirement);
    await retirement;
  }

  async dispose(): Promise<void> {
    this.stopping = true;
    const results = await Promise.allSettled([
      ...[...this.groups.values()].flatMap((group) => [...group.leases].map((lease) => lease.dispose())),
      ...this.retiring,
    ]);
    const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
    if (failures.length) {
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        'Shared Node watcher pool cleanup failed',
      );
    }
  }
}

export class SharedNodeWatcherLease {
  excludes = flattenExcludes(defaultFilesWatcherExcludes);
  private subscriptions = new Map<number, Subscription>();
  private queue: Promise<unknown> = Promise.resolve();
  private closing = false;
  private disposal?: Promise<void>;

  constructor(
    private readonly pool: SharedNodeWatcherPool,
    private readonly group: HostGroup,
    private readonly backend: RecursiveWatcherBackend | undefined,
    private readonly client: FileSystemWatcherClient,
  ) {}

  get pid(): Promise<number> {
    return this.group.ready;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  watch(uri: UriComponents, options?: NodeWatchOptions): Promise<number> {
    if (this.closing) {
      return Promise.reject(new Error('Shared Node watcher connection is disposed'));
    }
    return this.enqueue(async () => {
      const id = this.pool.nextId();
      const subscription = { uri, options };
      this.subscriptions.set(id, subscription);
      try {
        await this.pool.attach(this.group, id, this, subscription);
        return id;
      } catch (error) {
        this.subscriptions.delete(id);
        throw error;
      }
    });
  }

  unWatch(id: number): Promise<void> {
    return this.enqueue(async () => {
      const subscription = this.subscriptions.get(id);
      if (subscription) {
        this.subscriptions.delete(id);
        await this.pool.detach(this.group, id, subscription);
      }
    });
  }

  setExcludes(excludes: string[]): Promise<void> {
    if (this.closing) {
      return Promise.reject(new Error('Shared Node watcher connection is disposed'));
    }
    return this.enqueue(async () => {
      const next = [...new Set(excludes)].sort();
      if (JSON.stringify(next) === JSON.stringify([...this.excludes].sort())) {
        return;
      }
      this.excludes = next;
      for (const [id, subscription] of this.subscriptions) {
        await this.pool.detach(this.group, id, subscription);
        await this.pool.attach(this.group, id, this, subscription);
      }
    });
  }

  deliver(kind: 'changes' | 'overflow' | 'failure', event: object): void {
    if (this.closing) {
      return;
    }
    if (kind === 'changes') {
      this.client.onDidFilesChanged(event as DidFilesChangedParams);
    } else if (kind === 'overflow') {
      this.client.onWatcherOverflow?.(event as FileWatcherOverflowParams);
    } else {
      this.client.onWatcherFailed?.(event as FileWatcherFailureParams);
    }
  }

  dispose(): Promise<void> {
    if (!this.disposal) {
      this.closing = true;
      this.disposal = this.enqueue(async () => {
        const results = await Promise.allSettled(
          [...this.subscriptions].map(([id, subscription]) => this.pool.detach(this.group, id, subscription)),
        );
        this.subscriptions.clear();
        await this.pool.release(this.group, this, this.backend);
        const failures = results.filter((result): result is PromiseRejectedResult => result.status === 'rejected');
        if (failures.length) {
          throw new AggregateError(
            failures.map((failure) => failure.reason),
            'Shared Node watcher cleanup failed',
          );
        }
      });
    }
    return this.disposal;
  }
}

@Domain(ServerAppContribution)
export class SharedNodeWatcherLifecycleContribution implements ServerAppContribution {
  @Autowired(SharedNodeWatcherPoolToken)
  private readonly pool: SharedNodeWatcherPool;

  onStop(): Promise<void> {
    return this.pool.dispose();
  }
}
