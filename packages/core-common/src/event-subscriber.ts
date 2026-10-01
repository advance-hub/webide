import type { IDisposable } from '@opensumi/ide-utils';

/** Event subscription contract shared by local services and RPC clients. */
export interface IEventSubscriber<Events> {
  on(event: Events, listener: (...args) => void): IDisposable;
}
