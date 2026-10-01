import { extProcessInit } from '@opensumi/ide-extension/host/initialize';

import LogServiceClass from './mock-log-service';

(async () => {
  await extProcessInit({ LogServiceClass, builtinCommands: [] });
})();
