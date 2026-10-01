import type { ProblemMatch, ProblemMatcher } from '@opensumi/ide-core-common';

/** Operations needed by task executors, independent of the matcher implementation. */
export interface IProblemCollector {
  problemMatchers: ProblemMatcher[];
  processLine(line: string): ProblemMatch[];
  isTaskActiveOnStart(): boolean;
  matchBeginMatcher(line: string): boolean;
  matchEndMatcher(line: string): boolean;
}
