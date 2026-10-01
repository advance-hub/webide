/** Preserve the SDK server-proxy prefix without accepting a client-supplied upstream origin. */
export function proxyTarget(endpoint: string, requestPath: string): URL {
  const target = new URL(endpoint);
  const request = new URL(requestPath, 'http://ide.invalid');
  target.pathname = target.pathname.replace(/\/$/, '') + request.pathname;
  target.search = request.search;
  return target;
}
