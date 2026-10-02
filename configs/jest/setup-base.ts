import { TextDecoder, TextEncoder } from 'node:util';

// 在 GitHub Actions 中关闭常规日志。
// 避免日志噪声干扰真实问题的识别。
const originalConsole = globalThis.console;
globalThis.console = process.env.CI
  ? ({
      info: () => {},
      console: () => {},
      warn: () => {},
      error: () => {},
      log: () => {},
      time: () => {},
      timeEnd: () => {},
    } as unknown as Console)
  : originalConsole;

Object.assign(globalThis, { TextDecoder, TextEncoder });

process.on('unhandledRejection', (error) => {
  originalConsole.error('unhandledRejection', error);
  if (process.env.EXIT_ON_UNHANDLED_REJECTION) {
    process.exit(1); // 使用非零退出码报告失败。
  }
});

process.env.IS_JEST_TEST = 'true';
