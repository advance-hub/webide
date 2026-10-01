import { existsSync } from 'node:fs';
import path from 'node:path';

import { validateWsGatewayPackage } from './ws-gateway.ts';

export { resolveWsGatewayMode } from '@opensumi/ide-startup/runtime-mode';
export type { WsGatewayModeResolution, WsGatewayModeSource } from '@opensumi/ide-startup/runtime-mode';

export function hasRunnableWsGatewayPackage(
  rootDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  const binaryName = process.platform === 'win32' ? 'ws-gateway.exe' : 'ws-gateway';
  const configured = environment.OPENSUMI_WS_GATEWAY_PATH;
  const candidates = configured
    ? [path.resolve(configured)]
    : environment.NODE_ENV === 'production'
      ? [path.join(rootDirectory, 'server/dist/workspace-agent', binaryName)]
      : [
          path.join(rootDirectory, 'server/dist/workspace-agent', binaryName),
          path.join(rootDirectory, 'go/workspace-agent/bin', binaryName),
        ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) {
      continue;
    }
    try {
      validateWsGatewayPackage(candidate, environment.NODE_ENV === 'production');
      return true;
    } catch {
      return false;
    }
  }
  return false;
}
