import { LogLevel } from '@opensumi/ide-core-common';
import { extProcessInit } from '@opensumi/ide-extension/host/initialize';

const builtinCommands = [
  {
    id: 'test:builtinCommand:test',
    handler: {
      handler: (args) => 'fake token',
    },
  },
];

extProcessInit({
  builtinCommands,
  logLevel: LogLevel.Info,
});
