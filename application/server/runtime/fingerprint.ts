import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

export async function runtimeFingerprint(root: string): Promise<string> {
  const hash = createHash('sha256');
  const directory = path.join(root, '.cache/runtime-artifacts');
  const files = await readdir(directory).catch(() => []);
  for (const name of files.filter((name) => name.endsWith('.json')).sort()) {
    hash.update(name);
    hash.update(await readFile(path.join(directory, name)));
  }
  for (const name of ['pnpm-lock.yaml', 'server/dist/main.js', 'server/dist/start-server.js']) {
    hash.update(await readFile(path.join(root, name)));
  }
  return hash.digest('hex');
}
