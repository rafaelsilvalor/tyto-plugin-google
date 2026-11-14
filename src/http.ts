import type { HostFetchInit, HostFetchResponse } from '@tyto/plugin-api';

import {
  classifyFailure,
  googleError,
  googleOk,
  hostCodeOf,
  isRateLimited,
  messageOf,
  readErrorBody,
  type GoogleResult,
  type Identity,
} from './errors.js';

/** `host.fetch`, or a test's stand-in for it. */
export type GoogleFetch = (url: string, init?: HostFetchInit) => Promise<HostFetchResponse>;

/** The way out, and the clock the retries are measured with. */
export interface Transport {
  readonly fetch: GoogleFetch;
  /** Waits between retries; a test passes one that advances its own clock instead. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Milliseconds since the epoch; a test passes its own clock. */
  readonly now?: () => number;
}

/**
 * The longest one call spends waiting to retry. The host gives a plugin call 30 s, which
 * Buraqueira's 10, 20 and 40 s waits cannot fit, so a call that is still refused past this
 * budget answers instead of sleeping on (the coordinator's decision of 2026-11-07).
 */
export const RETRY_BUDGET_MILLISECONDS = 20_000;
/** The wait before retry n when Google does not say how long: 10 s, then 20 s. */
const BACKOFF_MILLISECONDS = [10_000, 20_000] as const;

/** The hosts a request of a verb may go to; the token endpoint is the token source's alone. */
const API_HOSTS: ReadonlySet<string> = new Set(['sheets.googleapis.com', 'www.googleapis.com']);

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface Outgoing {
  readonly method: Method;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body?: string;
  /** `GET sheets/values`: what a message names. Never carries a secret. */
  readonly label: string;
}

/** An answer that is not a redirect, with its body read: a 2xx, or a failure to classify. */
export interface Answer {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly text: string;
}

const REDACTED = '[redacted]';

/** Replaces every secret in the text; an empty secret is skipped, never spliced everywhere. */
export function redactWith(secrets: readonly string[]): (text: string) => string {
  return (text) =>
    secrets.reduce(
      (redacted, secret) => (secret === '' ? redacted : redacted.split(secret).join(REDACTED)),
      text,
    );
}

/**
 * One request, retried as Google's answers ask: a 429, and Drive's rate-limit 403, on any
 * method (Google refused it, so nothing was done); a 5xx or a network failure only on a GET,
 * because a write that failed that way may have been done. Each retry waits `Retry-After`, or
 * 10 s then 20 s, and never past {@link RETRY_BUDGET_MILLISECONDS} from the first try.
 *
 * **A redirect is never followed**: it is `E_GOOGLE_REDIRECT`, because the next host may be one
 * the person never allowed. Every message goes through `redact`.
 */
export async function send(
  transport: Transport,
  outgoing: Outgoing,
  redact: (text: string) => string,
): Promise<GoogleResult<Answer>> {
  const sleep = transport.sleep ?? defaultSleep;
  const now = transport.now ?? Date.now;
  const started = now();
  const { label } = outgoing;
  const init: HostFetchInit = {
    method: outgoing.method,
    headers: outgoing.headers,
    ...(outgoing.body === undefined ? {} : { body: outgoing.body }),
  };
  const idempotent = outgoing.method === 'GET';

  for (let retry = 0; ; retry += 1) {
    let response: HostFetchResponse;
    try {
      response = await transport.fetch(outgoing.url, init);
    } catch (thrown) {
      const hostCode = hostCodeOf(thrown);
      const why = `${label} got no answer: ${messageOf(thrown)}`;
      // A refusal by Tyto itself (a permission) will not change on a retry.
      if (idempotent && hostCode === undefined) {
        const wait = waitFor(undefined, retry);
        if (now() - started + wait <= RETRY_BUDGET_MILLISECONDS) {
          await sleep(wait);
          continue;
        }
      }
      return googleError(
        'E_GOOGLE_NETWORK',
        redact(retry === 0 ? why : `${why}, still so after ${retry} retries`),
        hostCode === undefined ? {} : { hostCode },
      );
    }

    const { status, headers } = response;
    if (status >= 300 && status < 400) {
      const location = headerOf(headers, 'location');
      return googleError(
        'E_GOOGLE_REDIRECT',
        redact(
          `${label} answered ${status}${location === undefined ? '' : ` to ${location}`}. ` +
            'A redirect is not followed; report it with this message.',
        ),
        { status },
      );
    }
    const text = await bodyText(response);
    if (status >= 200 && status < 300) return googleOk({ status, headers, text });

    const rate = isRateLimited(status, readErrorBody(text));
    if (!rate && !(idempotent && status >= 500)) return googleOk({ status, headers, text });

    const asked = retryAfter(headerOf(headers, 'retry-after'), now());
    const wait = waitFor(asked, retry);
    if (now() - started + wait <= RETRY_BUDGET_MILLISECONDS) {
      await sleep(wait);
      continue;
    }
    const tried = retry === 0 ? '' : ` after ${retry} ${retry === 1 ? 'retry' : 'retries'}`;
    const budget = RETRY_BUDGET_MILLISECONDS / 1000;
    if (rate) {
      return googleError(
        'E_GOOGLE_RATE',
        redact(
          `${label} answered ${status}: Google asks this account to slow down, still so${tried} ` +
            `within ${budget} s. Run again in a minute.`,
        ),
        { status },
      );
    }
    const failure = classifyFailure(label, status, text, undefined);
    return googleError(
      'E_GOOGLE_HTTP',
      redact(`${failure.message} Still so${tried} within ${budget} s; try again later.`),
      { status },
    );
  }
}

