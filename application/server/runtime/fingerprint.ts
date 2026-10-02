import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';

export async function runtimeFingerprint(root: string): Promise<string> {
  const hash = createHash('sha256');
  const updateFile = async (file: string) => {
    for await (const chunk of createReadStream(file)) {
      hash.update(chunk);
    }
  };
  const directory = path.join(root, '.cache/runtime-artifacts');
  const files = await readdir(directory).catch(() => []);
  for (const name of files.filter((name) => name.endsWith('.json')).sort()) {
    hash.update(name);
    await updateFile(path.join(directory, name));
  }
  for (const name of ['pnpm-lock.yaml', 'server/dist/main.js', 'server/dist/start-server.js']) {
    await updateFile(path.join(root, name));
  }
  return hash.digest('hex');
}
