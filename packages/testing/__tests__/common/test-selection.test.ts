import { testsInFile } from '../../src/common/test-selection';

const file = 'file:///project/CalculatorTest.java';
const test = (id: string, uri: string | undefined = file) => ({ item: { extId: id, uri } });

describe('current-file test selection', () => {
  it('runs a suite once instead of also launching its methods and nested suites', () => {
    const suite = test('java\0CalculatorTest');
    const all = [
      test('java\0CalculatorTest\0adds'),
      test('java\0CalculatorTest\0Nested\0subtracts'),
      test('java\0CalculatorTest\0Nested'),
      suite,
    ];
    expect(testsInFile(all, file)).toEqual([suite]);
  });

  it('keeps independent tests and controllers, excluding suites belonging to another file', () => {
    const first = test('java\0project\0first');
    const second = test('java\0project\0second');
    const otherController = test('other\0project\0first');
    const all = [test('java\0project', 'file:///project/pom.xml'), first, second, otherController];
    expect(testsInFile(all, file)).toEqual([first, second, otherController]);
  });

  it('respects ID segment boundaries and returns no tests for an unrelated file', () => {
    const suite = test('java\0Test');
    const different = test('java\0TestExtra\0method');
    expect(testsInFile([suite, different, suite], file)).toEqual([suite, different]);
    expect(testsInFile([suite], 'file:///other.java')).toEqual([]);
  });
});
