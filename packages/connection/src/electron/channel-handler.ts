import net from 'net';

import { ILogger } from '../common';
import { NetSocketConnection } from '../common/connection';
import { BaseCommonChannelHandler, CommonChannelPathHandler } from '../common/server-handler';

/**
 * Channel Handler for electron backend
 */
export class ElectronChannelHandler extends BaseCommonChannelHandler {
  private connectionListener?: (connection: net.Socket) => void;
  private readonly socketConnections = new Set<NetSocketConnection>();
  private accepting = true;

  constructor(
    private server: net.Server,
    protected commonChannelPathHandler: CommonChannelPathHandler,
    logger: ILogger = console,
  ) {
    super('electron-channel-handler', commonChannelPathHandler, logger);
  }

  doHeartbeat(): void {
    // do nothing
  }

  listen() {
    if (this.connectionListener) {
      return;
    }
    this.logger.log('init Common Channel Handler');
    this.connectionListener = (connection: net.Socket) => {
      if (!this.accepting) {
        connection.destroy();
        return;
      }
      const netConnection = new NetSocketConnection(connection);
      this.socketConnections.add(netConnection);
      netConnection.onceClose(() => this.socketConnections.delete(netConnection));
      this.receiveConnection(netConnection);
    };
    this.server.on('connection', this.connectionListener);
  }

  stopAccepting(): void {
    this.beginDrain();
    this.accepting = false;
  }

  override dispose(): void {
    this.stopAccepting();
    if (this.connectionListener) {
      this.server.off('connection', this.connectionListener);
      this.connectionListener = undefined;
    }
    for (const connection of Array.from(this.socketConnections)) {
      connection.destroy();
    }
    this.socketConnections.clear();
    super.dispose();
  }
}
