import { TOKEN_URI, type ServiceAccount } from './config.js';
import { googleError, googleOk, readErrorBody, type GoogleResult } from './errors.js';
import { redactWith, send, type Tokens, type Transport } from './http.js';
import { importSigningKey, pemBody, pemToDer, signAssertion } from './jwt.js';

/** Every verb reads or writes a spreadsheet or a Drive file, so one token covers both. */
export const SCOPES = [
  'https://www.googleapis.com/auth/spreadsheets',
  'https://www.googleapis.com/auth/drive',
] as const;

/** An assertion asks for a token valid this long, the most Google grants. */
const ASSERTION_LIFETIME_SECONDS = 3600;
/** A held token is renewed this long before it expires, so no call starts on a dying one. */
export const RENEW_BEFORE_MILLISECONDS = 60_000;

const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

interface HeldToken {
  readonly accessToken: string;
  /** Milliseconds since the epoch. */
  readonly expiresAt: number;
}

/** One account's token, or the request for it that is under way. */
export interface Entry {
  /** The key the token was signed for: a rotated key under the same email asks again. */
  readonly privateKey: string;
  token?: HeldToken;
  pending?: Promise<GoogleResult<HeldToken>>;
}

/**
 * The tokens of this process, by service account email. **In module memory only**: never in
 * `host.cache`, never on disk, so a token dies with the plugin's process and no file holds one.
 */
const HELD: Map<string, Entry> = new Map();

export interface TokenSourceOptions {
  readonly transport: Transport;
  readonly account: ServiceAccount;
  /** Where tokens are held; a test passes its own so one test's token is not another's. */
  readonly held?: Map<string, Entry>;
}

/**
 * The service account's access token: held in memory, renewed 60 s before it expires, and
 * otherwise asked for once with an assertion signed by the account's key (RFC 7523). Two calls
 * that need a token at once share one request.
 */
export function createTokenSource(options: TokenSourceOptions): Tokens {
  const { transport, account } = options;
  const held = options.held ?? HELD;
  const now = transport.now ?? Date.now;
  const keyBody = pemBody(account.privateKey);
  // The key's 64-character lines too: a body that quotes the JSON key keeps its "\n" escapes.
  const keyLines = account.privateKey.split(/\r?\n/).filter((line) => line.length >= 16);
  let assertion = '';
  /** Every token this source handed out, so one dropped by `invalidate` is still redacted. */
  const handedOut = new Set<string>();

  const secrets = (): readonly string[] => [
    ...handedOut,
    assertion,
    account.privateKey,
    keyBody,
    ...keyLines,
  ];

  async function requestToken(): Promise<GoogleResult<HeldToken>> {
    const der = pemToDer(account.privateKey);
    if (der === undefined) {
      return googleError(
        'E_GOOGLE_CONFIG',
        "The service account's private_key is not base64 PEM. Download a new JSON key.",
      );
    }
    let key: CryptoKey;
    try {
      key = await importSigningKey(der);
    } catch {
      return googleError(
        'E_GOOGLE_CONFIG',
        "The service account's private_key is not an RSA key WebCrypto can sign with. " +
          'Download a new JSON key.',
      );
    }
    const asked = now();
    const issuedAt = Math.floor(asked / 1000);
    assertion = await signAssertion(
      key,
      {
        iss: account.clientEmail,
        scope: SCOPES.join(' '),
        aud: TOKEN_URI,
        iat: issuedAt,
        exp: issuedAt + ASSERTION_LIFETIME_SECONDS,
      },
      account.privateKeyId,
    );
    const redact = redactWith(secrets());
    const label = 'POST oauth2.googleapis.com/token';
    const answer = await send(
      transport,
      {
        method: 'POST',
        url: TOKEN_URI,
        label,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: `grant_type=${encodeURIComponent(JWT_BEARER)}&assertion=${assertion}`,
      },
      redact,
    );
    if (!answer.ok) return answer;
    const { status, text } = answer.value;

    if (status < 200 || status >= 300) {
      const refusal = tokenRefusal(text);
      const said = refusal.description === '' ? '' : ` Google said: ${refusal.description}`;
      if (refusal.error === 'invalid_grant') {
        return googleError(
          'E_GOOGLE_AUTH',
          redact(
            `Google refused ${account.clientEmail}'s assertion (invalid_grant): the key was ` +
              "revoked or deleted, or this machine's clock is off by minutes. Check the key in " +
              `Google Cloud (IAM, Service accounts, Keys) and the clock.${said}`,
          ),
          { status },
        );
      }
      return googleError(
        status >= 500 ? 'E_GOOGLE_HTTP' : 'E_GOOGLE_AUTH',
        redact(
          `${label} answered ${status}${refusal.error === '' ? '' : ` (${refusal.error})`} ` +
            `for ${account.clientEmail}.${said}`,
        ),
        { status },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text) as unknown;
    } catch {
      return googleError('E_GOOGLE_RESPONSE', `${label} answered ${status} with no JSON.`, {
        status,
      });
    }
    const body = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Readonly<
      Record<string, unknown>
    >;
    const accessToken = body['access_token'];
    const expiresIn = body['expires_in'];
    if (typeof accessToken !== 'string' || accessToken === '') {
      return googleError('E_GOOGLE_RESPONSE', `${label} answered ${status} with no access_token.`, {
        status,
      });
    }
    if (typeof expiresIn !== 'number' || !(expiresIn > 0)) {
      return googleError('E_GOOGLE_RESPONSE', `${label} answered ${status} with no expires_in.`, {
        status,
      });
    }
    // Counted from when the token was asked for, so the network's delay only shortens it.
    return googleOk({ accessToken, expiresAt: asked + expiresIn * 1000 });
  }

  return {
    async token() {
      let entry = held.get(account.clientEmail);
      if (entry === undefined || entry.privateKey !== account.privateKey) {
        entry = { privateKey: account.privateKey };
        held.set(account.clientEmail, entry);
      }
      const current = entry.token;
      if (current !== undefined && now() < current.expiresAt - RENEW_BEFORE_MILLISECONDS) {
        handedOut.add(current.accessToken);
        return googleOk(current.accessToken);
      }
      const owner = entry;
      owner.pending ??= requestToken().then((answer) => {
        delete owner.pending;
        if (answer.ok) owner.token = answer.value;
        else delete owner.token;
        return answer;
      });
      const answer = await owner.pending;
      if (!answer.ok) return answer;
      handedOut.add(answer.value.accessToken);
      return googleOk(answer.value.accessToken);
    },
    invalidate() {
      const entry = held.get(account.clientEmail);
      if (entry !== undefined) delete entry.token;
    },
    secrets,
  };
}

/** `error` and `error_description` of a token endpoint's refusal (RFC 6749 §5.2). */
function tokenRefusal(text: string): { readonly error: string; readonly description: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { error: '', description: text.trim().slice(0, 300) };
  }
  const body = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as Readonly<
    Record<string, unknown>
  >;
  const error = body['error'];
  const description = body['error_description'];
  if (typeof error === 'string') {
    return { error, description: typeof description === 'string' ? description : '' };
  }
  // Not the OAuth shape: Google's API error shape, read the usual way.
  return { error: '', description: readErrorBody(text).message ?? '' };
}
