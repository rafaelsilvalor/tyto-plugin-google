import type { PluginHost } from '@tyto/plugin-api';

import { createTokenSource } from './auth.js';
import { readSection, resolveGoogleConfig, type GoogleSection } from './config.js';
import { googleOk, PERSON, type GoogleResult } from './errors.js';
import { createGoogleClient, type GoogleClient, type Transport } from './http.js';
import { askSignin, createSigninTokens } from './signin.js';

export type ConnectHost = Pick<PluginHost, 'credentials' | 'fetch' | 'signin'>;

export interface Connection {
  readonly section: GoogleSection;
  readonly client: GoogleClient;
}

/**
 * The section and a client for one verb call, acting as whoever this host lets the plugin act
 * as (TYTO-677, TYTO-700):
 *
 * - **A host that answers a token** acts as the signed-in person, always: the desktop's window,
 *   and a terminal (`tyto recipe run`, `tyto mcp`) after `tyto signin google`, which keeps the
 *   sign-in in the system keychain (Tyto ADR 0194). The service account is never read, even
 *   when one is stored.
 * - **A host that answers `E_SIGNIN_UNAVAILABLE`** is a terminal with no system keychain
 *   (headless, CI): only then does the client act as the stored service account.
 * - **Any other refusal** (nobody signed in, a refused or broken sign-in) is
 *   `E_GOOGLE_SIGNIN`, returned as it is: the service account is never a silent second choice
 *   when a sign-in merely failed.
 *
 * `host.signin` is in every `PluginHost`, so the port is told apart by asking it, not by
 * looking for it. Resolved on every call, so a sign-in, a key or a section changed between two
 * runs is the next run's.
 */
export async function connect(
  host: ConnectHost,
  sectionValue: unknown,
  /** A way out other than `host.fetch` alone: an Apply's, which stops at its budget. */
  through?: Transport,
): Promise<GoogleResult<Connection>> {
  // The section first, so a typo in the folder's project costs no sign-in and no secret read.
  const section = readSection(sectionValue);
  if (!section.ok) return section;
  const transport: Transport = through ?? { fetch: (url, init) => host.fetch(url, init) };

  const signedIn = await askSignin(host);
  if (signedIn.ok) {
    const tokens = createSigninTokens(host, signedIn.value);
    const client = createGoogleClient({ transport, tokens, identity: PERSON });
    return googleOk({ section: section.value, client });
  }
  if (signedIn.error.hostCode !== 'E_SIGNIN_UNAVAILABLE') return signedIn;

  const config = await resolveGoogleConfig(host, sectionValue);
  if (!config.ok) return config;
  const { account } = config.value;
  const client = createGoogleClient({
    transport,
    tokens: createTokenSource({ transport, account }),
    identity: { kind: 'service-account', clientEmail: account.clientEmail },
  });
  return googleOk({ section: config.value.section, client });
}

export type PersonHost = Pick<PluginHost, 'fetch' | 'signin'>;

/**
 * A client signed with the signed-in person's token (Tyto ADR 0174), for what is created in the
 * person's Drive: a service account owns no storage there, so these verbs act as the person on
 * every host, and a terminal with no system keychain answers `E_GOOGLE_SIGNIN`. Nobody signed in is
 * `E_GOOGLE_SIGNIN` at the first request, and the token is redacted from every message.
 */
export function connectAsPerson(host: PersonHost, through?: Transport): GoogleClient {
  const transport: Transport = through ?? { fetch: (url, init) => host.fetch(url, init) };
  return createGoogleClient({ transport, tokens: createSigninTokens(host), identity: PERSON });
}
