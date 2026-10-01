import { status } from '@grpc/grpc-js';

import { FileUri } from '@opensumi/ide-core-node';

import { SEARCH_STATE } from '../../src';
import { ContentSearchService } from '../../src/node/content-search.service';

describe('Workspace Agent content search failure handling', () => {
  it.each(['error', 'node'])('uses Node search after Agent startup failure only with policy %s', async (policy) => {
    expect.hasAssertions();
    const previousMode = process.env.OPENSUMI_WORKSPACE_AGENT_SEARCH_MODE;
    const previousFallback = process.env.OPENSUMI_WORKSPACE_AGENT_FALLBACK;
    try {
      process.env.OPENSUMI_WORKSPACE_AGENT_SEARCH_MODE = 'enabled';
      process.env.OPENSUMI_WORKSPACE_AGENT_FALLBACK = policy;
      const failure = new Error('agent unavailable');
      const service = Object.create(ContentSearchService.prototype) as any;
      service.searchWithWorkspaceAgent = jest.fn().mockRejectedValue(failure);
      service.searchWithNode = jest.fn().mockResolvedValue(7);
      service.searchError = jest.fn();
      service.logger = { error: jest.fn() };
      if (policy === 'error') {
        await expect(service.search(7, 'query', [])).rejects.toBe(failure);
        expect(service.searchWithNode).not.toHaveBeenCalled();
        expect(service.searchError).toHaveBeenCalledWith(7, 'Workspace Agent search could not start.');
      } else {
        await expect(service.search(7, 'query', [])).resolves.toBe(7);
        expect(service.searchWithNode).toHaveBeenCalledTimes(1);
      }
    } finally {
      if (previousMode === undefined) {
        delete process.env.OPENSUMI_WORKSPACE_AGENT_SEARCH_MODE;
      } else {
        process.env.OPENSUMI_WORKSPACE_AGENT_SEARCH_MODE = previousMode;
      }
      if (previousFallback === undefined) {
        delete process.env.OPENSUMI_WORKSPACE_AGENT_FALLBACK;
      } else {
        process.env.OPENSUMI_WORKSPACE_AGENT_FALLBACK = previousFallback;
      }
    }
  });

  it('reports an unexpected client cancellation as an error instead of a completed search', async () => {
    expect.assertions(3);
    let handlers: any;
    const workspaceAgent = {
      search: jest.fn().mockImplementation(async (_request, nextHandlers) => {
        handlers = nextHandlers;
        return { dispose: jest.fn() };
      }),
    };
    const service = Object.create(ContentSearchService.prototype) as any;
    Object.assign(service, {
      workspaceAgent,
      logger: { debug: jest.fn(), error: jest.fn() },
      processMap: new Map(),
      shadowProcessMap: new Map(),
      parityMap: new Map(),
      sendResultToClient: jest.fn(),
    });

    await service.searchWithWorkspaceAgent(7, 'query', [FileUri.create('/workspace').toString()]);
    handlers.onError({ code: status.CANCELLED, details: 'client closed', metadata: {} });

    expect(service.sendResultToClient).toHaveBeenNthCalledWith(1, [], 7, SEARCH_STATE.doing);
    expect(service.sendResultToClient).toHaveBeenNthCalledWith(
      2,
      [],
      7,
      SEARCH_STATE.error,
      'Workspace Agent search failed.',
    );
    expect(service.processMap.has(7)).toBe(false);
  });
});
