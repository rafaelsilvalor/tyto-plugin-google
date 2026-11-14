import { readFileSync } from 'node:fs';

import type { HostFetchInit, HostFetchResponse, PluginHost } from '@tyto/plugin-api';
import { testPlugin, type PluginHarness } from '@tyto/plugin-api/testing';
import { describe, expect, it } from 'vitest';

import { createGoogleClient } from '../src/http.js';
import { createSigninTokens, SIGNIN_ID } from '../src/signin.js';
import { googleHost, hostResponse } from './host.js';

const manifest = readFileSync(new URL('../tyto-plugin.json', import.meta.url), 'utf8');
const SHEET = 'https://sheets.googleapis.com/v4/spreadsheets/sheet-0123456789';

/**
 * The plugin's side of the isolation protocol with this repository's manifest, holding on to
 * the `PluginHost` it was activated with, so `host.signin` is the one a verb would call:
 * the token crosses the same wire, and a refusal comes back with the code the host gave it.
 */
async function signedIn(
  signins: Readonly<Record<string, string>>,
): Promise<{ readonly harness: PluginHarness; readonly host: PluginHost }> {
  let captured: PluginHost | undefined;
  const loaded = await testPlugin({
    manifest,
    signins,
    load: () =>
      Promise.resolve({
        activate(host: PluginHost) {
          captured = host;
          return { dispose() {} };
        },
      }),
  });
  if (!loaded.ok) throw new Error(loaded.error.map((item) => item.message).join('\n'));
  if (captured === undefined) throw new Error('the plugin was not activated');
  return { harness: loaded.value, host: captured };
}

describe('createSigninTokens', () => {
  it("hands out the signed-in person's token, asked of the host once per source", async () => {
    const { harness, host } = await signedIn({ google: 'person-token-1' });
    let asked = 0;
    const counting: Pick<PluginHost, 'signin'> = {
      signin: {
        accessToken(id) {
          asked += 1;
          return host.signin.accessToken(id);
        },
      },
    };
    const tokens = createSigninTokens(counting);
    expect(await tokens.token()).toEqual({ ok: true, value: 'person-token-1' });
    expect(await tokens.token()).toEqual({ ok: true, value: 'person-token-1' });
    expect(asked).toBe(1);
    expect(tokens.secrets()).toEqual(['person-token-1']);

    tokens.invalidate();
    await tokens.token();
    expect(asked).toBe(2);
    await harness.close();
  });

  it('says to sign in on the plugins screen when nobody is signed in', async () => {
    const { harness, host } = await signedIn({});
    const answer = await createSigninTokens(host).token();
    expect(answer.ok).toBe(false);
    if (!answer.ok) {
      expect(answer.error.code).toBe('E_GOOGLE_SIGNIN');
      expect(answer.error.hostCode).toBe('E_SIGNIN_REQUIRED');
      expect(answer.error.message).toContain('Sign in to Google on the plugins screen');
    }
    await harness.close();
  });

  it('says so when the person signs out between two calls', async () => {
    const { harness, host } = await signedIn({ google: 'person-token-1' });
    expect((await createSigninTokens(host).token()).ok).toBe(true);
    expect(harness.signOut(SIGNIN_ID)).toBe(true);
    const answer = await createSigninTokens(host).token();
    expect(answer.ok ? undefined : answer.error.hostCode).toBe('E_SIGNIN_REQUIRED');
    await harness.close();
  });

  it('says a terminal with no keychain cannot sign in, on a host without the sign-in port', async () => {
    // The in-process host composes no `signinAccessToken`, as a terminal with no keychain does not.
    const { host } = googleHost();
    const answer = await createSigninTokens(host).token();
    expect(answer.ok).toBe(false);
    if (!answer.ok) {
      expect(answer.error.code).toBe('E_GOOGLE_SIGNIN');
      expect(answer.error.hostCode).toBe('E_SIGNIN_UNAVAILABLE');
      expect(answer.error.message).toContain('This terminal cannot sign in to Google');
    }
  });

  it("redacts the person's token, a dropped one too, from every message", async () => {
    let handed = 0;
    const host: Pick<PluginHost, 'signin'> = {
      signin: {
        accessToken: () => {
          handed += 1;
          return Promise.resolve(`person-token-${handed}`);
        },
      },
    };
    const answers: ((init: HostFetchInit) => HostFetchResponse)[] = [
      () => hostResponse(401, ''),
      // Google echoing both tokens, as a proxy or a debugging body might.
      () =>
        hostResponse(404, {
          error: { message: 'No file for person-token-1 nor person-token-2.', status: 'NOT_FOUND' },
        }),
    ];
    const sent: string[] = [];
    const client = createGoogleClient({
      identity: { kind: 'person' },
      tokens: createSigninTokens(host),
      transport: {
        fetch(_url, init = {}) {
          sent.push(String(init.headers?.['Authorization']));
          const answer = answers[sent.length - 1];
          if (answer === undefined) throw new Error('no answer');
          return Promise.resolve(answer(init));
        },
      },
    });
    const answer = await client.get(SHEET);
    expect(sent).toEqual(['Bearer person-token-1', 'Bearer person-token-2']);
    expect(answer.ok).toBe(false);
    if (!answer.ok) {
      expect(answer.error.message).not.toContain('person-token');
      expect(answer.error.message).toContain('[redacted]');
    }
  });
});
