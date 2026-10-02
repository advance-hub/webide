import type { Page } from 'playwright';

export interface BrowserTransportDiagnostic {
  account: string;
  phase: string;
  time: string;
  path: string;
  event: 'closed' | 'error' | 'snapshot';
  sentFrames: number;
  receivedFrames: number;
  lastSentAt?: string;
  lastReceivedAt?: string;
  message?: string;
}

/** 只读观察真实浏览器传输，不替换 WebSocket，也不保存帧内容、查询参数或认证头。 */
export async function observeBrowserTransport(
  page: Page,
  account: string,
  phase: () => string,
  diagnostics: BrowserTransportDiagnostic[],
): Promise<void> {
  const session = await page.context().newCDPSession(page);
  const sockets = new Map<string, Omit<BrowserTransportDiagnostic, 'account' | 'phase' | 'time' | 'event'>>();
  const append = (requestId: string, event: BrowserTransportDiagnostic['event'], message?: string) => {
    const state = sockets.get(requestId);
    if (state) {
      diagnostics.push({ ...state, account, phase: phase(), time: new Date().toISOString(), event, message });
      if (diagnostics.length > 500) {
        diagnostics.shift();
      }
    }
    if (event === 'closed') {
      sockets.delete(requestId);
    }
  };
  session.on('Network.webSocketCreated', ({ requestId, url }) => {
    if (sockets.size < 128) {
      sockets.set(requestId, { path: new URL(url).pathname, sentFrames: 0, receivedFrames: 0 });
    }
  });
  for (const direction of ['Sent', 'Received'] as const) {
    session.on(`Network.webSocketFrame${direction}`, ({ requestId }) => {
      const state = sockets.get(requestId);
      if (!state) {
        return;
      }
      if (direction === 'Sent') {
        state.sentFrames++;
        state.lastSentAt = new Date().toISOString();
      } else {
        state.receivedFrames++;
        state.lastReceivedAt = new Date().toISOString();
      }
    });
  }
  session.on('Network.webSocketFrameError', ({ requestId, errorMessage }) => append(requestId, 'error', errorMessage));
  session.on('Network.webSocketClosed', ({ requestId }) => append(requestId, 'closed'));
  page.once('close', () => {
    // 页面销毁可能早于关闭事件；保留尚未收到关闭通知的连接最后一份计数。
    for (const requestId of sockets.keys()) {
      append(requestId, 'snapshot');
    }
    sockets.clear();
    void session.detach().catch(() => {});
  });
  await session.send('Network.enable', { maxTotalBufferSize: 65536, maxResourceBufferSize: 65536 });
}
