export type ProductRuntimeMode = 'node';
export type WsGatewayModeSource = 'explicit' | 'default';

export interface WsGatewayModeResolution {
  mode: 'gateway' | 'direct';
  source: WsGatewayModeSource;
}

export declare function resolveProductRuntimeMode(environment: Record<string, string | undefined>): ProductRuntimeMode;

export declare function resolveWsGatewayMode(
  environment: Record<string, string | undefined>,
  gatewayAvailable: boolean,
): WsGatewayModeResolution;
