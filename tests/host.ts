import { readFileSync } from 'node:fs';

import {
  createPluginHost,
  type FetchedResponse,
  type HostFetchInit,
  type HostFetchResponse,
  type PluginHost,
} from '@tyto/plugin-api';

/**
 * The `PluginHost` Tyto hands this plugin, built in process from the real manifest: the same
 * permission checks (`net:<host>`, `credentials:service-account`) and the same `config` and
 * `credentials` the isolated host gives, over fakes for the network and the secrets.
 *
 * In process rather than through `testPlugin`, so the configuration, the token and the client
 * are tested on their own; the verbs are driven through `testPlugin`.
 */
const manifest = JSON.parse(
  readFileSync(new URL('../tyto-plugin.json', import.meta.url), 'utf8'),
) as unknown;

export interface FakeRequest {
  readonly url: string;
  readonly init: HostFetchInit;
}

export interface HostOptions {
  /** The plugin's settings by its own keys, as `settings.json` resolved them. */
  readonly settings?: Readonly<Record<string, unknown>>;
  readonly secrets?: Readonly<Record<string, string>>;
  readonly fetch?: (url: string, init: HostFetchInit) => Promise<FetchedResponse>;
}

export function googleHost(options: HostOptions = {}): {
  readonly host: PluginHost;
  readonly requests: readonly FakeRequest[];
} {
  const requests: FakeRequest[] = [];
  const container = createPluginHost({
    config: { google: options.settings ?? {} },
    capabilities: {
      async fetch(url, init) {
        requests.push({ url, init });
        if (options.fetch === undefined) throw new Error(`no fake answers ${url}`);
        return options.fetch(url, init);
      },
      credential: async (_plugin, key) => options.secrets?.[key],
      describeCredential: (_plugin, key) => `the test's secret '${key}'`,
    },
  });
  let captured: PluginHost | undefined;
  const activated = container.tryActivate({
    id: 'google',
    manifest,
    activate(host) {
      captured = host;
      return { dispose() {} };
    },
  });
  if (!activated.ok || captured === undefined) throw new Error('the manifest did not activate');
  return { host: captured, requests };
}

/** A response as the host's `fetch` answers it. */
export function response(
  status: number,
  body: unknown = '',
  headers: Readonly<Record<string, string>> = {},
): FetchedResponse {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    url: 'https://sheets.googleapis.com/',
    status,
    statusText: '',
    headers,
    body: new TextEncoder().encode(text),
  };
}

/** A `HostFetchResponse` for a fake `fetch` handed straight to the client. */
export function hostResponse(
  status: number,
  body: unknown = '',
  headers: Readonly<Record<string, string>> = {},
): HostFetchResponse {
  const fetched = response(status, body, headers);
  const text = new TextDecoder().decode(fetched.body);
  return {
    ...fetched,
    ok: status >= 200 && status < 300,
    text: async () => text,
    json: async () => JSON.parse(text) as unknown,
  };
}
