import { TaskDefinitionRegistryImpl } from '../src/task-definition';

describe('extension task definitions', () => {
  it('accepts Maven and Java task definitions without a required list', () => {
    const registry = new TaskDefinitionRegistryImpl();
    registry.register('maven', {
      extensionId: 'vscjava.vscode-maven',
      taskType: 'maven',
      properties: { command: { type: 'string' } },
    });
    const reporter = { error: jest.fn() };
    expect(registry.createTaskIdentifier({ type: 'maven', command: 'verify' }, reporter)).toMatchObject({
      type: 'maven',
      command: 'verify',
    });
    expect(reporter.error).not.toHaveBeenCalled();
  });

  it('accepts a task type with no custom properties', () => {
    const registry = new TaskDefinitionRegistryImpl();
    registry.register('java', { extensionId: 'vscjava.vscode-java-test', taskType: 'java' });
    expect(registry.createTaskIdentifier({ type: 'java' }, { error: jest.fn() })).toMatchObject({ type: 'java' });
  });
});
