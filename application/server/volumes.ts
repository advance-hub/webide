import { readFile } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';

import { type Config, HTTPError } from './config';
import { type Machine } from './runtime';
import { type Store } from './store';

/** Exact namespace/name and UID preconditions prevent deleting a replacement claim. */
export class KubernetesVolumes {
  constructor(
    readonly config: Config,
    readonly store: Store,
  ) {}
  private async request(method: string, route: string, body?: unknown): Promise<{ status: number; value: any }> {
    const origin = new URL(this.config.kubernetesURL || 'https://kubernetes.default.svc');
    if (
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash ||
      (origin.protocol !== 'https:' &&
        !(this.config.localDemo && origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname)))
    ) {
      throw new HTTPError(400, 'Kubernetes API 地址须为可信 HTTPS origin');
    }
    const token = (
      await readFile(this.config.kubernetesTokenFile || '/var/run/secrets/kubernetes.io/serviceaccount/token', 'utf8')
    ).trim();
    const caFile =
      this.config.kubernetesCAFile ||
      (!this.config.kubernetesURL ? '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt' : undefined);
    const ca = caFile ? await readFile(caFile) : undefined;
    const payload = body ? JSON.stringify(body) : undefined;
    return new Promise((resolve, reject) => {
      const request = (origin.protocol === 'https:' ? https : http).request(
        new URL(route, origin),
        {
          method,
          ca,
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/json',
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
          },
          timeout: 10000,
          agent: false,
        },
        (response) => {
          let bytes = 0;
          const chunks: Buffer[] = [];
          response.on('data', (chunk) => {
            if ((bytes += chunk.length) > 4 * 1024 * 1024) {
              response.destroy(new Error('Kubernetes 响应过大'));
            } else {
              chunks.push(chunk);
            }
          });
          response.once('error', reject);
          response.once('end', () => {
            try {
              resolve({
                status: response.statusCode || 502,
                value: JSON.parse(Buffer.concat(chunks).toString() || '{}'),
              });
            } catch {
              reject(new HTTPError(502, 'Kubernetes 响应无效'));
            }
          });
        },
      );
      request.once('error', () => reject(new HTTPError(502, 'Kubernetes 请求失败')));
      request.once('timeout', () => request.destroy());
      request.end(payload);
    });
  }
  async remove(machine: Machine): Promise<void> {
    const namespace = this.config.kubernetesNamespace || 'default';
    if (!/^[a-f0-9]{32}$/.test(machine.id) || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(namespace)) {
      throw new HTTPError(400, '开发机或 Kubernetes namespace 无效');
    }
    const root = `/api/v1/namespaces/${namespace}`;
    const name = `opensumi-${machine.id}`;
    const route = `${root}/persistentvolumeclaims/${name}`;
    const current = await this.request('GET', route);
    if (current.status === 404) {
      return;
    }
    if (
      current.status !== 200 ||
      !current.value.metadata?.uid ||
      current.value.metadata.name !== name ||
      current.value.metadata.namespace !== namespace
    ) {
      throw new HTTPError(502, '无法确认持久卷身份');
    }
    const uid = current.value.metadata.uid;
    if (machine.volumeUID && machine.volumeUID !== uid) {
      throw new HTTPError(409, 'PVC 已被替换，保留当前卷等待检查');
    }
    machine.volumeUID = uid;
    this.store.put('machine', machine);
    // Read all pages: a referenced claim must never disappear because its pod was on page two.
    let continuation = '';
    const seen = new Set<string>();
    do {
      const pods = await this.request(
        'GET',
        `${root}/pods?limit=500${continuation ? '&continue=' + encodeURIComponent(continuation) : ''}`,
      );
      if (pods.status !== 200 || !Array.isArray(pods.value.items)) {
        throw new HTTPError(502, '无法确认 PVC 引用');
      }
      if (
        pods.value.items.some((pod: any) =>
          pod.spec?.volumes?.some((volume: any) => volume.persistentVolumeClaim?.claimName === name),
        )
      ) {
        throw new HTTPError(409, 'PVC 仍被 Pod 引用，保留卷等待处理');
      }
      continuation = pods.value.metadata?.continue || '';
      if (continuation && (seen.has(continuation) || seen.size >= 100)) {
        throw new HTTPError(502, 'Kubernetes Pod 分页无效或超过上限');
      }
      seen.add(continuation);
    } while (continuation);
    const deleted = await this.request('DELETE', route, {
      apiVersion: 'v1',
      kind: 'DeleteOptions',
      preconditions: { uid, resourceVersion: current.value.metadata.resourceVersion },
      propagationPolicy: 'Foreground',
    });
    if (![200, 202, 404].includes(deleted.status)) {
      throw new HTTPError(deleted.status === 409 ? 409 : 502, 'Kubernetes PVC 删除未接受');
    }
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await this.request('GET', route);
      if (result.status === 404) {
        return;
      }
      if (result.status !== 200 || result.value.metadata?.uid !== uid) {
        throw new HTTPError(409, 'PVC 删除期间身份已变更');
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new HTTPError(409, 'PVC 正在删除，记录已保留，请稍后重试');
  }
}
