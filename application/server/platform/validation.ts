import path from 'node:path';

export class HTTPError extends Error {
  constructor(
    public status: number,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function requireString(value: unknown, label: string, limit = 200): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > limit) {
    throw new HTTPError(400, `${label}无效`);
  }
  return value.trim();
}

export function safeRelativePath(value: string): string {
  if (value.includes('\0') || value.includes('\\') || path.posix.isAbsolute(value) || value.split('/').includes('..')) {
    throw new HTTPError(400, '路径必须位于项目内');
  }
  return value;
}
