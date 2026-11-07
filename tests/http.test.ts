import type { HostFetchInit, HostFetchResponse } from '@tyto/plugin-api';
import { describe, expect, it } from 'vitest';

import { createGoogleClient, RETRY_BUDGET_MILLISECONDS, type Tokens } from '../src/http.js';
import { hostResponse } from './host.js';
import { CLIENT_EMAIL, testClock, type Request } from './google.js';

const SHEET = 'https://sheets.googleapis.com/v4/spreadsheets/sheet-0123456789/values/A1';
const DRIVE = 'https://www.googleapis.com/drive/v3/files';

/** A token source that hands out `token-1`, then `token-2` after each invalidate. */
function fakeTokens(): Tokens & { readonly handed: string[] } {
  let generation = 1;
  const handed: string[] = [];
  return {
    handed,
    async token() {
      const token = `token-${generation}`;
      handed.push(token);
      return { ok: true, value: token };
    },
    invalidate() {
      generation += 1;
    },
    secrets: () => handed,
  };
}

function setup(
  ...answers: ((init: HostFetchInit) => HostFetchResponse | Promise<HostFetchResponse>)[]
) {
  const clock = testClock();
  const requests: Request[] = [];
  const tokens = fakeTokens();
  const client = createGoogleClient({
    clientEmail: CLIENT_EMAIL,
    tokens,
    transport: {
      now: clock.now,
      sleep: clock.sleep,
      async fetch(url, init = {}) {
        requests.push({ url, init });
        const answer = answers[Math.min(requests.length, answers.length) - 1];
        if (answer === undefined) throw new Error('no answer');
        return answer(init);
      },
    },
  });
  return { client, requests, clock, tokens };
}

const ok =
  (body: unknown = { values: [] }) =>
  () =>
    hostResponse(200, body);
const rate429 =
  (headers: Record<string, string> = {}) =>
  () =>
    hostResponse(429, '', headers);
const driveRate = () =>
  hostResponse(403, {
    error: {
      code: 403,
      message: 'User rate limit exceeded.',
      errors: [{ domain: 'usageLimits', reason: 'userRateLimitExceeded' }],
    },
  });
const offline = () => {
  throw new Error('getaddrinfo ENOTFOUND sheets.googleapis.com');
};

