import { Autowired, Injectable } from '@opensumi/di';
import { INodeLogger } from '@opensumi/ide-core-node';

import { ICollaborationServiceForClient, IYWebsocketServer } from '../common';

@Injectable()
export class CollaborationServiceForClient implements ICollaborationServiceForClient {
  private closed = false;
  private readonly references = new Map<string, number>();
  @Autowired(INodeLogger)
  private logger: INodeLogger;

  @Autowired(IYWebsocketServer)
  private server: IYWebsocketServer;

  async requestInitContent(uri: string): Promise<void> {
    if (this.closed) {
      throw new Error('Collaboration client is closed');
    }
    await this.server.requestInitContent(uri);
    if (this.closed) {
      this.server.releaseContent(uri);
      throw new Error('Collaboration client closed while loading content');
    }
    this.references.set(uri, (this.references.get(uri) || 0) + 1);
  }

  async releaseContent(uri: string): Promise<void> {
    const count = this.references.get(uri) || 0;
    if (!count) {
      return;
    }
    if (count === 1) {
      this.references.delete(uri);
    } else {
      this.references.set(uri, count - 1);
    }
    this.server.releaseContent(uri);
  }

  /** 连接注入器销毁时只释放自身租约，迟到的初始化结果也会立即退租。 */
  dispose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const [uri, count] of this.references) {
      for (let index = 0; index < count; index++) {
        this.server.releaseContent(uri);
      }
    }
    this.references.clear();
  }
}
