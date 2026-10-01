import { Injector } from '@opensumi/di';

import { renderRuntimeTopologyFatal } from '../../entry/web/runtime-topology-fatal';
import { RuntimeTopologyHandshakeError } from '../../src/runtime-topology-handshake';

import type { RuntimeTopologyHandshakeStatus } from '../../src/runtime-topology-handshake';
import type { RuntimePlanDigestV1 } from '@opensumi/ide-core-common';

const fullContractDigest = `v1:sha256:${'a'.repeat(64)}` as RuntimePlanDigestV1;
const serializedContract =
  '{"schemaVersion":1,"runtime":"browser","entries":[{"moduleConstructor":"SensitiveBrowserModule"}]}';

function createStatus(): RuntimeTopologyHandshakeStatus {
  return {
    policy: 'required',
    protocolVersion: 1,
    localRuntime: 'browser',
    profileId: 'opensumi.default',
    enabledOptions: ['ai', 'notebook'],
    localContractDigest: fullContractDigest,
    state: 'rejected',
    attempts: 1,
    verifiedAdmissions: 0,
    unverifiedAdmissions: 0,
    rejectedAdmissions: 1,
    lastRejection: serializedContract,
  };
}

function createError(): RuntimeTopologyHandshakeError {
  return new RuntimeTopologyHandshakeError(
    'HANDSHAKE_DIGEST_MISMATCH',
    `The Browser contract was rejected: ${serializedContract}`,
    'epoch-0123456789abcdef',
  );
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) {
      return;
    }
    await Promise.resolve();
  }
  throw new Error(`Timed out while waiting for ${description}`);
}

function findButton(container: HTMLElement, label: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) => candidate.textContent === label);
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button not found: ${label}`);
  }
  return button;
}

describe('runtime topology fatal UI', () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement('div');
    container.appendChild(document.createElement('span')).textContent = 'stale application';
    document.body.appendChild(container);
  });

  afterEach(() => {
    container.remove();
    jest.restoreAllMocks();
  });

  it('renders a focused alert with bounded visible diagnostics', () => {
    expect.hasAssertions();
    renderRuntimeTopologyFatal(container, createError(), createStatus());

    const alert = container.querySelector('[role="alert"]');
    expect(alert).toBeInstanceOf(HTMLElement);
    expect(alert?.getAttribute('aria-labelledby')).toBe('runtime-topology-fatal-title');
    expect(document.activeElement).toBe(alert);
    expect(container.textContent).toContain('HANDSHAKE_DIGEST_MISMATCH');
    expect(container.textContent).toContain('opensumi.default');
    expect(container.textContent).toContain('ai, notebook');
    expect(container.textContent).toContain(`${fullContractDigest.slice(0, 20)}…${fullContractDigest.slice(-6)}`);
    expect(container.textContent).not.toContain(fullContractDigest);
    expect(container.textContent).not.toContain(serializedContract);
    expect(container.textContent).not.toContain('SensitiveBrowserModule');
    expect(container.textContent).not.toContain('stale application');
  });

  it('keeps reload and copy actions available without JavaScript viewport branching', async () => {
    expect.hasAssertions();
    const originalInnerWidth = Object.getOwnPropertyDescriptor(window, 'innerWidth');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 360 });
    const matchMedia = jest.spyOn(window, 'matchMedia');
    const addEventListener = jest.spyOn(HTMLButtonElement.prototype, 'addEventListener');
    const writeText = jest.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);

    try {
      renderRuntimeTopologyFatal(container, createError(), createStatus());

      const reloadButton = findButton(container, 'Reload latest version');
      const copyButton = findButton(container, 'Copy diagnostics');
      expect(reloadButton.type).toBe('button');
      expect(copyButton.type).toBe('button');
      expect(matchMedia).not.toHaveBeenCalled();
      expect(
        addEventListener.mock.calls.some(
          (call, index) => addEventListener.mock.instances[index] === reloadButton && call[0] === 'click',
        ),
      ).toBe(true);

      copyButton.click();
      await waitFor(() => copyButton.textContent === 'Copied', 'copy confirmation');

      expect(writeText).toHaveBeenCalledTimes(1);
      expect(JSON.parse(writeText.mock.calls[0][0])).toMatchObject({
        code: 'HANDSHAKE_DIGEST_MISMATCH',
        correlationId: 'epoch-0123456789abcdef',
        profileId: 'opensumi.default',
        enabledOptions: ['ai', 'notebook'],
        browserContractDigest: fullContractDigest,
        state: 'rejected',
      });
      expect(copyButton.textContent).toBe('Copied');
    } finally {
      if (originalInnerWidth) {
        Object.defineProperty(window, 'innerWidth', originalInnerWidth);
      }
    }
  });

  it('disposes the partially started app and injector after an initial topology failure', async () => {
    expect.hasAssertions();
    const topologyError = createError();
    const appStart = jest.fn().mockRejectedValue(topologyError);
    const appDispose = jest.fn().mockResolvedValue(undefined);
    const app = { dispose: appDispose, start: appStart };
    jest.doMock('@opensumi/ide-core-browser/bootstrap', () => ({
      ClientApp: jest.fn().mockImplementation(() => app),
    }));
    jest.doMock('@opensumi/ide-core-browser/styles/index.less', () => ({}));
    jest.doMock('../../entry/styles.less', () => ({}));

    const consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    jest.spyOn(console, 'time').mockImplementation(() => undefined);
    jest.spyOn(console, 'timeEnd').mockImplementation(() => undefined);
    const injectorDisposeAll = jest.spyOn(Injector.prototype, 'disposeAll');
    const main = document.getElementById('main');
    if (!main) {
      throw new Error('Jest DOM is missing #main');
    }
    main.replaceChildren();
    const topologyPreflight = {
      channelPath: 'RuntimeTopologyHandshake',
      getStatus: createStatus,
      onFatalError: jest.fn(),
      run: jest.fn(),
    };

    try {
      const { renderApp } = require('../../entry/web/render-app') as typeof import('../../entry/web/render-app');
      await renderApp({ modules: [], runtimeTopologyPreflight: topologyPreflight } as Parameters<typeof renderApp>[0]);

      expect(appStart).toHaveBeenCalledWith(main, 'web');
      expect(appDispose).toHaveBeenCalledTimes(1);
      expect(injectorDisposeAll).toHaveBeenCalledTimes(1);
      expect(appDispose.mock.invocationCallOrder[0]).toBeLessThan(injectorDisposeAll.mock.invocationCallOrder[0]);
      expect(main.querySelector('[role="alert"]')).toBeInstanceOf(HTMLElement);
      expect(consoleError).toHaveBeenCalledWith('OpenSumi runtime topology handshake failed', topologyError);
    } finally {
      main.replaceChildren();
      jest.dontMock('@opensumi/ide-core-browser/bootstrap');
      jest.dontMock('@opensumi/ide-core-browser/styles/index.less');
      jest.dontMock('../../entry/styles.less');
    }
  });
});
