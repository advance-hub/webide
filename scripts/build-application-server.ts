import path from 'node:path';

import { build } from 'esbuild';

const root = path.resolve(import.meta.dirname, '..');

await build({
  absWorkingDir: root,
  entryPoints: ['application/server/main.ts'],
  outfile: 'application/server/main.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  packages: 'external',
  target: 'node24',
  banner: { js: "import { createRequire } from 'node:module'; var require = createRequire(import.meta.url);" },
});
process.stdout.write('工作台控制面构建完成：application/server/main.mjs\n');
