const { createHash } = require('node:crypto');
const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

/** Resolve build inputs from the consuming project rather than the installed tool's location. */
function getBuildContext(directory) {
  let projectRoot = path.resolve(directory);
  while (!fs.existsSync(path.join(projectRoot, 'tsconfig.json'))) {
    const parent = path.dirname(projectRoot);
    if (parent === projectRoot) {
      throw new Error(`No tsconfig.json found for ${directory}`);
    }
    projectRoot = parent;
  }
  const projectRequire = createRequire(path.join(path.resolve(directory), 'package.json'));
  const resolve = (request) => {
    try {
      return projectRequire.resolve(request);
    } catch (error) {
      if (error.code !== 'MODULE_NOT_FOUND') {
        throw error;
      }
      return require.resolve(request);
    }
  };
  return {
    projectRoot,
    tsConfigPath: path.join(projectRoot, 'tsconfig.json'),
    modulePaths: [path.join(projectRoot, 'node_modules'), path.join(__dirname, '../node_modules'), 'node_modules'],
    resolve,
  };
}

function getBuildCache(context, kind, entry) {
  const keys = [
    'NODE_ENV',
    'HOST',
    'IDE_FRONT_PORT',
    'IDE_SERVER_PORT',
    'PORT',
    'ENABLE_AI',
    'ENABLE_NOTEBOOK',
    'ENABLE_COLLABORATION',
    'COLLABORATION_PORT',
    'NOTEBOOK_SERVER_HOST',
    'MY_WORKSPACE',
    'SUPPORT_LOAD_WORKSPACE_BY_HASH',
    'OPENSUMI_E2E_COMMANDS',
    'EXTENSION_WORKER_HOST',
    'WS_PATH',
    'WEBVIEW_HOST',
    'STATIC_SERVER_PATH',
    'CI',
    'analysis',
  ];
  const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  return {
    type: 'persistent',
    name: `dev-tool-${kind}-${hash([context.projectRoot, entry]).slice(0, 16)}`,
    version: hash([process.version, Object.fromEntries(keys.map((key) => [key, process.env[key]]))]),
    buildDependencies: [
      __filename,
      path.join(__dirname, 'rspack.js'),
      context.tsConfigPath,
      ...['package.json', 'pnpm-lock.yaml'].map((file) => path.join(context.projectRoot, file)).filter(fs.existsSync),
    ],
  };
}

module.exports = { getBuildContext, getBuildCache };
