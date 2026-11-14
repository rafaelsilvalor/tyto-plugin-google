import { describe, expect, it } from 'vitest';

import { SERVICE_ACCOUNT_CREDENTIAL } from '../src/config.js';
import { connect, type ConnectHost } from '../src/connect.js';
import { SIGNIN_ID } from '../src/signin.js';
import { CLIENT_EMAIL, testKey } from './google.js';

/**
 * Who `connect` acts as, decided by the host's answer to `host.signin` alone (TYTO-700): a
 * token is the person, on any host, the window's or the terminal's after `tyto signin google`;
 * `E_SIGNIN_UNAVAILABLE` (a terminal with no system keychain) is the only answer that reads the
 * stored service account; any other refusal is returned as it is, and the service account is
 * never read, even when one is stored. Every token and email is invented.
 */
const SECTION = { spreadsheet: 'sheet0123456789abcdef' };
const PERSON_TOKEN = 'person-token-0700';

/** A refusal as the host throws it: a `PluginCapabilityError`, read by its `code`. */
function refusal(code: string): Error {
  return Object.assign(new Error(`refused: ${code}`), { code });
}

interface SpyHost {
  readonly host: ConnectHost;
  /** Every credential key the plugin asked the host for, in order. */
  readonly credentialsRead: string[];
  readonly signinsAsked: string[];
}

/** A host whose sign-in answers `signin`, with a service account stored unless told not to. */
async function spyHost(
  signin: () => Promise<string>,
  options: { readonly serviceAccount?: boolean } = {},
): Promise<SpyHost> {
  const key = await testKey();
  const credentialsRead: string[] = [];
  const signinsAsked: string[] = [];
  const host = {
    credentials(name: string) {
      credentialsRead.push(name);
      if (options.serviceAccount === false || name !== SERVICE_ACCOUNT_CREDENTIAL) {
        return Promise.reject(refusal('E_CREDENTIAL_MISSING'));
      }
      return Promise.resolve(key.json);
    },
    fetch() {
      return Promise.reject(new Error('connect makes no request'));
    },
    signin: {
      accessToken(id: string) {
        signinsAsked.push(id);
        return signin();
      },
    },
  } as unknown as ConnectHost;
  return { host, credentialsRead, signinsAsked };
}

describe('connect', () => {
  it('acts as the person when the host answers a token, never reading a stored service account', async () => {
    const spy = await spyHost(() => Promise.resolve(PERSON_TOKEN));
    const connected = await connect(spy.host, SECTION);
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    expect(connected.value.client.identity).toEqual({ kind: 'person' });
    expect(connected.value.section).toEqual(SECTION);
    expect(spy.signinsAsked).toEqual([SIGNIN_ID]);
    expect(spy.credentialsRead).toEqual([]);
  });

  it('acts as the service account only when the host says sign-in is unavailable', async () => {
    const spy = await spyHost(() => Promise.reject(refusal('E_SIGNIN_UNAVAILABLE')));
    const connected = await connect(spy.host, SECTION);
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    expect(connected.value.client.identity).toEqual({
      kind: 'service-account',
      clientEmail: CLIENT_EMAIL,
    });
    expect(spy.credentialsRead).toEqual([SERVICE_ACCOUNT_CREDENTIAL]);
  });

  it('says a service account is needed when sign-in is unavailable and none is stored', async () => {
    const spy = await spyHost(() => Promise.reject(refusal('E_SIGNIN_UNAVAILABLE')), {
      serviceAccount: false,
    });
    const connected = await connect(spy.host, SECTION);
    expect(connected.ok ? undefined : connected.error.code).toBe('E_GOOGLE_CONFIG');
  });

  it.each([
    ['nobody is signed in', 'E_SIGNIN_REQUIRED'],
    ['the host refuses for another reason', 'E_PERMISSION'],
  ])(
    'returns the sign-in failure when %s, never reading the stored service account',
    async (_why, hostCode) => {
      const spy = await spyHost(() => Promise.reject(refusal(hostCode)));
      const connected = await connect(spy.host, SECTION);
      expect(connected.ok).toBe(false);
      if (connected.ok) return;
      expect(connected.error.code).toBe('E_GOOGLE_SIGNIN');
      expect(connected.error.hostCode).toBe(hostCode);
      expect(spy.credentialsRead).toEqual([]);
    },
  );

  it('returns a broken sign-in port as a sign-in failure, never reading the service account', async () => {
    const spy = await spyHost(() => Promise.reject(new Error('the wire closed')));
    const connected = await connect(spy.host, SECTION);
    expect(connected.ok ? undefined : connected.error.code).toBe('E_GOOGLE_SIGNIN');
    expect(spy.credentialsRead).toEqual([]);
  });
});
