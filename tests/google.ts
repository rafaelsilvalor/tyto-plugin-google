import type { HostFetchInit, HostFetchResponse } from '@tyto/plugin-api';

import { TOKEN_URI, type ServiceAccount } from '../src/config.js';
import type { Transport } from '../src/http.js';
import { hostResponse } from './host.js';

/**
 * A synthetic Google for the tests: a service account whose key pair is generated here, a token
 * endpoint that checks the assertion as Google does, and a clock the retries advance instead of
 * waiting. No key is committed: every run makes its own.
 */

export const CLIENT_EMAIL = 'tyto-test@example-project.iam.gserviceaccount.com';
export const KEY_ID = '0123456789abcdef0123456789abcdef01234567';
export const SCOPE =
  'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive';

const SIGNING = { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' } as const;

export interface TestKey {
  readonly account: ServiceAccount;
  /** The key file as Google Cloud downloads it. */
  readonly json: string;
  readonly publicKey: CryptoKey;
}

export async function testKey(clientEmail: string = CLIENT_EMAIL): Promise<TestKey> {
  const pair = await crypto.subtle.generateKey(
    { ...SIGNING, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ['sign', 'verify'],
  );
  const der = Buffer.from(await crypto.subtle.exportKey('pkcs8', pair.privateKey));
  const lines = der.toString('base64').match(/.{1,64}/g) ?? [];
  const privateKey = `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
  const json = JSON.stringify({
    type: 'service_account',
    project_id: 'example-project',
    private_key_id: KEY_ID,
    private_key: privateKey,
    client_email: clientEmail,
    client_id: '100000000000000000000',
    token_uri: TOKEN_URI,
  });
  return {
    account: { clientEmail, privateKey, privateKeyId: KEY_ID, tokenUri: TOKEN_URI },
    json,
    publicKey: pair.publicKey,
  };
}

/** A clock that starts at a fixed instant and moves only when the code under test sleeps. */
export interface TestClock extends Required<Pick<Transport, 'now' | 'sleep'>> {
  readonly slept: number[];
  advance(milliseconds: number): void;
}

export function testClock(start: number = Date.UTC(2026, 10, 7, 12)): TestClock {
  let current = start;
  const slept: number[] = [];
  return {
    slept,
    now: () => current,
    sleep: async (milliseconds) => {
      slept.push(milliseconds);
      current += milliseconds;
    },
    advance: (milliseconds) => {
      current += milliseconds;
    },
  };
}

export interface Request {
  readonly url: string;
  readonly init: HostFetchInit;
}

export interface TokenEndpoint {
  /** The assertions it accepted, decoded. */
  readonly issued: { readonly header: unknown; readonly claims: Record<string, unknown> }[];
  answer(init: HostFetchInit): Promise<HostFetchResponse>;
}

/**
 * Google's token endpoint, as far as a service account sees it: the form's grant type, the
 * RS256 signature against the account's public key, and the claims, with `iat` within a minute
 * of the clock. Anything wrong is `invalid_grant`, as Google answers it.
 */
export function tokenEndpoint(publicKey: CryptoKey, clock: TestClock): TokenEndpoint {
  const issued: TokenEndpoint['issued'] = [];
  const refuse = (description: string) =>
    hostResponse(400, { error: 'invalid_grant', error_description: description });
  return {
    issued,
    async answer(init) {
      const form = new URLSearchParams(String(init.body ?? ''));
      if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer') {
        return hostResponse(400, { error: 'unsupported_grant_type' });
      }
      const [header, claims, signature] = (form.get('assertion') ?? '').split('.');
      if (header === undefined || claims === undefined || signature === undefined) {
        return refuse('Invalid JWT.');
      }
      const verified = await crypto.subtle.verify(
        SIGNING,
        publicKey,
        Buffer.from(signature, 'base64url'),
        new TextEncoder().encode(`${header}.${claims}`),
      );
      if (!verified) return refuse('Invalid JWT Signature.');
      const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8')) as {
        alg?: unknown;
        typ?: unknown;
      };
      const decoded = JSON.parse(Buffer.from(claims, 'base64url').toString('utf8')) as Record<
        string,
        unknown
      >;
      const seconds = clock.now() / 1000;
      if (decodedHeader.alg !== 'RS256' || decodedHeader.typ !== 'JWT') {
        return refuse('Invalid JWT header.');
      }
      if (decoded['aud'] !== TOKEN_URI || decoded['scope'] !== SCOPE) {
        return refuse('Invalid JWT: aud or scope.');
      }
      const iat = decoded['iat'];
      const exp = decoded['exp'];
      if (typeof iat !== 'number' || typeof exp !== 'number' || exp - iat !== 3600) {
        return refuse('Invalid JWT: iat and exp.');
      }
      if (Math.abs(iat - seconds) > 60 || exp <= seconds) {
        return refuse(
          'Invalid JWT: Token must be a short-lived token and in a reasonable timeframe.',
        );
      }
      issued.push({ header: decodedHeader, claims: decoded });
      return hostResponse(200, {
        access_token: `ya29.test-token-${issued.length}`,
        expires_in: 3599,
        token_type: 'Bearer',
      });
    },
  };
}
