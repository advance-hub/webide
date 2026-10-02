import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { performance } from 'node:perf_hooks';
import { Writable } from 'node:stream';

import COS from 'cos-nodejs-sdk-v5';
import mysql from 'mysql2/promise';

import { type Workspace } from '../../domain/models';
import { type RuntimeDriver, startupRecord } from '../../domain/runtime';
import { type Config } from '../../platform/config';
import { Store } from '../../platform/store';
import { HTTPError, safeRelativePath } from '../../platform/validation';

export const resourceIDs = ['nacos', 'redis', 'mysql', 'rocketmq', 'elasticsearch', 'middleware', 'cos'] as const;
export type ResourceID = (typeof resourceIDs)[number];
export interface ResourceProfile {
  id: ResourceID;
  endpoint: string;
  database: string;
  username: string;
  password: string;
  secretId: string;
  secretKey: string;
  bucket: string;
  region: string;
  prefix: string;
  options: Record<string, string>;
  configured: boolean;
}

/* * 原生 HTTP 请求不继承环境代理，也不通过重定向转发凭据。 */
export function boundedHTTP(
  url: URL,
  method = 'GET',
  headers: Record<string, string> = {},
  body = '',
  limit = 1 << 20,
): Promise<{ status: number; body: Buffer; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(
      url,
      { method, headers, timeout: 6000, agent: false },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > limit) {
            response.destroy(new Error('响应超过大小上限'));
          } else {
            chunks.push(chunk);
          }
        });
        response.once('error', reject);
        response.once('end', () =>
          resolve({ status: response.statusCode || 502, body: Buffer.concat(chunks), headers: response.headers }),
        );
      },
    );
    request.once('timeout', () => request.destroy(new Error('连接超时')));
    request.once('error', reject);
    request.end(body);
  });
}

function template(id: ResourceID): ResourceProfile {
  const ports = {
    nacos: 8848,
    redis: 6379,
    mysql: 3306,
    rocketmq: 9876,
    elasticsearch: 9200,
    middleware: 9364,
    cos: 0,
  };
  return {
    id,
    endpoint: id === 'cos' ? '' : `127.0.0.1:${ports[id]}`,
    database: id === 'redis' ? '0' : '',
    username: '',
    password: '',
    secretId: '',
    secretKey: '',
    bucket: '',
    region: '',
    prefix: '',
    configured: false,
    options: id === 'nacos' ? { context_path: '/nacos', namespace: 'public' } : {},
  };
}

export function cleanPrefix(value: string): string {
  safeRelativePath(value);
  if (Buffer.byteLength(value) > 1024 || /[\r\n]/.test(value)) {
    throw new HTTPError(400, '对象前缀无效');
  }
  return value.replace(/\/+$/, '');
}
function address(endpoint: string): { host: string; port: number } {
  const url = new URL(`tcp://${endpoint}`);
  if (
    url.username ||
    url.password ||
    url.pathname ||
    url.search ||
    url.hash ||
    !url.hostname ||
    !url.port ||
    /[\s/@?#]/.test(url.hostname)
  ) {
    throw new HTTPError(400, '连接地址须为 host:port');
  }
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new HTTPError(400, '端口无效');
  }
  return { host: url.hostname.replace(/^\[|\]$/g, ''), port };
}

export function publicProfile(profile: ResourceProfile) {
  const { password, secretId, secretKey, ...view } = profile;
  return { ...view, hasPassword: !!password, hasSecretId: !!secretId, hasSecretKey: !!secretKey };
}

/* * 读取有长度上限的 TCP 响应，允许数据包在任意位置拆分。 */
function tcpExchange(endpoint: string, request: Buffer, complete: (response: Buffer) => boolean): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(address(endpoint));
    let data = Buffer.alloc(0);
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      error ? reject(error) : resolve(data);
    };
    socket.setTimeout(6000, () => finish(new Error('协议响应超时')));
    socket.once('error', finish);
    socket.once('connect', () => socket.write(request));
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (data.length > 1 << 20) {
        finish(new Error('协议响应过大'));
      } else if (complete(data)) {
        finish();
      }
    });
    socket.once('end', () => finish(new Error('协议响应不完整')));
  });
}
function redisCommand(args: string[]): string {
  return `*${args.length}\r\n` + args.map((value) => `$${Buffer.byteLength(value)}\r\n${value}\r\n`).join('');
}

