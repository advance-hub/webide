import { TrackedRangeStickiness } from '@opensumi/ide-editor';

import * as converter from '../../src/common/vscode/converter';
import * as types from '../../src/common/vscode/ext-types';

describe('extension interface converter', () => {
  it('装饰范围的线值与编辑器协议保持一致，并拒绝未知值', () => {
    expect.hasAssertions();
    const pairs = [
      [types.DecorationRangeBehavior.OpenOpen, TrackedRangeStickiness.AlwaysGrowsWhenTypingAtEdges],
      [types.DecorationRangeBehavior.ClosedClosed, TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges],
      [types.DecorationRangeBehavior.OpenClosed, TrackedRangeStickiness.GrowsOnlyWhenTypingBefore],
      [types.DecorationRangeBehavior.ClosedOpen, TrackedRangeStickiness.GrowsOnlyWhenTypingAfter],
    ] as const;
    for (const [input, expected] of pairs) {
      expect(converter.DecorationRangeBehavior.from(input)).toBe(expected);
    }
    expect(converter.DecorationRangeBehavior.from(undefined as any)).toBeUndefined();
    expect(converter.DecorationRangeBehavior.from(99 as any)).toBeUndefined();
  });
  it('can convert diagnostics', () => {
    const msg = 'test';
    const diagnostic = new types.Diagnostic(new types.Range(0, 0, 0, 0), msg);
    diagnostic.code = {
      target: types.Uri.parse('https://github.com'),
      value: 'GitHub',
    };
    const marker = converter.Diagnostic.toMarker(diagnostic);
    expect(marker.message).toEqual(msg);
    expect(marker.codeHref).toBeDefined();
  });
});
