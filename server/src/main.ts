import { Injector, Provider } from '@opensumi/di';
import { toRuntimePlanContract } from '@opensumi/ide-core-common';
import { ExpressFileServerModule } from '@opensumi/ide-express-file-server/node';
import { OpenerModule } from '@opensumi/ide-remote-opener/node';
import {
  compileOpenSumiProductRuntimePlan,
  createRuntimeTopologyServerHandshake,
  parseRuntimeTopologyHandshakePolicy,
} from '@opensumi/ide-startup';
import { CommonNodeBindings, CommonNodeModules } from '@opensumi/ide-startup/node/modules';
import { PtyServiceManagerToken } from '@opensumi/ide-terminal-next/node/pty-manager';
import {
  PtyServiceManagerRemote,
  PtyServiceManagerRemoteOptions,
} from '@opensumi/ide-terminal-next/node/remote-pty-manager';

import { summarizeRuntimePlan } from './runtime-plan-summary';
import { startServer } from './start-server';

import type { IServerAppOpts } from '@opensumi/ide-core-node';
import type { LoadedProductOption } from '@opensumi/ide-startup';

const injectorProviders: Provider[] = [];

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

async function main() {
  const modules = [...CommonNodeModules, ExpressFileServerModule, OpenerModule];
  const loadedProductOptions: LoadedProductOption<(typeof CommonNodeModules)[number]>[] = [];
  const webSocketHandler: NonNullable<IServerAppOpts['webSocketHandler']> = [];
  if (process.env.ENABLE_AI === '1') {
    const { AINodeBindings } = await import('@opensumi/ide-startup/node/ai');
    loadedProductOptions.push({ id: 'ai', bindings: AINodeBindings });
  }
  if (process.env.ENABLE_COLLABORATION === '1') {
    const { CollaborationNodeBindings } = await import('@opensumi/ide-startup/node/collaboration');
    loadedProductOptions.push({ id: 'collaboration', bindings: CollaborationNodeBindings });
    if (process.env.COLLABORATION_TRANSPORT === 'shared') {
      const { IYWebsocketServer } = await import('@opensumi/ide-collaboration');
      const resolve = () =>
        injector.get(IYWebsocketServer) as {
          handleUpgrade: NonNullable<IServerAppOpts['webSocketHandler']>[number]['handleUpgrade'];
          beginDrain(): void;
        };
      webSocketHandler.push({
        handlerId: 'collaboration',
        handleUpgrade: (pathname, request, socket, head) => resolve().handleUpgrade(pathname, request, socket, head),
        beginDrain: () => resolve().beginDrain(),
      });
    }
  }

  const runtimePlan = compileOpenSumiProductRuntimePlan({
    runtime: 'node',
    commonBindings: CommonNodeBindings,
    options: loadedProductOptions,
  });
  modules.push(...runtimePlan.entries.slice(CommonNodeModules.length).map((entry) => entry.module));
  const runtimeTopologyHandshake = createRuntimeTopologyServerHandshake({
    runtimePlan: toRuntimePlanContract(runtimePlan),
    policy: parseRuntimeTopologyHandshakePolicy(process.env.OPENSUMI_RUNTIME_TOPOLOGY_POLICY, 'compatible'),
  });

  await startServer({
    exitAfterShutdown: true,
    modules,
    injector,
    runtimePlanSummary: summarizeRuntimePlan(runtimePlan, {
      includeFeatures: process.env.SERVER_RUNTIME_PLAN_DETAILS === '1',
    }),
    runtimeTopologyHandshake,
    webSocketHandler,
  });
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start OpenSumi Node server', error);
  process.exitCode = 1;
});
