const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.resolve(__dirname, '..');
execFileSync(
  process.execPath,
  [
    '--max-old-space-size=512',
    require('path').join(require('path').dirname(require.resolve('@typescript/native/package.json')), 'bin/tsc'),
    '--build',
    path.resolve(packageRoot, '../../configs/ts/references/tsconfig.dev-tool.json'),
  ],
  { stdio: 'inherit' },
);
fs.cpSync(path.join(packageRoot, 'src'), path.join(packageRoot, 'lib'), {
  recursive: true,
  filter: (source) => !/\.tsx?$/.test(source),
});
