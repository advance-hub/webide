// Compatibility aliases for integrations using the historical factory names.
const config = require('./rspack');
module.exports = {
  createWebpackConfig: config.createRspackConfig,
  createNodeWebpackConfig: config.createNodeRspackConfig,
  createWebviewWebpackConfig: config.createWebviewRspackConfig,
};
