import { SumiConnectionMultiplexer } from '@opensumi/ide-connection';
import { RecursiveWatcherBackend } from '@opensumi/ide-core-common/file-watch';
import { UriComponents } from '@opensumi/ide-utils';

import { IWatcherHostService, WatcherProcessManagerProxy, WatcherServiceProxy } from '../../common/watcher';

import { WatcherProcessLogger } from './watch-process-log';
import { WatcherHostServiceImpl } from './watcher.host.service';

import type { NodeWatchOptions } from '../shared-node-watcher';

/** One process, separate native subscription policies, tagged events for exact routing. */
export class SharedWatcherHostService implements IWatcherHostService {
  private sequence = 1;
  private watches = new Map<number, WatcherHostServiceImpl>();
  private stopping = false;

  constructor(
    private readonly protocol: SumiConnectionMultiplexer,
    private readonly logger: WatcherProcessLogger,
    private readonly backend: RecursiveWatcherBackend,
  ) {
    protocol.set(WatcherServiceProxy, this);
  }

  async initWatcherServer(): Promise<void> {
    if (this.stopping) {
      throw new Error('Shared watcher host is stopping');
    }
    // Each subscription initializes the native backend with its own policy.
  }

  async $watch(uri: UriComponents, options?: NodeWatchOptions): Promise<number> {
    if (this.stopping) {
      throw new Error('Shared watcher host is stopping');
    }
    const id = options?.sharedWatchId ?? this.sequence++;
    const target = this.protocol.getProxy(WatcherProcessManagerProxy);
    const isolatedProtocol = {
      set: () => undefined,
      getProxy: () => ({
        $onDidFilesChanged: (event) => target.$onDidFilesChanged({ ...event, sharedWatchId: id }),
        $onWatcherOverflow: (event) => target.$onWatcherOverflow({ ...event, sharedWatchId: id }),
        $onWatcherFailed: (event) => target.$onWatcherFailed({ ...event, sharedWatchId: id }),
      }),
    } as unknown as SumiConnectionMultiplexer;
    const host = new WatcherHostServiceImpl(isolatedProtocol, this.logger, this.backend, false);
    this.watches.set(id, host);
    try {
      await host.$setWatcherFileExcludes(options?.excludes || []);
      await host.$watch(uri, options);
      if (this.stopping || this.watches.get(id) !== host) {
        throw new Error('Shared watcher registration retired during startup');
      }
      return id;
    } catch (error) {
      this.watches.delete(id);
      await host.$dispose();
      throw error;
    }
  }

  async $unwatch(id: number): Promise<void> {
    const host = this.watches.get(id);
    this.watches.delete(id);
    await host?.$dispose();
  }

  async $setWatcherFileExcludes(): Promise<void> {
    throw new Error('Shared watcher exclusions belong to individual subscriptions');
  }

  async $dispose(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.watches.keys()].map((id) => this.$unwatch(id)));
  }
}
