import { ConstructorOf, NodeModule } from '@opensumi/ide-core-node';
import { ExpressFileServerModule } from '@opensumi/ide-express-file-server/node';
import { CommonNodeModules } from '@opensumi/ide-startup/node/modules';

export const modules: ConstructorOf<NodeModule>[] = [...CommonNodeModules, ExpressFileServerModule];
