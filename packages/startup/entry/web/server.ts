import 'tsconfig-paths/register';

import { Injector, Provider } from '@opensumi/di';
import { toRuntimePlanContract } from '@opensumi/ide-core-common';
import { startServer } from '@opensumi/ide-dev-tool/server';
import { ExpressFileServerModule } from '@opensumi/ide-express-file-server/node';
import { OpenerModule } from '@opensumi/ide-remote-opener/node';
import {
  compileOpenSumiProductRuntimePlan,
  composeLegacyEntrypointModules,
  createRuntimeTopologyServerHandshake,
  parseRuntimeTopologyHandshakePolicy,
} from '@opensumi/ide-startup';
import { AINodeBindings } from '@opensumi/ide-startup/node/ai';
import { CommonNodeBindings, CommonNodeModules } from '@opensumi/ide-startup/node/modules';
import { PtyServiceManagerToken } from '@opensumi/ide-terminal-next/node/pty-manager';
import {
  PtyServiceManagerRemote,
  PtyServiceManagerRemoteOptions,
} from '@opensumi/ide-terminal-next/node/remote-pty-manager';

const injectorProviders: Provider[] = [
  // {
  //   token: AIBackSerivceToken,
  //   useClass: AIBackService,
  // },
];

// Only override terminal pty manager to use remote proxy when env is provided.
if (process.env.PTY_PROXY_SOCK || process.env.PTY_PROXY_PORT) {
  injectorProviders.push(
    {
      token: PtyServiceManagerToken,
      useClass: PtyServiceManagerRemote,
    },
    {
      token: PtyServiceManagerRemoteOptions,
      useValue: {
        socketConnectOpts: process.env.PTY_PROXY_SOCK
          ? { path: process.env.PTY_PROXY_SOCK }
          : {
              port: Number(process.env.PTY_PROXY_PORT),
              host: process.env.PTY_PROXY_HOST,
            },
      },
    },
  );
}

const injector = new Injector(injectorProviders);
const runtimePlan = compileOpenSumiProductRuntimePlan({
  runtime: 'node',
  commonBindings: CommonNodeBindings,
  options: [{ id: 'ai', bindings: AINodeBindings }],
});

startServer({
  modules: composeLegacyEntrypointModules({
    runtimePlan,
    frameworkModules: CommonNodeModules,
    afterOptionalModules: [ExpressFileServerModule, OpenerModule],
  }),
  injector,
  runtimeTopologyHandshake: createRuntimeTopologyServerHandshake({
    runtimePlan: toRuntimePlanContract(runtimePlan),
    policy: parseRuntimeTopologyHandshakePolicy(process.env.OPENSUMI_RUNTIME_TOPOLOGY_POLICY, 'compatible'),
  }),
});
