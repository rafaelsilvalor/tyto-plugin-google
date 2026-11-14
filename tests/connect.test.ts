import { describe, expect, it } from 'vitest';

import { connect, type ConnectHost } from '../src/connect.js';
import { SIGNIN_ID } from '../src/signin.js';

/**
 * Who `connect` acts as (TYTO-701): the signed-in person, on any host that signs in, the
 * window's or a terminal's after `tyto signin google`, and nobody else. Every refusal of the
 * sign-in is `E_GOOGLE_SIGNIN`, `E_SIGNIN_UNAVAILABLE` (a terminal with no system keychain)
 * included: no credential is read and no request is made, so there is no fallback of any kind.
 * Every token is invented.
 */
const SECTION = { spreadsheet: 'sheet0123456789abcdef' };
const PERSON_TOKEN = 'person-token-0701';

const NO_KEYCHAIN =
  "This terminal has no system keychain, so it cannot sign in to Google, and Tyto's Google " +
  'verbs act only as a signed-in person. Run this step in the desktop app, or in a terminal ' +
  'on a machine with a keychain after `tyto signin google`.';

/** A refusal as the host throws it: a `PluginCapabilityError`, read by its `code`. */
function refusal(code: string): Error {
  return Object.assign(new Error(`refused: ${code}`), { code });
}

interface SpyHost {
  readonly host: ConnectHost;
  /** Every credential key the plugin asked the host for, in order: none, ever. */
  readonly credentialsRead: string[];
  /** Every request the plugin made through the host, a token request included. */
  readonly requests: string[];
  readonly signinsAsked: string[];
}

/**
 * A host whose sign-in answers `signin`, which would hand out a stored secret and answer any
 * request: what the plugin asks of either is recorded, so a fallback shows up.
 */
function spyHost(signin: () => Promise<string>): SpyHost {
  const credentialsRead: string[] = [];
  const requests: string[] = [];
  const signinsAsked: string[] = [];
  const host = {
    credentials(name: string) {
      credentialsRead.push(name);
      return Promise.resolve('{"stored":"secret"}');
    },
    fetch(url: string) {
      requests.push(url);
      return Promise.reject(new Error('connect makes no request'));
    },
    signin: {
      accessToken(id: string) {
        signinsAsked.push(id);
        return signin();
      },
    },
  } as unknown as ConnectHost;
  return { host, credentialsRead, requests, signinsAsked };
}

describe('connect', () => {
  it('acts as the signed-in person when the host answers a token', async () => {
    const spy = spyHost(() => Promise.resolve(PERSON_TOKEN));
    const connected = await connect(spy.host, SECTION);
    expect(connected.ok).toBe(true);
    if (!connected.ok) return;
    expect(connected.value.section).toEqual(SECTION);
    expect(spy.signinsAsked).toEqual([SIGNIN_ID]);
    expect(spy.credentialsRead).toEqual([]);
    expect(spy.requests).toEqual([]);
  });

  it('signs its requests with the person token it was handed', async () => {
    const spy = spyHost(() => Promise.resolve(PERSON_TOKEN));
    const sent: string[] = [];
    const connected = await connect(spy.host, SECTION, {
      fetch(_url, init = {}) {
        sent.push(String(init.headers?.['Authorization']));
        // A refusal by Tyto, which is not retried, so the test waits for nothing.
        return Promise.reject(refusal('E_PERMISSION'));
      },
    });
    if (!connected.ok) throw new Error(connected.error.message);
    await connected.value.client.get('https://sheets.googleapis.com/v4/spreadsheets/x');
    expect(sent).toEqual([`Bearer ${PERSON_TOKEN}`]);
    // The token was asked of the host once, to decide; never of Google.
    expect(spy.signinsAsked).toEqual([SIGNIN_ID]);
    expect(spy.credentialsRead).toEqual([]);
  });

  it('fails with E_GOOGLE_SIGNIN on a terminal with no keychain, reading nothing and asking no token', async () => {
    const spy = spyHost(() => Promise.reject(refusal('E_SIGNIN_UNAVAILABLE')));
    const connected = await connect(spy.host, SECTION);
    expect(connected.ok).toBe(false);
    if (connected.ok) return;
    expect(connected.error).toEqual({
      code: 'E_GOOGLE_SIGNIN',
      hostCode: 'E_SIGNIN_UNAVAILABLE',
      message: NO_KEYCHAIN,
    });
    expect(spy.signinsAsked).toEqual([SIGNIN_ID]);
    expect(spy.credentialsRead).toEqual([]);
    expect(spy.requests).toEqual([]);
  });

  it.each([
    ['nobody is signed in', 'E_SIGNIN_REQUIRED', 'Nobody is signed in to Google for this plugin.'],
    [
      'the host refuses for another reason',
      'E_PERMISSION',
      'The Google sign-in could not be read: refused: E_PERMISSION',
    ],
  ])('returns the sign-in failure as it is when %s', async (_why, hostCode, says) => {
    const spy = spyHost(() => Promise.reject(refusal(hostCode)));
    const connected = await connect(spy.host, SECTION);
    expect(connected.ok).toBe(false);
    if (connected.ok) return;
    expect(connected.error.code).toBe('E_GOOGLE_SIGNIN');
    expect(connected.error.hostCode).toBe(hostCode);
    expect(connected.error.message).toContain(says);
    expect(spy.credentialsRead).toEqual([]);
    expect(spy.requests).toEqual([]);
  });

  it('returns a broken sign-in port as a sign-in failure', async () => {
    const spy = spyHost(() => Promise.reject(new Error('the wire closed')));
    const connected = await connect(spy.host, SECTION);
    expect(connected.ok ? undefined : connected.error).toEqual({
      code: 'E_GOOGLE_SIGNIN',
      message: 'The Google sign-in could not be read: the wire closed',
    });
    expect(spy.credentialsRead).toEqual([]);
    expect(spy.requests).toEqual([]);
  });

  it('checks the section before asking for the sign-in', async () => {
    const spy = spyHost(() => Promise.resolve(PERSON_TOKEN));
    const connected = await connect(spy.host, { spreadsheet: 'not an id' });
    expect(connected.ok ? undefined : connected.error.code).toBe('E_GOOGLE_CONFIG');
    expect(spy.signinsAsked).toEqual([]);
  });
});
