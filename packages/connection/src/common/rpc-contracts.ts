/** Service identities and ports shared by RPC clients and implementations. */
export class ProxyIdentifier<T = any> {
  public static count = 0;

  public readonly serviceId: string;
  public readonly countId: number;
  constructor(serviceId: string) {
    this.serviceId = serviceId;
    this.countId = ++ProxyIdentifier.count;
  }

  static for(serviceId: string) {
    return new ProxyIdentifier(serviceId);
  }
}

export const IRPCProtocol = Symbol('IRPCProtocol');
export interface IRPCProtocol {
  getProxy<T>(proxyId: ProxyIdentifier<T>): T;
  set<T>(identifier: ProxyIdentifier<T>, instance: T): T;
  get<T>(identifier: ProxyIdentifier<T>): T;
}

export enum RPCProtocolEnv {
  MAIN,
  EXT,
}

export interface IProxyIdentifier {
  serviceId: string;
  countId: number;
}

export function createExtHostContextProxyIdentifier<T>(serviceId: string): ProxyIdentifier<T> {
  return new ProxyIdentifier<T>(serviceId);
}

export function createMainContextProxyIdentifier<T>(serviceId: string): ProxyIdentifier<T> {
  return new ProxyIdentifier<T>(serviceId);
}

export { BaseConnection } from './connection/drivers/base';
export type { IRuntimeSocketConnection } from './connection/drivers/base';
export type { IConnectionShape } from './connection/types';
