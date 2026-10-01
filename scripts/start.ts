import { argv } from '@opensumi/ide-core-common/node/cli';

import { startFromFolder } from './fn/module';

const folderName = (argv.folder as string) || 'packages/startup';
const scriptName = (argv.script as string) || 'start';

if (!folderName) {
  throw Error('folderName is required.');
}

startFromFolder(folderName, scriptName);
