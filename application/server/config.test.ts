import assert from 'node:assert/strict';
import { test } from 'node:test';

import { loadConfig } from './config';

test('watcher sharing stays opt-in and rejects invalid workbench modes', () => {
  assert.equal(loadConfig({}).nodeWatcherMode, 'per-client');
  assert.equal(loadConfig({ OPENSUMI_NODE_WATCHER_MODE: 'shared' }).nodeWatcherMode, 'shared');
  assert.throws(() => loadConfig({ OPENSUMI_NODE_WATCHER_MODE: 'share' }), /must be per-client or shared/);
});
