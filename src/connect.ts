import type { PluginHost } from '@tyto/plugin-api';

import { createTokenSource } from './auth.js';
import { resolveGoogleConfig, type GoogleConfig } from './config.js';
import { googleOk, type GoogleResult } from './errors.js';
import { createGoogleClient, type GoogleClient, type Transport } from './http.js';

export type ConnectHost = Pick<PluginHost, 'credentials' | 'fetch'>;

export interface Connection {
  readonly config: GoogleConfig;
  readonly client: GoogleClient;
}

/**
 * The section, the service account and a client signed with its token, for one verb call.
 * Resolved on every call, so a key or a section changed between two runs is the next run's.
 */
export async function connect(
  host: ConnectHost,
  section: unknown,
  /** A way out other than `host.fetch` alone: an Apply's, which stops at its budget. */
  through?: Transport,
): Promise<GoogleResult<Connection>> {
  const config = await resolveGoogleConfig(host, section);
  if (!config.ok) return config;
  const transport: Transport = through ?? { fetch: (url, init) => host.fetch(url, init) };
  const tokens = createTokenSource({ transport, account: config.value.account });
  const client = createGoogleClient({
    transport,
    tokens,
    clientEmail: config.value.account.clientEmail,
  });
  return googleOk({ config: config.value, client });
}
