import { IWSChannelCreateOptions, WSChannel, furySerializer, wrapSerializer } from '@opensumi/ide-connection';
import { DisposableCollection } from '@opensumi/ide-core-common';

import type { IConnectionShape } from '@opensumi/ide-connection/drivers';

export function createWSChannelForClient(connection: IConnectionShape<Uint8Array>, options: IWSChannelCreateOptions) {
  const disposable = new DisposableCollection();

  const wrappedConnection = wrapSerializer(connection, furySerializer);
  const channel = new WSChannel(wrappedConnection, options);
  disposable.push(
    wrappedConnection.onMessage((data) => {
      channel.dispatch(data);
    }),
  );
  connection.onceClose(() => {
    disposable.dispose();
  });

  return channel;
}
