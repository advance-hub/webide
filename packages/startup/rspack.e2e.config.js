const { createRspackConfig } = require('@opensumi/ide-dev-tool/rspack');
module.exports = createRspackConfig(__dirname, require('path').join(__dirname, 'entry/web/e2e/app.tsx'));
