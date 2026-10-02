import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

export async function command(
  file: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number; maxBuffer?: number } = {},
): Promise<string> {
  const { stdout } = await execute(file, args, {
    ...options,
    encoding: 'utf8',
    timeout: options.timeout ?? 120_000,
    maxBuffer: options.maxBuffer ?? 16 * 1024 * 1024,
  });
  return stdout;
}
