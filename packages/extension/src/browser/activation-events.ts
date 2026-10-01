import { IExtension } from '../common';

// Modern VS Code infers activation from contributed commands and views.
// Some marketplace extensions omit activationEvents entirely.
export function getActivationEvents(extension: Pick<IExtension, 'packageJSON'>): string[] {
  const { activationEvents, contributes } = extension.packageJSON;
  const events = new Set(Array.isArray(activationEvents) ? activationEvents : []);
  for (const command of contributes?.commands || []) {
    if (typeof command.command === 'string') {
      events.add(`onCommand:${command.command}`);
    }
  }
  for (const views of Object.values(contributes?.views || {})) {
    if (!Array.isArray(views)) {
      continue;
    }
    for (const view of views) {
      if (typeof view.id === 'string') {
        events.add(`onView:${view.id}`);
      }
    }
  }
  return [...events];
}
