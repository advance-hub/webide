const path = require('path');

const { createRspackConfig } = require('@opensumi/ide-dev-tool/rspack');

module.exports = createRspackConfig(__dirname, path.join(__dirname, 'entry/web/app.tsx'), {});