/** `Retry-After` when Google sent one, else the backoff for this retry. */
function waitFor(asked: number | undefined, retry: number): number {
  return asked ?? BACKOFF_MILLISECONDS[Math.min(retry, BACKOFF_MILLISECONDS.length - 1)] ?? 0;
}

/** `Retry-After` in seconds or as a date, in milliseconds; `undefined` when absent or unread. */
function retryAfter(header: string | undefined, now: number): number | undefined {
  if (header === undefined) return undefined;
  const trimmed = header.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/** What the client needs of the token source. */
export interface Tokens {
  token(): Promise<GoogleResult<string>>;
  /** Forgets the token held, so the next {@link Tokens.token} asks Google for a new one. */
  invalidate(): void;
  /** Everything no message may carry: the token, the assertion, the key. */
  secrets(): readonly string[];
}

export type Query = Readonly<Record<string, string | number | boolean | readonly string[]>>;

export interface GoogleClient {
  /** Who the client acts as. Not a secret: a service account's email at most. */
  readonly identity: Identity;
  get(url: string, query?: Query): Promise<GoogleResult<unknown>>;
  /** A GET whose 2xx body is the file itself (Drive's `alt=media`), handed back as text. */
  getText(url: string, query?: Query): Promise<GoogleResult<string>>;
  post(url: string, body: unknown, query?: Query): Promise<GoogleResult<unknown>>;
  put(url: string, body: unknown, query?: Query): Promise<GoogleResult<unknown>>;
  patch(url: string, body: unknown, query?: Query): Promise<GoogleResult<unknown>>;
  delete(url: string, query?: Query): Promise<GoogleResult<unknown>>;
}

export interface GoogleClientOptions {
  readonly transport: Transport;
  readonly tokens: Tokens;
  /** Who the tokens are: a failure names it, and the sheet cache keys its entries by it. */
  readonly identity: Identity;
}

/**
 * A client for the Sheets and Drive APIs, over the host's `fetch`, signed with the token of
 * whoever it acts as: the signed-in person, or a headless terminal's service account. A 401 asks for a new token once and tries again: a token Google dropped
 * before its time is not the person's to fix.
 */
export function createGoogleClient(options: GoogleClientOptions): GoogleClient {
  const { transport, tokens, identity } = options;

  async function request(
    method: Method,
    address: string,
    query: Query | undefined,
    body: unknown,
  ): Promise<GoogleResult<unknown>> {
    const answer = await exchange(method, address, query, body);
    if (!answer.ok) return answer;
    const { status, text, label } = answer.value;
    if (text.trim() === '') return googleOk(null);
    try {
      return googleOk(JSON.parse(text) as unknown);
    } catch {
      return googleError(
        'E_GOOGLE_RESPONSE',
        `${label} answered ${status} with a body that is not JSON.`,
        { status },
      );
    }
  }

  /** One request until a 2xx, with its body as Google sent it; a failure is classified. */
  async function exchange(
    method: Method,
    address: string,
    query: Query | undefined,
    body: unknown,
    accept = 'application/json',
  ): Promise<
    GoogleResult<{ readonly status: number; readonly text: string; readonly label: string }>
  > {
    const url = urlOf(address, query);
    if (!url.ok) return url;
    const label = `${method} ${url.value.host}${url.value.pathname}`;

    for (let attempt = 0; ; attempt += 1) {
      const token = await tokens.token();
      if (!token.ok) return token;
      const redact = redactWith(tokens.secrets());
      const answer = await send(
        transport,
        {
          method,
          url: url.value.href,
          label,
          headers: {
            Accept: accept,
            Authorization: `Bearer ${token.value}`,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        redact,
      );
      if (!answer.ok) return answer;
      const { status, text } = answer.value;
      if (status === 401 && attempt === 0) {
        tokens.invalidate();
        continue;
      }
      if (status < 200 || status >= 300) {
        const failure = classifyFailure(label, status, text, identity);
        return { ok: false, error: { ...failure, message: redact(failure.message) } };
      }
      return googleOk({ status, text, label });
    }
  }

  return {
    identity,
    get: (url, query) => request('GET', url, query, undefined),
    async getText(url, query) {
      const answer = await exchange('GET', url, query, undefined, '*/*');
      return answer.ok ? googleOk(answer.value.text) : answer;
    },
    post: (url, body, query) => request('POST', url, query, body),
    put: (url, body, query) => request('PUT', url, query, body),
    patch: (url, body, query) => request('PATCH', url, query, body),
    delete: (url, query) => request('DELETE', url, query, undefined),
  };
}

/** The address with its query, refusing anything but https on the two API hosts. */
function urlOf(address: string, query: Query | undefined): GoogleResult<URL> {
  let url: URL;
  try {
    url = new URL(address);
  } catch {
    return googleError('E_GOOGLE_CONFIG', `'${address}' is not an address.`);
  }
  if (url.protocol !== 'https:' || !API_HOSTS.has(url.host)) {
    return googleError(
      'E_GOOGLE_CONFIG',
      `'${url.origin}' is not the Sheets or the Drive API; the plugin calls only those.`,
    );
  }
  for (const [name, value] of Object.entries(query ?? {})) {
    if (Array.isArray(value)) for (const item of value) url.searchParams.append(name, item);
    else url.searchParams.set(name, String(value));
  }
  return googleOk(url);
}

function headerOf(headers: Readonly<Record<string, string>>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

/** The body as text, or `''` when it cannot be read. */
async function bodyText(response: HostFetchResponse): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
