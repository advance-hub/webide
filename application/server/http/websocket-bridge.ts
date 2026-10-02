import WebSocket from 'ws';

// IDE 通道允许 32 MiB 消息；代理两端采用相同上限，并在入队前检查待发送字节。
export const IDE_MESSAGE_LIMIT = 32 * 1024 * 1024;
export const IDE_SEND_BUFFER_LIMIT = 32 * 1024 * 1024;

export function bridgeWebSockets(client: WebSocket, upstream: WebSocket): void {
  let stopped = false;
  const terminate = () => {
    if (!stopped) {
      stopped = true;
      client.terminate();
      upstream.terminate();
    }
  };
  const forward = (target: WebSocket, data: WebSocket.RawData, binary: boolean) => {
    if (stopped || target.readyState !== WebSocket.OPEN) {
      return;
    }
    const size = Array.isArray(data) ? data.reduce((total, part) => total + part.length, 0) : data.byteLength;
    if (size > IDE_MESSAGE_LIMIT || target.bufferedAmount + size > IDE_SEND_BUFFER_LIMIT) {
      terminate();
      return;
    }
    try {
      target.send(data, { binary }, (error) => {
        if (error) {
          terminate();
        }
      });
    } catch {
      terminate();
    }
  };
  client.on('message', (data, binary) => forward(upstream, data, binary));
  upstream.on('message', (data, binary) => forward(client, data, binary));
  client.once('close', () => upstream.close());
  upstream.once('close', () => client.close());
  client.on('error', terminate);
  upstream.on('error', terminate);
}
