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

exports.resolveProductRuntimeMode = resolveProductRuntimeMode;
