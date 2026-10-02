import { HTTPError } from '../platform/validation';

import type { IncomingMessage } from 'node:http';

/** 按原始字节计数，完整接收后解码，避免中文字符跨数据块时损坏。 */
export async function readJSONBody(request: IncomingMessage, limit = 1024 * 1024): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      throw new HTTPError(413, '请求过大');
    }
    chunks.push(buffer);
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks, size).toString('utf8') || '{}');
  } catch {
    throw new HTTPError(400, 'JSON 请求无效');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HTTPError(400, 'JSON 请求必须是对象');
  }
  return value as Record<string, unknown>;
}