describe('createGoogleClient', () => {
  it('sends the bearer token and the query, and answers the JSON', async () => {
    const { client, requests } = setup(ok({ values: [['a']] }));
    const answer = await client.get(SHEET, {
      valueRenderOption: 'UNFORMATTED_VALUE',
      ranges: ['A', 'B'],
    });
    expect(answer).toEqual({ ok: true, value: { values: [['a']] } });
    expect(requests[0]?.url).toBe(`${SHEET}?valueRenderOption=UNFORMATTED_VALUE&ranges=A&ranges=B`);
    expect(requests[0]?.init.headers?.['Authorization']).toBe('Bearer token-1');
  });

  it('sends a JSON body on a write, and reads an empty answer as null', async () => {
    const { client, requests } = setup(() => hostResponse(200, ''));
    expect(await client.post(SHEET, { a: 1 })).toEqual({ ok: true, value: null });
    expect(requests[0]?.init.body).toBe('{"a":1}');
    expect(requests[0]?.init.headers?.['Content-Type']).toBe('application/json');
  });

  it('waits what Retry-After asks on a 429', async () => {
    const { client, clock } = setup(rate429({ 'Retry-After': '3' }), ok());
    expect((await client.get(SHEET)).ok).toBe(true);
    expect(clock.slept).toEqual([3000]);
  });

  it('waits 10 s on a 429 that says nothing, and answers E_GOOGLE_RATE past the 20 s budget', async () => {
    const { client, clock, requests } = setup(rate429());
    const answer = await client.get(SHEET);
    expect(clock.slept).toEqual([10_000]);
    expect(requests).toHaveLength(2);
    expect(answer.ok ? '' : answer.error.code).toBe('E_GOOGLE_RATE');
    expect(answer.ok ? '' : answer.error.message).toContain('Run again in a minute');
  });

  it('does not sleep through a Retry-After longer than the budget', async () => {
    const { client, clock, requests } = setup(rate429({ 'Retry-After': '30' }));
    const answer = await client.get(SHEET);
    expect(RETRY_BUDGET_MILLISECONDS).toBe(20_000);
    expect(clock.slept).toEqual([]);
    expect(requests).toHaveLength(1);
    expect(answer.ok ? '' : answer.error.code).toBe('E_GOOGLE_RATE');
  });

  it("retries a 429 and Drive's rate-limit 403 on a write too", async () => {
    const { client, requests } = setup(driveRate, rate429({ 'Retry-After': '1' }), ok());
    expect((await client.post(DRIVE, {})).ok).toBe(true);
    expect(requests).toHaveLength(3);
  });

  it('retries a 5xx and a network failure on a read only', async () => {
    const read = setup(() => hostResponse(503, 'unavailable'), ok());
    expect((await read.client.get(SHEET)).ok).toBe(true);
    expect(read.clock.slept).toEqual([10_000]);

    const reread = setup(offline, ok());
    expect((await reread.client.get(SHEET)).ok).toBe(true);
    expect(reread.clock.slept).toEqual([10_000]);

    // The second wait would be 20 s, past the budget the first 10 s left: it answers instead.
    const down = setup(() => hostResponse(503, 'unavailable'));
    const gone = await down.client.get(SHEET);
    expect(down.requests).toHaveLength(2);
    expect(gone.ok ? '' : gone.error.code).toBe('E_GOOGLE_HTTP');

    const written = setup(() => hostResponse(503, 'unavailable'));
    const failed = await written.client.post(SHEET, {});
    expect(written.requests).toHaveLength(1);
    expect(failed.ok ? '' : failed.error.code).toBe('E_GOOGLE_HTTP');

    const sent = setup(offline);
    const lost = await sent.client.put(SHEET, {});
    expect(sent.requests).toHaveLength(1);
    expect(lost.ok ? '' : lost.error.code).toBe('E_GOOGLE_NETWORK');
  });

  it("does not retry Tyto's own refusal", async () => {
    const { client, requests } = setup(() => {
      throw Object.assign(new Error('not allowed'), { code: 'E_PERMISSION' });
    });
    const answer = await client.get(SHEET);
    expect(requests).toHaveLength(1);
    expect(answer.ok ? undefined : answer.error).toMatchObject({
      code: 'E_GOOGLE_NETWORK',
      hostCode: 'E_PERMISSION',
    });
  });

  it('never follows a redirect', async () => {
    const { client, requests } = setup(() =>
      hostResponse(302, '', { Location: 'https://elsewhere.example/' }),
    );
    const answer = await client.get(SHEET);
    expect(requests).toHaveLength(1);
    expect(answer.ok ? '' : answer.error.code).toBe('E_GOOGLE_REDIRECT');
    expect(answer.ok ? '' : answer.error.message).toContain('https://elsewhere.example/');
  });

  it('answers a 2xx that is not JSON as E_GOOGLE_RESPONSE', async () => {
    const { client } = setup(() => hostResponse(200, '<html>sign in</html>'));
    const answer = await client.get(SHEET);
    expect(answer.ok ? '' : answer.error.code).toBe('E_GOOGLE_RESPONSE');
  });

  it('asks for a new token once on a 401, and reports a second one', async () => {
    const unauthorized = () =>
      hostResponse(401, { error: { code: 401, status: 'UNAUTHENTICATED' } });
    const renewed = setup(unauthorized, ok());
    expect((await renewed.client.get(SHEET)).ok).toBe(true);
    expect(renewed.requests.map((request) => request.init.headers?.['Authorization'])).toEqual([
      'Bearer token-1',
      'Bearer token-2',
    ]);

    const refused = setup(unauthorized);
    const answer = await refused.client.get(SHEET);
    expect(refused.requests).toHaveLength(2);
    expect(answer.ok ? '' : answer.error.code).toBe('E_GOOGLE_AUTH');
  });

  it('names the service account when a file is not shared with it', async () => {
    const { client } = setup(() =>
      hostResponse(403, {
        error: {
          code: 403,
          message: 'The caller does not have permission',
          status: 'PERMISSION_DENIED',
        },
      }),
    );
    const answer = await client.get(SHEET);
    expect(answer.ok ? '' : answer.error.code).toBe('E_GOOGLE_AUTH');
    expect(answer.ok ? '' : answer.error.message).toContain(`share it with ${CLIENT_EMAIL}`);
  });

  it('never quotes the token, even when Google echoes it', async () => {
    const { client } = setup(() =>
      hostResponse(400, { error: { code: 400, message: 'Bad header: Bearer token-1' } }),
    );
    const answer = await client.get(SHEET);
    expect(answer.ok ? '' : answer.error.message).not.toContain('token-1');
    expect(answer.ok ? '' : answer.error.message).toContain('Bearer [redacted]');
  });

  it('calls only the Sheets and the Drive API', async () => {
    const { client, requests } = setup(ok());
    for (const address of [
      'https://oauth2.googleapis.com/token',
      'http://sheets.googleapis.com/v4/spreadsheets/x',
      'https://example.com/',
      'not a url',
    ]) {
      const answer = await client.get(address);
      expect(answer.ok ? '' : answer.error.code).toBe('E_GOOGLE_CONFIG');
    }
    expect(requests).toEqual([]);
  });
});
