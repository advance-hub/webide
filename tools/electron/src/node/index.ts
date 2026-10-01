import { AddonsModule } from '@opensumi/ide-addons/node';
import { ConstructorOf, NodeModule, ServerCommonModule } from '@opensumi/ide-core-node';
import { ExtensionModule } from '@opensumi/ide-extension/node';
import { OpenVsxExtensionManagerModule } from '@opensumi/ide-extension-manager/node';
import { FileSchemeNodeModule } from '@opensumi/ide-file-scheme/node';
import { FileSearchModule } from '@opensumi/ide-file-search/node';
import { FileServiceModule } from '@opensumi/ide-file-service/node';
import { LogServiceModule } from '@opensumi/ide-logs/node';
import { ProcessModule } from '@opensumi/ide-process/node';
import { SearchModule } from '@opensumi/ide-search/node';
import { TerminalNodePtyModule } from '@opensumi/ide-terminal-next/node';

import { startServer } from './server';

export const CommonNodeModules: ConstructorOf<NodeModule>[] = [
  ServerCommonModule,
  LogServiceModule,
  FileServiceModule,
  ProcessModule,
  FileSearchModule,
  SearchModule,
  TerminalNodePtyModule,
  ExtensionModule,
  OpenVsxExtensionManagerModule,
  FileSchemeNodeModule,
  AddonsModule,
];

startServer({
  modules: [...CommonNodeModules],
}).then(() => {
  // eslint-disable-next-line no-console
  console.log('ready');
  if (process.send) {
    process.send('ready');
  }
});
