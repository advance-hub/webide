import { AINativeSettingSectionsId, CancellationToken, Emitter, IChatProgress } from '@opensumi/ide-core-common';
import { SumiReadableStream } from '@opensumi/ide-utils/stream';

import { AcpChatAgent } from '../../../src/browser/chat/acp-chat-agent';

describe('AcpChatAgent', () => {
  function createAgent({ autoEnd = true } = {}) {
    const output = new SumiReadableStream<IChatProgress>();
    const requestStream = jest.fn(async () => {
      if (autoEnd) {
        queueMicrotask(() => output.end());
      }
      return output;
    });
    const cancelSession = jest.fn(async () => output.end());
    const preferenceGet = jest.fn((id: string, fallback?: unknown) => fallback);
    const agent = Object.create(AcpChatAgent.prototype) as AcpChatAgent;

    Object.defineProperties(agent, {
      aiBackService: {
        value: { requestStream, cancelSession },
      },
      preferenceService: {
        value: { get: preferenceGet },
      },
      applicationService: {
        value: { clientId: 'test-client' },
      },
      chatAgentService: {
        value: { getAgent: jest.fn(() => ({ metadata: { systemPrompt: 'test system prompt' } })) },
      },
      mcpConfigService: {
        value: { getDisabledTools: jest.fn(async () => []) },
      },
      configProvider: {
        value: {
          resolveConfig: jest.fn(async () => ({
            agentId: 'test-agent',
            command: 'test-agent',
            args: [],
            cwd: '/workspace',
          })),
        },
      },
      chatFeatureRegistry: {
        value: { getSlashCommandHandler: jest.fn() },
      },
      monacoCommandRegistry: {
        value: { getActiveCodeEditor: jest.fn() },
      },
      messageService: {
        value: { error: jest.fn() },
      },
      aiReporter: {
        value: { end: jest.fn() },
      },
      logger: {
        value: { log: jest.fn(), error: jest.fn() },
      },
      chatManagerService: {
        value: { getSession: jest.fn() },
      },
    });

    return { agent, preferenceGet, requestStream, cancelSession };
  }

  it('uses stream as the ACP delivery mode when the preference is unset', async () => {
    const { agent, preferenceGet, requestStream } = createAgent();

    await agent.invoke(
      {
        requestId: 'request-1',
        sessionId: 'acp:session-1',
        message: 'hello',
      } as any,
      jest.fn(),
      [{ role: 'user', content: 'hello' }],
      CancellationToken.None,
    );

    expect(preferenceGet).toHaveBeenCalledWith(AINativeSettingSectionsId.AcpDeliveryMode, 'stream');
    expect(requestStream).toHaveBeenCalledWith(
      'hello',
      expect.objectContaining({
        acpDeliveryMode: 'stream',
        sessionId: 'session-1',
      }),
    );
  });

  it('cancels the ACP session explicitly instead of transporting the browser token', async () => {
    const { agent, requestStream, cancelSession } = createAgent({ autoEnd: false });
    const cancellation = new Emitter<void>();
    const token = {
      isCancellationRequested: false,
      onCancellationRequested: cancellation.event,
    } as any;

    const invocation = agent.invoke(
      {
        requestId: 'request-2',
        sessionId: 'acp:session-2',
        message: 'hello',
      } as any,
      jest.fn(),
      [{ role: 'user', content: 'hello' }],
      token,
    );

    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    cancellation.fire();
    await invocation;

    expect(requestStream).toHaveBeenCalledWith('hello', expect.objectContaining({ sessionId: 'session-2' }));
    expect(cancelSession).toHaveBeenCalledWith('session-2');
  });
});
