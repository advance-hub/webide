import { TestId } from './testId';

interface FileTest {
  item: { extId: string; uri?: { toString(): string } };
}

/** A selected suite already includes its descendants in the extension's run request. */
export function testsInFile<T extends FileTest>(all: Iterable<T>, uri: string): T[] {
  const selected = new Map<string, T>();
  for (const test of all) {
    if (test.item.uri?.toString() === uri) {
      selected.set(test.item.extId, test);
    }
  }
  return [...selected.values()].filter((test) => {
    for (const ancestor of TestId.fromString(test.item.extId).idsFromRoot()) {
      const id = ancestor.toString();
      if (id !== test.item.extId && selected.has(id)) {
        return false;
      }
    }
    return true;
  });
}
