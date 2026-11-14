import type { PluginHost } from '@tyto/plugin-api';

import { readSection, type GoogleSection } from './config.js';
import { googleOk, type GoogleResult } from './errors.js';
import { createGoogleClient, type GoogleClient, type Transport } from './http.js';
import { askSignin, createSigninTokens } from './signin.js';

export type ConnectHost = Pick<PluginHost, 'fetch' | 'signin'>;

export interface Connection {
  readonly section: GoogleSection;
  readonly client: GoogleClient;
}

/**
 * The section and a client for one verb call, acting as the signed-in person and as nobody
 * else (TYTO-677, TYTO-700, TYTO-701): the desktop's window, or a terminal (`tyto recipe run`,
 * `tyto mcp`) after `tyto signin google`, which keeps the sign-in in the system keychain (Tyto
 * ADR 0194).
 *
 * Every refusal of the sign-in is `E_GOOGLE_SIGNIN`, returned as it is, with no second choice:
 * nobody signed in, a refused or broken sign-in, and `E_SIGNIN_UNAVAILABLE`, a terminal with no
 * system keychain (headless, CI), which cannot sign in and so cannot run a Google verb. No
 * credential is read and no token is asked of Google by the plugin itself.
 *
 * `host.signin` is in every `PluginHost`, so the port is told apart by asking it, not by
 * looking for it. Resolved on every call, so a sign-in or a section changed between two runs
 * is the next run's.
 */
export async function connect(
  host: ConnectHost,
  sectionValue: unknown,
  /** A way out other than `host.fetch` alone: an Apply's, which stops at its budget. */
  through?: Transport,
): Promise<GoogleResult<Connection>> {
  // The section first, so a typo in the folder's project costs no sign-in.
  const section = readSection(sectionValue);
  if (!section.ok) return section;

  const signedIn = await askSignin(host);
  if (!signedIn.ok) return signedIn;
  const transport: Transport = through ?? { fetch: (url, init) => host.fetch(url, init) };
  const client = createGoogleClient({
    transport,
    tokens: createSigninTokens(host, signedIn.value),
  });
  return googleOk({ section: section.value, client });
}

export type PersonHost = Pick<PluginHost, 'fetch' | 'signin'>;

/**
 * A client signed with the signed-in person's token (Tyto ADR 0174), with no section: what the
 * verbs that create in the person's Drive use. Nobody signed in, or a terminal with no system
 * keychain, is `E_GOOGLE_SIGNIN` at the first request, and the token is redacted from every
 * message.
 */
export function connectAsPerson(host: PersonHost, through?: Transport): GoogleClient {
  const transport: Transport = through ?? { fetch: (url, init) => host.fetch(url, init) };
  return createGoogleClient({ transport, tokens: createSigninTokens(host) });
}
