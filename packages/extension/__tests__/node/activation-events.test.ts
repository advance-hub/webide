import { getActivationEvents } from '../../src/browser/activation-events';

describe('inferred extension activation events', () => {
  it('activates a marketplace extension from its contributed view and command', () => {
    const extension = {
      packageJSON: {
        contributes: {
          views: { 'redis-state-explorer': [{ id: 'redis-state-explorer.sidebar' }] },
          commands: [{ command: 'redis-live.addConnection' }],
        },
      },
    } as Parameters<typeof getActivationEvents>[0];

    expect(getActivationEvents(extension)).toEqual([
      'onCommand:redis-live.addConnection',
      'onView:redis-state-explorer.sidebar',
    ]);
  });

  it('retains explicit activation and does not repeat inferred events', () => {
    const extension = {
      packageJSON: {
        activationEvents: ['*', 'onView:connections'],
        contributes: { views: { activitybar: [{ id: 'connections' }] } },
      },
    } as Parameters<typeof getActivationEvents>[0];

    expect(getActivationEvents(extension)).toEqual(['*', 'onView:connections']);
  });
});
