'use strict';
const fs = require('node:fs');
// This helper only returns the repository-scoped bridge lease, never a PAT.
if (process.argv[3] === 'get') {
  const input = Object.fromEntries(
    fs
      .readFileSync(0, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const i = line.indexOf('=');
        return [line.slice(0, i), line.slice(i + 1)];
      }),
  );
  const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const url = new URL(config.url);
  if (input.protocol === url.protocol.slice(0, -1) && input.host === url.host && input.path === url.pathname.slice(1)) {
    process.stdout.write(`username=${config.lease}\npassword=${config.token}\n\n`);
  }
}
