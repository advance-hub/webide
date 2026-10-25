import { PreferenceScope } from '@opensumi/ide-core-common';

import { ExtHostPreference } from '../../../../src/hosted/api/vscode/ext.host.preference';

function preference() {
  const service = new ExtHostPreference({ getProxy: () => ({}) } as any, undefined as any);
  service.init({
    [PreferenceScope.Default]: {
      'sample.options': { nested: { value: 1 }, labels: { 'a.b': { value: 2 } } },
      'unrelated.options': { content: '独立配置' },
    },
    [PreferenceScope.User]: {},
    [PreferenceScope.Workspace]: {},
    [PreferenceScope.Folder]: {},
  });
  return service;
}

describe('扩展配置对象的独立快照', () => {
  it('嵌套修改和序列化不改变后续读取或其他配置', () => {
    expect.hasAssertions();
    const service = preference();
    const configuration = service.getConfiguration();
    const value = configuration.get<any>('sample.options');
    value.nested.value = 9;
    expect(JSON.parse(JSON.stringify(value)).nested.value).toBe(9);
    expect(configuration.get<any>('sample.options').nested.value).toBe(1);
    expect(configuration.get<any>('unrelated.options')).toEqual({ content: '独立配置' });
  });

  it('配置更新后既有对象保留旧快照，新读取使用新值', () => {
    expect.hasAssertions();
    const service = preference();
    const before = service.getConfiguration('sample').get<any>('options');
    service.init({
      [PreferenceScope.Default]: { 'sample.options': { nested: { value: 3 } } },
      [PreferenceScope.User]: {},
      [PreferenceScope.Workspace]: {},
      [PreferenceScope.Folder]: {},
    });
    expect(before.nested.value).toBe(1);
    expect(service.getConfiguration('sample').get<any>('options').nested.value).toBe(3);
  });

  it('对象属性名包含点时仍修改正确的副本位置', () => {
    expect.hasAssertions();
    const configuration = preference().getConfiguration();
    const value = configuration.get<any>('sample.options');
    value.labels['a.b'].value = 7;
    expect(JSON.parse(JSON.stringify(value)).labels['a.b'].value).toBe(7);
    expect(configuration.get<any>('sample.options').labels['a.b'].value).toBe(2);
  });
});
