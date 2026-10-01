'use strict';

/**
 * Product policy must be usable before the first TypeScript build.
 * Keep this entry dependency-free; artifacts validate the mode, never select it.
 * @param {Record<string, string | undefined>} environment
 * @returns {import('./runtime-mode.d.cts').ProductRuntimeMode}
 */
function resolveProductRuntimeMode(environment) {
  const value = (environment.OPENSUMI_RUNTIME_MODE || 'node').trim().toLowerCase();
  if (value !== 'node') {
    throw new Error(`This runtime uses Node.js only; OPENSUMI_RUNTIME_MODE must be node, got ${value}`);
  }
  return value;
}

/**
 * @param {Record<string, string | undefined>} environment
 * @param {boolean} gatewayAvailable
 * @returns {import('./runtime-mode.d.cts').WsGatewayModeResolution}
 */
function resolveWsGatewayMode(environment, gatewayAvailable) {
  const productMode = resolveProductRuntimeMode(environment);
  const raw = environment.OPENSUMI_WS_GATEWAY_MODE?.trim().toLowerCase();
  const enabledValues = ['1', 'enabled'];
  if (raw && ![...enabledValues, '0', 'off', 'disabled'].includes(raw)) {
    throw new Error(`OPENSUMI_WS_GATEWAY_MODE must be enabled or off, got ${raw}`);
  }
  const enabled = raw ? enabledValues.includes(raw) : productMode === 'hybrid';
  if (enabled && productMode === 'node') {
    throw new Error('OPENSUMI_WS_GATEWAY_MODE conflicts with OPENSUMI_RUNTIME_MODE=node');
  }
  if (enabled && !gatewayAvailable) {
    throw new Error(
      'Go WS Gateway is required but its native package is missing or invalid; run pnpm build:all to rebuild the packaged runtime',
    );
  }
  return { mode: enabled ? 'gateway' : 'direct', source: raw ? 'explicit' : 'default' };
}

exports.resolveProductRuntimeMode = resolveProductRuntimeMode;
exports.resolveWsGatewayMode = resolveWsGatewayMode;
