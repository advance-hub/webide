import { OpenSumiApp } from './app';
import { OpenSumiPanel } from './panel';

type DebugToolbarActionType = 'Continue' | 'Step Over' | 'Step Into' | 'Step Out' | 'Restart' | 'Stop';
export class OpenSumiDebugView extends OpenSumiPanel {
  private selector = {
    toolbarClass: "[class*='debug_configuration_toolbar___']",
    actionStartID: "[id='debug.action.start']",
  };

  constructor(app: OpenSumiApp) {
    super(app, 'DEBUG');
  }

  getDebugToolbar() {
    return this.page.locator('[class*="debug_toolbar_wrapper__"]:visible').last();
  }

  async start(): Promise<void> {
    const startIcon = this.app.page
      .locator(`${this.selector.toolbarClass}:visible ${this.selector.actionStartID}`)
      .last();
    await startIcon.click();
  }

  async getToobarAction(action: DebugToolbarActionType) {
    const actionLocator = this.getDebugToolbar().locator(`[class*="debug_action__"][title="${action}"]`).last();
    await actionLocator.waitFor({ state: 'visible' });
    return actionLocator;
  }

  async stop() {
    const toolbar = this.getDebugToolbar();
    const stop = toolbar.locator('[class*="debug_action__"][title="Stop"]').last();
    if (await stop.isVisible().catch(() => false)) {
      await stop.click();
      return;
    }

    // JavaScript Debug Terminal exposes the equivalent cleanup action as
    // “Disattach” while the debugger is paused at a breakpoint.
    const disattach = toolbar.locator('[class*="debug_action__"][title="Disattach"]').last();
    await disattach.waitFor({ state: 'visible' });
    await disattach.click();
  }

  async continue() {
    const action = await this.getToobarAction('Continue');
    await action.click();
  }

  async restart() {
    const action = await this.getToobarAction('Restart');
    await action.click();
  }

  async stepInto() {
    const action = await this.getToobarAction('Step Into');
    await action.click();
  }

  async stepOver() {
    const action = await this.getToobarAction('Step Over');
    await action.click();
  }

  async stepOut() {
    const action = await this.getToobarAction('Step Out');
    await action.click();
  }
}
