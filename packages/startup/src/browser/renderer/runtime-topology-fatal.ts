import type { RuntimeTopologyHandshakeError, RuntimeTopologyHandshakeStatus } from '../../index';

function appendTextElement(parent: HTMLElement, tagName: string, className: string, text: string): HTMLElement {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = text;
  parent.appendChild(element);
  return element;
}

function appendDiagnosticRow(parent: HTMLElement, label: string, value: string): void {
  appendTextElement(parent, 'dt', 'runtime-topology-fatal__term', label);
  appendTextElement(parent, 'dd', 'runtime-topology-fatal__value', value);
}

function shortDigest(digest: string): string {
  return digest.length > 24 ? `${digest.slice(0, 20)}…${digest.slice(-6)}` : digest;
}

export function renderRuntimeTopologyFatal(
  container: HTMLElement,
  error: RuntimeTopologyHandshakeError,
  status?: RuntimeTopologyHandshakeStatus,
): void {
  const diagnostics = {
    code: error.code,
    correlationId: error.correlationId,
    profileId: status?.profileId,
    enabledOptions: status?.enabledOptions,
    browserContractDigest: status?.localContractDigest,
    state: status?.state,
    message: error.message,
  };

  const page = document.createElement('main');
  page.className = 'runtime-topology-fatal';

  const panel = document.createElement('section');
  panel.className = 'runtime-topology-fatal__panel';
  panel.setAttribute('role', 'alert');
  panel.setAttribute('aria-labelledby', 'runtime-topology-fatal-title');
  panel.tabIndex = -1;
  page.appendChild(panel);

  appendTextElement(panel, 'div', 'runtime-topology-fatal__eyebrow', 'RUNTIME CONNECTION BLOCKED');
  const title = appendTextElement(
    panel,
    'h1',
    'runtime-topology-fatal__title',
    'Frontend and server features are incompatible',
  );
  title.id = 'runtime-topology-fatal-title';
  appendTextElement(
    panel,
    'p',
    'runtime-topology-fatal__summary',
    'OpenSumi closed the connection because the Browser and Node runtime plans do not form one valid product.',
  );

  const details = document.createElement('dl');
  details.className = 'runtime-topology-fatal__details';
  appendDiagnosticRow(details, 'Error', error.code);
  if (status) {
    appendDiagnosticRow(details, 'Profile', status.profileId);
    appendDiagnosticRow(
      details,
      'Options',
      status.enabledOptions.length > 0 ? status.enabledOptions.join(', ') : 'default',
    );
    appendDiagnosticRow(details, 'Browser plan', shortDigest(status.localContractDigest));
  }
  if (error.correlationId) {
    appendDiagnosticRow(details, 'Correlation ID', error.correlationId);
  }
  panel.appendChild(details);

  appendTextElement(
    panel,
    'p',
    'runtime-topology-fatal__guidance',
    'Reload after the deployment has finished. If this remains, copy the diagnostics and send them to the OpenSumi operator.',
  );

  const actions = document.createElement('div');
  actions.className = 'runtime-topology-fatal__actions';
  const reloadButton = appendTextElement(actions, 'button', 'runtime-topology-fatal__button', 'Reload latest version');
  reloadButton.setAttribute('type', 'button');
  reloadButton.addEventListener('click', () => window.location.reload());

  const copyButton = appendTextElement(
    actions,
    'button',
    'runtime-topology-fatal__button runtime-topology-fatal__button--secondary',
    'Copy diagnostics',
  );
  copyButton.setAttribute('type', 'button');
  copyButton.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      copyButton.textContent = 'Copied';
    } catch {
      copyButton.textContent = 'Copy unavailable';
    }
  });
  panel.appendChild(actions);

  container.replaceChildren(page);
  panel.focus();
}
