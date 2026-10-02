import { open } from 'node:fs/promises';

/** 只读取末尾所需字节，避免截取日志片段后仍持有整份大字符串。 */
export async function readTextTail(file: string, characters = 4000): Promise<string> {
  if (!Number.isSafeInteger(characters) || characters < 1 || characters > 1_000_000) {
    throw new RangeError('日志尾部长度须为 1–1000000 个字符');
  }
  const handle = await open(file, 'r');
  try {
    const { size } = await handle.stat();
    // UTF-8 每个码点最多四字节；额外读取的前缀会在字符截取时丢弃。
    const length = Math.min(size, characters * 4);
    const buffer = Buffer.allocUnsafe(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, size - length + offset);
      if (!bytesRead) {
        break;
      }
      offset += bytesRead;
    }
    return buffer.subarray(0, offset).toString('utf8').slice(-characters);
  } finally {
    await handle.close();
  }
}