export class DevelopmentResources {
  constructor(
    readonly config: Config,
    readonly store: Store,
    private readonly createCOS = (p: ResourceProfile) =>
      new COS({ SecretId: p.secretId, SecretKey: p.secretKey, Timeout: 6000 }),
  ) {}
  private key(owner: string, id: ResourceID): string {
    return `development-resource:${owner}:${id}`;
  }
  profile(owner: string, id: string): ResourceProfile {
    if (!resourceIDs.includes(id as ResourceID)) {
      throw new HTTPError(404, '开发资源不存在');
    }
    return (
      (this.store.secret(this.key(owner, id as ResourceID)) as ResourceProfile | undefined) ||
      template(id as ResourceID)
    );
  }
  save(owner: string, id: string, input: Record<string, unknown>) {
    const previous = this.profile(owner, id);
    if (input.reset) {
      this.store.db.prepare('DELETE FROM credentials WHERE owner=?').run(this.key(owner, previous.id));
      return publicProfile(template(previous.id));
    }
    const profile = { ...template(previous.id), configured: true };
    for (const key of [
      'endpoint',
      'database',
      'username',
      'password',
      'secretId',
      'secretKey',
      'bucket',
      'region',
      'prefix',
    ] as const) {
      const value = input[key];
      if (
        value !== undefined &&
        (typeof value !== 'string' ||
          Buffer.byteLength(value) > (['password', 'secretId', 'secretKey'].includes(key) ? 4096 : 1024))
      ) {
        throw new HTTPError(400, '连接字段无效');
      }
      profile[key] = typeof value === 'string' ? value : '';
    }
    if (!input.clearPassword && !profile.password && profile.endpoint === previous.endpoint) {
      profile.password = previous.password;
    }
    for (const key of ['secretId', 'secretKey'] as const) {
      if (
        !input[key] &&
        !input[`clear${key[0].toUpperCase()}${key.slice(1)}`] &&
        profile.bucket === previous.bucket &&
        profile.region === previous.region
      ) {
        profile[key] = previous[key];
      }
    }
    if (input.options !== undefined) {
      if (!input.options || Array.isArray(input.options) || typeof input.options !== 'object') {
        throw new HTTPError(400, '连接选项须为对象');
      }
      profile.options = input.options as Record<string, string>;
    }
    if (
      Object.keys(profile.options).length > 12 ||
      Object.entries(profile.options).some(
        ([k, v]) => typeof v !== 'string' || k.length > 64 || v.length > 512 || /[\r\n]/.test(v),
      )
    ) {
      throw new HTTPError(400, '连接选项无效');
    }
    if (profile.options.scheme && !['http', 'https'].includes(profile.options.scheme)) {
      throw new HTTPError(400, '协议只支持 http 或 https');
    }
    for (const name of ['context_path', 'base_path', 'health_path', 'docs_path']) {
      if (profile.options[name] && (!profile.options[name].startsWith('/') || profile.options[name].startsWith('//'))) {
        throw new HTTPError(400, '路径须为站内路径');
      }
    }
    if (profile.id === 'cos') {
      if (![profile.bucket, profile.region].every((s) => /^[a-z0-9][a-z0-9-]{1,126}[a-z0-9]$/.test(s))) {
        throw new HTTPError(400, 'COS Bucket 或 Region 无效');
      }
      profile.prefix = cleanPrefix(profile.prefix);
    } else {
      address(profile.endpoint);
    }
    if (profile.id === 'redis' && !/^\d+$/.test(profile.database || '0')) {
      throw new HTTPError(400, 'Redis DB 须为非负整数');
    }
    this.store.secret(this.key(owner, profile.id), profile);
    return publicProfile(profile);
  }
  private cos(profile: ResourceProfile): COS {
    if (!profile.configured || !profile.secretId || !profile.secretKey) {
      throw new HTTPError(400, '请保存 COS 凭据');
    }
    return this.createCOS(profile);
  }
  async objects(owner: string, relative = '', marker = '') {
    const profile = this.profile(owner, 'cos');
    const root = profile.prefix ? profile.prefix + '/' : '';
    const prefix = root + (cleanPrefix(relative) ? cleanPrefix(relative) + '/' : '');
    if (marker && !marker.startsWith(root)) {
      throw new HTTPError(400, '分页位置无效');
    }
    const data = await this.cos(profile).getBucket({
      Bucket: profile.bucket,
      Region: profile.region,
      Prefix: prefix,
      Delimiter: '/',
      MaxKeys: 100,
      Marker: marker,
    });
    return {
      root,
      prefixes: (data.CommonPrefixes || []).map((item) => item.Prefix),
      objects: (data.Contents || [])
        .filter((item) => !item.Key.endsWith('/'))
        .map((item) => ({ key: item.Key, size: Number(item.Size), lastModified: item.LastModified })),
      nextMarker: data.NextMarker || '',
      truncated: String(data.IsTruncated) === 'true',
    };
  }
  async text(owner: string, key: string) {
    const profile = this.profile(owner, 'cos');
    const root = profile.prefix ? profile.prefix + '/' : '';
    if (!key || !key.startsWith(root) || cleanPrefix(key) !== key) {
      throw new HTTPError(400, '对象路径不在当前前缀内');
    }
    const chunks: Buffer[] = [];
    let size = 0;
    const output = new Writable({
      write(chunk, _encoding, done) {
        size += chunk.length;
        if (size > 65536) {
          done(new HTTPError(400, '只支持 64 KiB 以内的 UTF-8 文本'));
        } else {
          chunks.push(Buffer.from(chunk));
          done();
        }
      },
    });
    output.on('error', () => undefined);
    const result = await this.cos(profile).getObject({
      Bucket: profile.bucket,
      Region: profile.region,
      Key: key,
      Range: 'bytes=0-65536',
      Output: output,
    });
    const body = Buffer.concat(chunks);
    if (body.length > 65536 || body.includes(0)) {
      throw new HTTPError(400, '只支持 64 KiB 以内的 UTF-8 文本');
    }
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(body);
    } catch {
      throw new HTTPError(400, '对象不是 UTF-8 文本');
    }
    return { key, content, contentType: result.headers?.['content-type'] || 'text/plain' };
  }
  async probe(owner: string, id: string) {
    const p = this.profile(owner, id);
    if (!p.configured) {
      throw new HTTPError(400, '请先保存连接');
    }
    const started = performance.now();
    try {
      let detail = '';
      if (p.id === 'cos') {
        await this.objects(owner);
        detail = 'COS Bucket 读取正常';
      } else if (p.id === 'mysql') {
        const connection = await mysql.createConnection({
          ...address(p.endpoint),
          user: p.username,
          password: p.password,
          database: p.database || undefined,
          connectTimeout: 6000,
        });
        try {
          await connection.ping();
        } finally {
          await connection.end();
        }
        detail = 'MySQL 登录正常';
      } else if (p.id === 'redis') {
        const commands = [
          ...(p.password ? [redisCommand(['AUTH', ...(p.username ? [p.username] : []), p.password])] : []),
          redisCommand(['SELECT', p.database || '0']),
          redisCommand(['PING']),
        ];
        const response = (
          await tcpExchange(
            p.endpoint,
            Buffer.from(commands.join('')),
            (buffer) => buffer.toString().split('\r\n').length > commands.length,
          )
        ).toString();
        if (response.includes('-') || !response.endsWith('+PONG\r\n')) {
          throw new Error('Redis 认证或 PING 失败');
        }
        detail = 'Redis 认证与 PING 正常';
      } else if (p.id === 'rocketmq') {
        const header = Buffer.from(
          JSON.stringify({ code: 106, language: 'JAVA', version: 0, opaque: 42, flag: 0, extFields: {} }),
        );
        const frame = Buffer.alloc(8 + header.length);
        frame.writeUInt32BE(4 + header.length);
        frame.writeUInt32BE(header.length, 4);
        header.copy(frame, 8);
        const response = await tcpExchange(
          p.endpoint,
          frame,
          (b) => b.length >= 4 && b.readUInt32BE() <= 1 << 20 && b.length >= b.readUInt32BE() + 4,
        );
        const encoded = response.readUInt32BE(4);
        const length = encoded & 0xffffff;
        if (encoded >>> 24 || length > response.length - 8) {
          throw new Error('RocketMQ 响应编码无效');
        }
        const result = JSON.parse(response.subarray(8, 8 + length).toString());
        if (
          result.code !== 0 ||
          result.opaque !== 42 ||
          !JSON.parse(response.subarray(8 + length).toString()).brokerAddrTable
        ) {
          throw new Error('NameServer 拒绝查询');
        }
        detail = 'NameServer 集群查询正常；Broker 消息权限未验证';
      } else {
        const origin = `${p.options.scheme || 'http'}://${p.endpoint}`;
        let route = p.options.health_path || p.options.docs_path || p.options.base_path || '/';
        let headers: Record<string, string> = {};
        if (p.id === 'nacos') {
          const base = (p.options.context_path || '/nacos').replace(/\/$/, '');
          const query = new URLSearchParams({
            pageNo: '1',
            pageSize: '1',
            namespaceId: p.options.namespace === 'public' ? '' : p.options.namespace || '',
          });
          if (p.username || p.password) {
            const login = await boundedHTTP(
              new URL(base + '/v1/auth/login', origin),
              'POST',
              { 'Content-Type': 'application/x-www-form-urlencoded' },
              new URLSearchParams({ username: p.username, password: p.password }).toString(),
            );
            if (login.status !== 200) {
              throw new Error('Nacos 登录被拒绝');
            }
            const token = JSON.parse(login.body.toString()).accessToken;
            if (!token) {
              throw new Error('Nacos 未返回令牌');
            }
            query.set('accessToken', token);
          }
          route = base + '/v1/ns/service/list?' + query;
        } else if (p.id === 'elasticsearch' && (p.username || p.password)) {
          headers = { Authorization: 'Basic ' + Buffer.from(`${p.username}:${p.password}`).toString('base64') };
        }
        const response = await boundedHTTP(new URL(route, origin), 'GET', headers);
        if (response.status < 200 || response.status >= 300) {
          throw new Error('HTTP 读取被拒绝');
        }
        if (p.id === 'nacos' && !Array.isArray(JSON.parse(response.body.toString()).doms)) {
          throw new Error('Nacos 服务列表无效');
        }
        detail = `${p.id} 认证与 HTTP 读取正常`;
      }
      return { status: 'ready', detail, latencyMs: Math.round(performance.now() - started) };
    } catch {
      return { status: 'failed', detail: '协议或认证检查失败，请检查连接、凭据、权限和网络' };
    }
  }
  async sync(workspace: Workspace, driver: RuntimeDriver): Promise<void> {
    const spec: Record<string, unknown> = {};
    if (!workspace.members?.length) {
      for (const id of ['mysql', 'redis'] as const) {
        const p = this.profile(workspace.owner, id);
        if (p.configured) {
          spec[id] = { endpoint: p.endpoint, database: p.database, username: p.username, password: p.password };
        }
      }
    }
    const result = await driver.helper(workspace, 'editor-connections', {
      action: workspace.members?.length ? 'remove' : 'install',
      spec,
    });
    startupRecord(workspace).editorConnections = result as unknown as NonNullable<
      Workspace['startup']
    >['editorConnections'];
    this.store.put('workspace', workspace);
  }
}
