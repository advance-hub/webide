import { createBrowserInjector } from '@opensumi/ide-dev-tool/browser';
import { MockInjector } from '@opensumi/ide-dev-tool/injector';

import { TerminalTaskSystem } from '../../src/browser/terminal-task-system';
import { ITaskSystem } from '../../src/common';

describe('TerminalTaskSystem Test Suite', () => {
  const injector: MockInjector = createBrowserInjector([]);
  injector.addProviders(
    ...[
      {
        token: ITaskSystem,
        useClass: TerminalTaskSystem,
      },
    ],
  );

  it('happy test', (done) => {
    done();
  });
});
