const fs = require('node:fs');
const { createRequire } = require('node:module');
const path = require('node:path');

if (process.platform !== 'win32') {
  const terminalRequire = createRequire(path.resolve(__dirname, '../packages/terminal-next/package.json'));
  let manifest;
  try {
    manifest = terminalRequire.resolve('node-pty/package.json');
  } catch (error) {
    if (error.code === 'MODULE_NOT_FOUND') {
      // A filtered control-plane install does not include the IDE terminal.
      process.exit(0);
    }
    throw error;
  }
  const packageRoot = path.dirname(manifest);
  const helperPath = path.join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');

  if (fs.existsSync(helperPath)) {
    const mode = fs.statSync(helperPath).mode;
    fs.chmodSync(helperPath, mode | 0o111);
  }
}
