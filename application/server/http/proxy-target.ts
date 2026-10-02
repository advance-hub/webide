/* * 保留 SDK 服务端代理前缀，拒绝客户端提供的上游来源地址。 */
export function proxyTarget(endpoint: string, requestPath: string): URL {
  const target = new URL(endpoint);
  const request = new URL(requestPath, 'http://ide.invalid');
  target.pathname = target.pathname.replace(/\/$/, '') + request.pathname;
  target.search = request.search;
  return target;
}
