import type { HostFetchInit, HostFetchResponse } from '@tyto/plugin-api';
import { beforeAll, describe, expect, it } from 'vitest';

import { createTokenSource, type Entry } from '../src/auth.js';
import { TOKEN_URI } from '../src/config.js';
import { hostResponse } from './host.js';
import {
  CLIENT_EMAIL,
  KEY_ID,
  testClock,
  testKey,
  tokenEndpoint,
  type Request,
  type TestKey,
} from './google.js';

let key: TestKey;
let otherKey: TestKey;

beforeAll(async () => {
  key = await testKey();
  otherKey = await testKey();
});

function setup(answer?: (init: HostFetchInit) => Promise<HostFetchResponse>) {
  const clock = testClock();
  const endpoint = tokenEndpoint(key.publicKey, clock);
  const requests: Request[] = [];
  const held = new Map<string, Entry>();
  const transport = {
    now: clock.now,
    sleep: clock.sleep,
    async fetch(url: string, init: HostFetchInit = {}) {
      requests.push({ url, init });
      return (answer ?? endpoint.answer)(init);
    },
  };
  const tokens = createTokenSource({ transport, account: key.account, held });
  return { clock, endpoint, requests, held, transport, tokens };
}

describe('createTokenSource', () => {
  it('trades an RS256 assertion signed by the key for a token', async () => {
    const { tokens, endpoint, requests, clock } = setup();
    const token = await tokens.token();
    expect(token).toEqual({ ok: true, value: 'ya29.test-token-1' });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(TOKEN_URI);
    expect(requests[0]?.init.method).toBe('POST');
    expect(requests[0]?.init.headers?.['Content-Type']).toBe('application/x-www-form-urlencoded');
    const issuedAt = clock.now() / 1000;
    expect(endpoint.issued[0]).toEqual({
      header: { alg: 'RS256', typ: 'JWT', kid: KEY_ID },
      claims: {
        iss: CLIENT_EMAIL,
        scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive',
        aud: TOKEN_URI,
        iat: issuedAt,
        exp: issuedAt + 3600,
      },
    });
  });

  it('holds the token in memory and renews it 60 s before it expires', async () => {
    const { tokens, requests, clock } = setup();
    await tokens.token();
    // Google granted 3,599 s; at 3,538 s it is still 61 s from expiring.
    clock.advance(3_538_000);
    expect(await tokens.token()).toEqual({ ok: true, value: 'ya29.test-token-1' });
    expect(requests).toHaveLength(1);
    clock.advance(2_000);
    expect(await tokens.token()).toEqual({ ok: true, value: 'ya29.test-token-2' });
    expect(requests).toHaveLength(2);
  });

  it('asks once when two calls need a token at the same time', async () => {
    const { tokens, requests } = setup();
    const [first, second] = await Promise.all([tokens.token(), tokens.token()]);
    expect(first).toEqual(second);
    expect(requests).toHaveLength(1);
  });

  it('shares a held token between two sources of the same account, and not a rotated key', async () => {
    const { tokens, requests, held, transport } = setup();
    await tokens.token();
    const again = createTokenSource({ transport, account: key.account, held });
    expect(await again.token()).toEqual({ ok: true, value: 'ya29.test-token-1' });
    expect(requests).toHaveLength(1);

    const rotated = createTokenSource({ transport, account: otherKey.account, held });
    const refused = await rotated.token();
    expect(requests).toHaveLength(2);
    expect(refused.ok).toBe(false);
  });

  it('asks again after invalidate', async () => {
    const { tokens, requests } = setup();
    await tokens.token();
    tokens.invalidate();
    expect(await tokens.token()).toEqual({ ok: true, value: 'ya29.test-token-2' });
    expect(requests).toHaveLength(2);
  });

  it('reads invalid_grant as a revoked key or a clock off by minutes', async () => {
    const clock = testClock();
    const endpoint = tokenEndpoint(otherKey.publicKey, clock);
    const tokens = createTokenSource({
      transport: {
        now: clock.now,
        sleep: clock.sleep,
        fetch: (_url, init) => endpoint.answer(init ?? {}),
      },
      account: key.account,
      held: new Map(),
    });
    const answer = await tokens.token();
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    expect(answer.error.code).toBe('E_GOOGLE_AUTH');
    expect(answer.error.status).toBe(400);
    expect(answer.error.message).toContain('(invalid_grant)');
    expect(answer.error.message).toContain('clock');
    expect(answer.error.message).toContain('Invalid JWT Signature.');
  });

  it('refuses an assertion from a clock ten minutes off', async () => {
    const clock = testClock();
    const endpoint = tokenEndpoint(key.publicKey, clock);
    const skewed = testClock(clock.now() - 600_000);
    const tokens = createTokenSource({
      transport: {
        now: skewed.now,
        sleep: skewed.sleep,
        fetch: (_url, init) => endpoint.answer(init ?? {}),
      },
      account: key.account,
      held: new Map(),
    });
    const answer = await tokens.token();
    expect(answer.ok ? '' : answer.error.message).toContain('(invalid_grant)');
  });

  it('never quotes the assertion or the key, even when the endpoint echoes them', async () => {
    let assertion = '';
    const { tokens } = setup(async (init) => {
      assertion = new URLSearchParams(String(init.body)).get('assertion') ?? '';
      return hostResponse(400, {
        error: 'invalid_request',
        error_description: `bad assertion ${assertion} for key ${JSON.stringify(key.json)}`,
      });
    });
    const answer = await tokens.token();
    expect(answer.ok).toBe(false);
    if (answer.ok) return;
    const { message } = answer.error;
    expect(assertion.length).toBeGreaterThan(100);
    expect(message).not.toContain(assertion);
    expect(message).not.toContain(assertion.split('.')[2]);
    for (const line of key.account.privateKey.split('\n').filter((part) => part.length >= 16)) {
      expect(message).not.toContain(line);
    }
    expect(message).toContain('[redacted]');
    expect(answer.error.code).toBe('E_GOOGLE_AUTH');
  });

  it('retries a 429 from the token endpoint, and answers a 2xx without a token as such', async () => {
    let calls = 0;
    const { tokens, clock } = setup(async () => {
      calls += 1;
      return calls === 1
        ? hostResponse(429, '', { 'Retry-After': '2' })
        : hostResponse(200, { token_type: 'Bearer' });
    });
    const answer = await tokens.token();
    expect(clock.slept).toEqual([2000]);
    expect(answer.ok ? '' : answer.error.code).toBe('E_GOOGLE_RESPONSE');
  });

  it('refuses a key WebCrypto cannot import, before any request', async () => {
    const { requests, transport } = setup();
    const tokens = createTokenSource({
      transport,
      account: {
        ...key.account,
        privateKey: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----\n',
      },
      held: new Map(),
    });
    const answer = await tokens.token();
    expect(answer.ok ? '' : answer.error.code).toBe('E_GOOGLE_CONFIG');
    expect(requests).toHaveLength(0);
  });
});
