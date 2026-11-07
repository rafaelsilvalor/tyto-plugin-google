/**
 * What can go wrong between this plugin and Google, as data rather than as a throw.
 *
 * Tyto's own rule, held here too: an expected failure is an answer, not an exception. These
 * codes are the plugin's, not Tyto's: a verb reports its failure as `E_RECIPE_VERB` in its own
 * words, and puts the code first in those words (see {@link describeGoogleError}).
 */
export type GoogleErrorCode =
  /** The service account or the `google` section is missing or unusable; no request was made. */
  | 'E_GOOGLE_CONFIG'
  /** Google refused the service account, its token, or its access to a file. */
  | 'E_GOOGLE_AUTH'
  /** Google answered a 3xx. Never followed: the next host may be one the person never allowed. */
  | 'E_GOOGLE_REDIRECT'
  /** Any other answer that is not a 2xx, retries included. */
  | 'E_GOOGLE_HTTP'
  /** Google kept answering "too many requests" past the retry budget. */
  | 'E_GOOGLE_RATE'
  /** The request never got an answer: Tyto refused it, or the network failed. */
  | 'E_GOOGLE_NETWORK'
  /** A 2xx whose body is not the JSON Google promises. */
  | 'E_GOOGLE_RESPONSE';

export interface GoogleError {
  readonly code: GoogleErrorCode;
  readonly message: string;
  /** The HTTP status, when Google answered. */
  readonly status?: number;
  /** The host's own refusal code (`E_PERMISSION`, `E_PLUGIN_FETCH`, `E_CREDENTIAL_MISSING`). */
  readonly hostCode?: string;
}

export type GoogleResult<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: GoogleError };

export function googleOk<T>(value: T): GoogleResult<T> {
  return { ok: true, value };
}

export function googleError<T = never>(
  code: GoogleErrorCode,
  message: string,
  details: { readonly status?: number; readonly hostCode?: string } = {},
): GoogleResult<T> {
  return { ok: false, error: { code, message, ...details } };
}

/** One line for a person, the code first so a bug report carries it. */
export function describeGoogleError(error: GoogleError): string {
  return `${error.code}: ${error.message}`;
}

/**
 * The `code` of a refusal the host threw (`PluginCapabilityError`), or `undefined`.
 *
 * Read structurally rather than with `instanceof`: an isolated plugin's host lives in another
 * module instance, and the class identity does not survive the boundary.
 */
export function hostCodeOf(thrown: unknown): string | undefined {
  if (typeof thrown !== 'object' || thrown === null || !('code' in thrown)) return undefined;
  const code = (thrown as { readonly code: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

export function messageOf(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}

/** What Google's JSON error body says, read as narrowly as the classification needs. */
export interface GoogleErrorBody {
  /** `error.message`, Google's sentence for a person. */
  readonly message?: string;
  /** `error.status`, such as `PERMISSION_DENIED`. */
  readonly status?: string;
  /** Every `error.errors[].reason` and `error.details[].reason`, such as `rateLimitExceeded`. */
  readonly reasons: readonly string[];
}

/** Google's error body, or an empty one when the text is not Google's JSON. */
export function readErrorBody(text: string): GoogleErrorBody {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { reasons: [] };
  }
  const error = recordOf(recordOf(parsed)?.['error']);
  if (error === undefined) return { reasons: [] };
  const reasons = [...listOf(error['errors']), ...listOf(error['details'])]
    .map((item) => recordOf(item)?.['reason'])
    .filter((reason): reason is string => typeof reason === 'string');
  const message = error['message'];
  const status = error['status'];
  return {
    reasons,
    ...(typeof message === 'string' ? { message } : {}),
    ...(typeof status === 'string' ? { status } : {}),
  };
}

/** The Drive answers that mean "later", like a 429, though they come as a 403. */
const RATE_REASONS: ReadonlySet<string> = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

/** Whether a failed answer is Google asking to slow down: a 429, or Drive's rate-limit 403. */
export function isRateLimited(status: number, body: GoogleErrorBody): boolean {
  if (status === 429) return true;
  return status === 403 && body.reasons.some((reason) => RATE_REASONS.has(reason));
}

const SERVICE_DISABLED = /has not been used in project|SERVICE_DISABLED|API .* is disabled/i;
const SCOPE_INSUFFICIENT =
  /ACCESS_TOKEN_SCOPE_INSUFFICIENT|insufficient authentication scopes|insufficientPermissions/i;

/** How much of Google's own words a message quotes. */
const QUOTED_LIMIT = 300;

/**
 * A failed answer (not a 2xx, not a 3xx) in the plugin's words.
 *
 * **The order is load-bearing**, and it is the one Jacurutu's Sheets adapter paid for: a 403
 * whose cause is "the API is not enabled in this Cloud project" can carry a scope signature
 * too, and the same token with the same scopes succeeds once the API is enabled. So
 * service-disabled is tested first, the scope signature second, then a missing file or one not
 * shared with the service account, and a 401 or 403 that matches nothing names no cause rather
 * than borrowing one.
 *
 * `text` is the body as Google sent it; the caller redacts the whole message afterwards.
 */
export function classifyFailure(
  label: string,
  status: number,
  text: string,
  clientEmail: string,
): GoogleError {
  const body = readErrorBody(text);
  const said = quoted(body, text);
  const signatures = [text, ...body.reasons, body.status ?? ''].join('\n');

  if (SERVICE_DISABLED.test(signatures)) {
    return {
      code: 'E_GOOGLE_CONFIG',
      status,
      message:
        `${label} answered ${status}: the API is not enabled in the service account's Cloud ` +
        'project. Enable it in the Google Cloud console (APIs & Services) and run again; no ' +
        `key needs changing. ${said}`.trim(),
    };
  }
  if (SCOPE_INSUFFICIENT.test(signatures)) {
    return {
      code: 'E_GOOGLE_AUTH',
      status,
      message:
        `${label} answered ${status}: the token's scopes do not cover this call. ` +
        `Report it with this message. ${said}`.trim(),
    };
  }
  if (status === 404 || (status === 403 && body.status === 'PERMISSION_DENIED')) {
    return {
      code: status === 404 ? 'E_GOOGLE_HTTP' : 'E_GOOGLE_AUTH',
      status,
      message:
        `${label} answered ${status}: the file does not exist, or is not shared with the ` +
        `service account. Check the id, and share it with ${clientEmail}. ${said}`.trim(),
    };
  }
  if (status === 401 || status === 403) {
    return {
      code: 'E_GOOGLE_AUTH',
      status,
      message:
        `${label} answered ${status}, an authorization failure of unknown cause: no rule ` +
        `matched, so read Google's own words before assuming one. ${said}`.trim(),
    };
  }
  return { code: 'E_GOOGLE_HTTP', status, message: `${label} answered ${status}. ${said}`.trim() };
}

/** Google's own words for a failure, shortened: its `message` when it sent JSON. */
function quoted(body: GoogleErrorBody, text: string): string {
  const words = (body.message ?? text).trim();
  if (words === '') return '';
  const short = words.length > QUOTED_LIMIT ? `${words.slice(0, QUOTED_LIMIT)}…` : words;
  return `Google said: ${short}`;
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
