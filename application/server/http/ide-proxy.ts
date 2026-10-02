import http, { type IncomingMessage } from 'node:http';
import https from 'node:https';

import Koa from 'koa';
import WebSocket, { WebSocketServer } from 'ws';

import { type Workspace } from '../domain/models';
import { type RuntimeDriver } from '../domain/runtime';
import { type Config } from '../platform/config';
import { ExpiringMap } from '../platform/expiring-map';
import { Store, hash, newID, now } from '../platform/store';
import { HTTPError } from '../platform/validation';

import { proxyTarget } from './proxy-target';
import { IDE_MESSAGE_LIMIT, bridgeWebSockets } from './websocket-bridge';

import type { AccessControl } from '../modules/accounts/access';

interface Ticket {
  owner: string;
  workspace: string;
  expires: number;
}

function cookie(request: IncomingMessage, name: string): string {
  return (
    (request.headers.cookie || '')
      .split(';')
      .map((value) => value.trim())
      .find((value) => value.startsWith(`${name}=`))
      ?.slice(name.length + 1) || ''
  );
}

/** 入口票据只消费一次，代理连接不转发工作台 Cookie 和用户认证头。 */
export class IDEProxy {
  private stopping = false;
  private readonly tickets = new ExpiringMap<Ticket>(10_000);
  private readonly ideSessions = new ExpiringMap<Ticket>(10_000);
  private readonly sweep: NodeJS.Timeout;
  private readonly websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: IDE_MESSAGE_LIMIT,
    perMessageDeflate: false,
  });
  private readonly sockets = new Map<string, Set<WebSocket>>();
  constructor(
    readonly config: Config,
    readonly store: Store,
    readonly driver: RuntimeDriver,
    readonly access: AccessControl,
  ) {
    // 无新请求时也回收过期认证状态；定时器由代理拥有，不阻止进程退出。
    this.sweep = setInterval(() => {
      this.tickets.pruneExpired();
      this.ideSessions.pruneExpired();
    }, 30_000);
    this.sweep.unref();
  }
  enter(workspace: Workspace): string {
    if (this.stopping) {
      throw new HTTPError(503, '服务正在关闭');
    }
    const ticket = newID() + newID();
    if (
      !this.tickets.set(hash(ticket), { owner: workspace.owner, workspace: workspace.id, expires: Date.now() + 60000 })
    ) {
      throw new HTTPError(429, '入口票据数量已达上限，请稍后重试');
    }
    const address = new URL(this.config.publicURL);
    address.hostname = `${workspace.id}.${this.config.ideHost}`;
    address.searchParams.set('ticket', ticket);
    return address.href;
  }
  connected(id: string): boolean {
    return !!this.sockets.get(id)?.size;
  }
  closeConnections(): void {
    this.stopping = true;
    for (const connections of this.sockets.values()) {
      for (const socket of connections) {
        socket.close(1001, 'Control plane stopping');
      }
    }
  }
  terminateConnections(): void {
    for (const connections of this.sockets.values()) {
      for (const socket of connections) {
        socket.terminate();
      }
    }
  }
  dispose(): void {
    this.stopping = true;
    clearInterval(this.sweep);
    this.websocketServer.close();
    this.tickets.clear();
    this.ideSessions.clear();
    this.sockets.clear();
  }
  workspaceHost(request: IncomingMessage): string | undefined {
    const hostname = (request.headers.host || '').split(':')[0];
    const id = hostname.split('.')[0];
    return /^[a-f0-9]{32}$/.test(id) && hostname.endsWith(`.${this.config.ideHost}`) ? id : undefined;
  }

  private ideAuthorization(request: IncomingMessage, id: string): Ticket {
    const session = this.ideSessions.get(hash(cookie(request, 'ide_session')));
    if (!session || session.workspace !== id || session.expires < Date.now()) {
      throw new HTTPError(401, 'IDE 会话已过期，请从工作台重新进入');
    }
    this.access.workspace(id, session.owner);
    return session;
  }

  async proxyIDE(context: Koa.Context, id: string): Promise<void> {
    const ticketValue = context.query.ticket;
    if (typeof ticketValue === 'string') {
      const key = hash(ticketValue);
      const ticket = this.tickets.take(key);
      if (!ticket || ticket.workspace !== id || ticket.expires < Date.now()) {
        throw new HTTPError(401, '入口票据无效或已过期');
      }
      this.access.workspace(id, ticket.owner);
      const token = newID() + newID();
      if (!this.ideSessions.set(hash(token), { ...ticket, expires: Date.now() + 8 * 60 * 60 * 1000 })) {
        throw new HTTPError(429, 'IDE 会话数量已达上限，请稍后重试');
      }
      context.cookies.set('ide_session', token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: this.config.publicURL.startsWith('https:'),
        maxAge: 8 * 60 * 60 * 1000,
      });
      context.redirect('/');
      return;
    }
    const session = this.ideAuthorization(context.req, id);
    const workspace = this.access.workspace(id, session.owner);
    workspace.lastActivityAt = now();
    this.store.put('workspace', workspace);
    const environment = await this.driver.inspect(workspace);
    if (!environment.ideReady || !environment.endpoint) {
      throw new HTTPError(502, 'IDE 未就绪');
    }
    const target = proxyTarget(String(environment.endpoint), context.originalUrl);
    const headers: http.OutgoingHttpHeaders = { ...context.headers, host: target.host };
    delete headers.cookie;
    delete headers.authorization;
    for (const [key, value] of Object.entries(environment.headers || {})) {
      headers[key.toLowerCase()] = value;
    }
    headers['x-workspace-id'] = id;
    context.respond = false;
    try {
      await new Promise<void>((resolve, reject) => {
        const proxy = (target.protocol === 'https:' ? https : http).request(
          target,
          { method: context.method, headers },
          (response) => {
            context.res.writeHead(response.statusCode || 502, response.headers);
            response.pipe(context.res);
            response.once('end', resolve);
          },
        );
        proxy.once('error', reject);
        proxy.setTimeout(30000, () => proxy.destroy(new Error('IDE request timed out')));
        context.req.once('aborted', () => proxy.destroy());
        context.req.pipe(proxy);
      });
    } catch (error) {
      if (!context.res.headersSent) {
        context.respond = true;
        throw new HTTPError(502, 'IDE 代理连接失败');
      }
      context.res.destroy(error instanceof Error ? error : undefined);
    }
  }

  async upgrade(request: IncomingMessage, socket: import('node:stream').Duplex, head: Buffer): Promise<void> {
    if (this.stopping) {
      socket.destroy();
      return;
    }
    const id = this.workspaceHost(request);
    if (!id) {
      socket.destroy();
      return;
    }
    const origin = request.headers.origin;
    const expected = `${new URL(this.config.publicURL).protocol}//${request.headers.host}`;
    if (origin && origin !== expected) {
      socket.destroy();
      return;
    }
    const session = this.ideAuthorization(request, id);
    const workspace = this.access.workspace(id, session.owner);
    workspace.lastActivityAt = now();
    this.store.put('workspace', workspace);
    const environment = await this.driver.inspect(workspace);
    if (this.stopping || !environment.ideReady || !environment.endpoint) {
      socket.destroy();
      return;
    }
    const connections = this.sockets.get(id) || new Set<WebSocket>();
    if (connections.size >= 8 || [...this.sockets.values()].reduce((n, s) => n + s.size, 0) >= 80) {
      socket.destroy();
      return;
    }
    const target = proxyTarget(String(environment.endpoint), request.url || '/');
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    const upstream = new WebSocket(target, {
      headers: { ...environment.headers, 'X-Workspace-Id': id },
      handshakeTimeout: 10000,
      maxPayload: IDE_MESSAGE_LIMIT,
      perMessageDeflate: false,
    });
    connections.add(upstream);
    this.sockets.set(id, connections);
    const forget = (connection: WebSocket) => {
      connections.delete(connection);
      if (!connections.size && this.sockets.get(id) === connections) {
        this.sockets.delete(id);
      }
    };
    upstream.once('close', () => forget(upstream));
    upstream.once('error', () => {
      forget(upstream);
      socket.destroy();
    });
    socket.once('close', () => {
      if (upstream.readyState === WebSocket.CONNECTING) {
        upstream.terminate();
      }
    });
    upstream.once('open', () => {
      if (this.stopping || socket.destroyed) {
        upstream.terminate();
        return;
      }
      try {
        this.websocketServer.handleUpgrade(request, socket, head, (client) => {
          connections.delete(upstream);
          connections.add(client);
          this.sockets.set(id, connections);
          client.once('close', () => forget(client));
          bridgeWebSockets(client, upstream);
        });
      } catch {
        upstream.terminate();
        socket.destroy();
      }
    });
  }
}
