import type { IServerApp, ServerAppContribution } from '../src/types';
import type http from 'http';
import type https from 'https';

type AssertTrue<T extends true> = T;
type IsExactly<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? (<T>() => T extends B ? 1 : 2) extends <T>() => T extends A ? 1 : 2
      ? true
      : false
    : false;

type ContributionApp = Parameters<NonNullable<ServerAppContribution['initialize']>>[0];
type LegacyServer = http.Server | https.Server;

const contributionReceivesLegacyServerApp: AssertTrue<IsExactly<ContributionApp, IServerApp>> = true;
const serverStartInputRemainsCompatible: AssertTrue<IsExactly<Parameters<IServerApp['start']>[0], LegacyServer>> = true;
const legacyServerApp: IServerApp = {
  use: () => undefined,
  start: async () => undefined,
};
const legacyContribution: ServerAppContribution = {
  initialize: () => undefined,
  onStart: () => undefined,
  onStop: () => undefined,
};

describe('core-node public API compatibility', () => {
  it('keeps the legacy server app and lifecycle contribution contracts source compatible', () => {
    expect.assertions(4);
    expect(contributionReceivesLegacyServerApp).toBe(true);
    expect(serverStartInputRemainsCompatible).toBe(true);
    expect(legacyServerApp).not.toHaveProperty('drain');
    expect(legacyContribution.initialize).toBeDefined();
  });
});
