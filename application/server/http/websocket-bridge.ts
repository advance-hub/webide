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
  const closePeer = (target: WebSocket, code: number, reason: Buffer) => {
    stopped = true;
    if (target.readyState !== WebSocket.OPEN) {
      return;
    }
    // 保留合法关闭码；1005/1006 等本地状态不能作为关闭帧传给下一层代理。
    const valid =
      (code >= 1000 && code <= 1014 && ![1004, 1005, 1006].includes(code)) || (code >= 3000 && code <= 4999);
    const relayedCode = valid ? code : code === 1005 ? 1000 : 1011;
    try {
      target.close(relayedCode, valid ? reason : undefined);
    } catch {
      target.terminate();
    }
  };
  client.once('close', (code, reason) => closePeer(upstream, code, reason));
  upstream.once('close', (code, reason) => closePeer(client, code, reason));
  client.on('error', terminate);
  upstream.on('error', terminate);
}
