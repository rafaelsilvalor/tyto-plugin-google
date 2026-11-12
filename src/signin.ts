import type { PluginHost } from '@tyto/plugin-api';

import { googleError, googleOk, hostCodeOf, messageOf, type GoogleResult } from './errors.js';
import type { Tokens } from './http.js';

/**
 * The manifest's `signin.google` entry, and the `signin:google` permission paired with it
 * (Tyto ADR 0174). The manifest names no client: the person types one on the plugins screen
 * (Tyto ADR 0192), so no organisation's client is written into this public repository.
 */
export const SIGNIN_ID = 'google';

export type SigninHost = Pick<PluginHost, 'signin'>;

const SIGNED_OUT =
  'Nobody is signed in to Google for this plugin. Sign in to Google on the plugins screen ' +
  "of Tyto's desktop app (set the OAuth client there first if the row asks for one), then " +
  'run again.';

const NO_BROWSER =
  'The command line cannot sign in to Google as a person: it has no window to sign in from. ' +
  'Run this step in the desktop app, after signing in to Google on its plugins screen.';

/**
 * The signed-in person's access token, as {@link Tokens}, so the same client that signs its
 * requests with the service account's token signs them with the person's.
 *
 * The host runs the browser flow and refreshes the token; the plugin never sees the refresh
 * token and never opens a browser (Tyto ADR 0174 decision 6). The token is held for the life
 * of this source only, one verb call, and {@link Tokens.invalidate} drops it, so the next
 * {@link Tokens.token} asks the host again: after a 401 the host may hold a newer one.
 *
 * `first` is a token the caller already asked the host for, to choose who acts: it is held
 * at once rather than asked for twice.
 */
export function createSigninTokens(host: SigninHost, first?: string): Tokens {
  let held: string | undefined = first;
  /** Every token this source handed out, so one dropped by `invalidate` is still redacted. */
  const handedOut = new Set<string>();

  return {
    async token(): Promise<GoogleResult<string>> {
      if (held === undefined) {
        const asked = await askSignin(host);
        if (!asked.ok) return asked;
        held = asked.value;
      }
      handedOut.add(held);
      return googleOk(held);
    },
    invalidate() {
      held = undefined;
    },
    secrets: () => [...handedOut],
  };
}

/**
 * The host's answer, with its refusals turned into a sentence the person can act on. A host
 * without the sign-in port (the CLI) is `E_GOOGLE_SIGNIN` with the host code
 * `E_SIGNIN_UNAVAILABLE`, which `connect` reads as "act as the service account".
 */
export async function askSignin(host: SigninHost): Promise<GoogleResult<string>> {
  try {
    return googleOk(await host.signin.accessToken(SIGNIN_ID));
  } catch (thrown) {
    const hostCode = hostCodeOf(thrown);
    if (hostCode === 'E_SIGNIN_REQUIRED') {
      return googleError('E_GOOGLE_SIGNIN', SIGNED_OUT, { hostCode });
    }
    if (hostCode === 'E_SIGNIN_UNAVAILABLE') {
      return googleError('E_GOOGLE_SIGNIN', NO_BROWSER, { hostCode });
    }
    // A refusal for any other reason, or a broken host: the host's own words, which never
    // carry a token (the wire holds the access token and nothing else, ADR 0174 decision 7).
    return googleError(
      'E_GOOGLE_SIGNIN',
      `The Google sign-in could not be read: ${messageOf(thrown)}`,
      hostCode === undefined ? {} : { hostCode },
    );
  }
}
