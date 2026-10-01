import { ProxyIdentifier } from '@opensumi/ide-connection/rpc-contracts';
import { Event } from '@opensumi/ide-core-common';

import type { Output } from './extension';
import type { ForkOptions } from 'child_process';
import type * as net from 'net';

/**
 * 代理服务监听的端口，可以通过 constructor 修改参数
 * @example
 * ```ts
 * injector.addProviders({
 *   token: IExtensionHostManager,
 *   useFactory: (injector) => {
 *     return injector.get(ExtensionHostProxyManager, [{
 *       port: 10299,
 *     }]);
 *   },
 * });
 * ```
 */
export const EXT_HOST_PROXY_SERVER_PROT = 10299;

/**
 * 用于插件后端服务和插件进程代理服务通信的 key
 */
export const EXT_HOST_PROXY_PROTOCOL = 'EXT_HOST_PROXY_PROTOCOL';

/**
 * Version of the private process-control wire between the IDE backend and the
 * optional Extension Host proxy process. This is deliberately independent of
 * the public `opensumi.extensions.host-control` Runtime Port, which remains v1.
 */
export const EXT_HOST_PROXY_PROCESS_WIRE_VERSION = 2 as const;

export type ExtHostProxyProtocolMode = 'lost' | 'negotiating' | 'v1' | 'v2';

export interface ExtHostProxyCapabilitiesV2 {
  readonly protocolVersion: typeof EXT_HOST_PROXY_PROCESS_WIRE_VERSION;
  readonly proxyInstanceId: string;
  readonly managerEpoch: number;
  readonly features: {
    readonly atomicLifecycle: true;
    readonly processLease: true;
    readonly sequencedProcessEvents: true;
  };
}

/** Wire identity. The backend wraps this in its own transport-epoch lease. */
export interface ExtHostProxyProcessLeaseV2 {
  readonly proxyInstanceId: string;
  readonly managerEpoch: number;
  readonly leaseId: number;
  readonly pid: number;
}

export interface ExtHostProxyForkRequestV2 {
  /** Unique within one backend transport epoch. */
  readonly operationId: string;
  readonly modulePath: string;
  readonly args: string[];
  readonly options: ForkOptions;
}

interface ExtHostProxyProcessEventBaseV2 {
  readonly operationId: string;
  readonly lease: ExtHostProxyProcessLeaseV2;
  readonly sequence: number;
}

export type ExtHostProxyProcessEventV2 =
  | (ExtHostProxyProcessEventBaseV2 & {
      readonly kind: 'exit';
      readonly code: number;
      readonly signal: string;
    })
  | (ExtHostProxyProcessEventBaseV2 & {
      readonly kind: 'message';
      readonly message: unknown;
    })
  | (ExtHostProxyProcessEventBaseV2 & {
      readonly kind: 'output';
      readonly output: Output;
    });

/**
 * 插件后端服务代理服务
 */
export interface IExtServerProxyRPCService {
  $callback(callId: number, ...args: any[]): Promise<void>;
  $processEventV2?(event: ExtHostProxyProcessEventV2): Promise<void>;
}

/**
 * 插件进程代理进程
 */
export interface IExtHostProxy {
  /**
   * 开始监听插件进程后端服务端口
   */
  init(): void;
  /**
   * 销毁所有进程
   */
  dispose(): void;
  /**
   * 连接成功的事件
   */
  onConnected: Event<void>;
}

/**
 * 插件进程代理服务
 */
export interface IExtHostProxyRPCService {
  /**
   * Optional capability probe for mixed-version deployments. A missing method
   * is the only condition under which a new backend may select the v1 wire.
   */
  $getCapabilities?(): Promise<ExtHostProxyCapabilitiesV2>;
  $forkWithLifecycleV2?(request: ExtHostProxyForkRequestV2): Promise<ExtHostProxyProcessLeaseV2>;
  $sendLeaseV2?(lease: ExtHostProxyProcessLeaseV2, message: string): Promise<void>;
  $isRunningLeaseV2?(lease: ExtHostProxyProcessLeaseV2): Promise<boolean>;
  $treeKillLeaseV2?(lease: ExtHostProxyProcessLeaseV2): Promise<void>;
  $killLeaseV2?(lease: ExtHostProxyProcessLeaseV2, signal?: string): Promise<void>;
  $isKilledLeaseV2?(lease: ExtHostProxyProcessLeaseV2): Promise<boolean>;
  $disposeLeaseV2?(lease: ExtHostProxyProcessLeaseV2): Promise<void>;
  /**
   * 远程 fork 进程
   * @param modulePath 插件进程文件
   * @param args
   */
  $fork(modulePath: string, ...args: any[]): Promise<number>;
  /**
   * 指定 pid 发送消息
   * @param pid
   * @param message
   */
  $send(pid: number, message: string): Promise<void>;
  /**
   * 查看指定进程是否存在
   * @param pid
   */
  $isRunning(pid: number): Promise<boolean>;
  /**
   * 杀掉指定进程及其子进程
   * @param pid
   */
  $treeKill(pid: number): Promise<void>;
  /**
   * 杀掉指定进程
   * @param pid
   * @param signal
   */
  $kill(pid: number, signal?: string): Promise<void>;
  /**
   * 指定进程是否被杀死
   */
  $isKilled(pid: number): Promise<boolean>;
  /**
   * 查找 debug 端口
   */
  $findDebugPort(startPort: number, giveUpAfter: number, timeout: number): Promise<number>;
  /**
   * 进程退出执行回调
   */
  $onExit(callId: number, pid: number): Promise<void>;
  /**
   * 插件进程日志输出
   */
  $onOutput(callId: number, pid: number): Promise<void>;
  /**
   * 消息事件回调
   */
  $onMessage(callId: number, pid: number): Promise<void>;
  /**
   * 销毁指定进程副作用
   * @param pid
   */
  $disposeProcess(pid: number): Promise<void>;
  /**
   * 销毁代理进程副作用
   */
  $dispose(): Promise<void>;
}

export interface IExtHostProxyOptions {
  /**
   * 插件进程代理 socket options
   */
  socketConnectOpts?: net.SocketConnectOpts;
  /**
   * 重连间隔时间
   * 默认 1000ms
   */
  retryTime?: number;
  /**
   * control rpcProtocol message timeout
   * default -1，it means disable
   */
  rpcMessageTimeout?: number;
}

/**
 * 插件后端服务 RPC Identifier
 */
export const EXT_SERVER_IDENTIFIER = new ProxyIdentifier<IExtServerProxyRPCService>('EXT_SERVER_IDENTIFIER');

/**
 * 插件进程代理 RPC Identifier
 */
export const EXT_HOST_PROXY_IDENTIFIER = new ProxyIdentifier<IExtHostProxyRPCService>('EXT_HOST_PROXY_IDENTIFIER');
