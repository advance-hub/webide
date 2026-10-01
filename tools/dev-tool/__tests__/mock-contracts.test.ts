import { Uri } from '@opensumi/ide-core-common';
import { MockFsProvider } from '@opensumi/ide-dev-tool/mocks/file-system-provider';
import { MockedMonacoModel } from '@opensumi/ide-dev-tool/mocks/monaco/model';

describe('shared test contracts', () => {
  test('range validity follows line boundaries and cannot split an emoji', () => {
    expect.hasAssertions();
    const model = new MockedMonacoModel('ab\n😀', 'plaintext');
    expect(model.isValidRange({ startLineNumber: 1, startColumn: 1, endLineNumber: 2, endColumn: 3 })).toBe(true);
    expect(model.isValidRange({ startLineNumber: 1, startColumn: 4, endLineNumber: 2, endColumn: 3 })).toBe(false);
    expect(model.isValidRange({ startLineNumber: 2, startColumn: 2, endLineNumber: 2, endColumn: 3 })).toBe(false);
    expect(model.isValidRange({ startLineNumber: 0, startColumn: 1, endLineNumber: 1, endColumn: 1 })).toBe(false);
  });

  test('write-with-stat observes an overridden write and propagates write failures', async () => {
    expect.hasAssertions();
    const provider = new MockFsProvider();
    const file = { uri: 'file:///workspace/example.txt', isDirectory: false, lastModification: 0 };
    const content = new Uint8Array([65]);
    const write = jest.spyOn(provider, 'writeFile').mockResolvedValue(undefined);
    const result = await provider.writeFileWithStat(file, content);
    expect(write).toHaveBeenCalledWith(expect.any(Uri), content, { create: true, overwrite: true });
    expect(write.mock.calls[0][0].toString()).toBe(file.uri);
    expect(result.uri).toBe(file.uri);
    write.mockRejectedValue(new Error('write rejected'));
    await expect(provider.writeFileWithStat(file, content)).rejects.toThrow('write rejected');
  });
});
