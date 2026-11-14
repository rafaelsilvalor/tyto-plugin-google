import type { HostFetchInit } from '@tyto/plugin-api';

import type { Transport } from '../src/http.js';

/**
 * What the tests share of Google: a clock the retries advance instead of waiting, and the
 * shape of a request as the fakes record it.
 */

/** A clock that starts at a fixed instant and moves only when the code under test sleeps. */
export interface TestClock extends Required<Pick<Transport, 'now' | 'sleep'>> {
  readonly slept: number[];
  advance(milliseconds: number): void;
}

export function testClock(start: number = Date.UTC(2026, 10, 7, 12)): TestClock {
  let current = start;
  const slept: number[] = [];
  return {
    slept,
    now: () => current,
    sleep: async (milliseconds) => {
      slept.push(milliseconds);
      current += milliseconds;
    },
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
}

export interface Request {
  readonly url: string;
  readonly init: HostFetchInit;
}
