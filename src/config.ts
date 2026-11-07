import type { PluginHost } from '@tyto/plugin-api';

import { googleError, googleOk, hostCodeOf, messageOf, type GoogleResult } from './errors.js';
import { isPkcs8Pem } from './jwt.js';

/**
 * The one token endpoint a service account's assertion may go to. Pinned rather than read from
 * the key: the key's `token_uri` decides where the signed assertion is sent, and a key edited
 * to name another host would hand that host a token request signed with the account's key.
 */
export const TOKEN_URI = 'https://oauth2.googleapis.com/token';

/** The credential key, and how a person sets it on the command line. */
export const SERVICE_ACCOUNT_CREDENTIAL = 'service-account';
const SERVICE_ACCOUNT_VARIABLE = 'TYTO_PLUGIN_GOOGLE_SERVICE_ACCOUNT';

/** What the plugin keeps of a service account's JSON key. The key never leaves this object. */
export interface ServiceAccount {
  readonly clientEmail: string;
  /** The PKCS#8 PEM, as the JSON key carries it. */
  readonly privateKey: string;
  /** Sent as the assertion's `kid`, so Google picks the right public key at once. */
  readonly privateKeyId?: string;
  readonly tokenUri: string;
}

/** The `google` section of `.tyto/project.json`: what a team's folder works with. */
export interface GoogleSection {
  /** The spreadsheet's id, from an id or its address. */
  readonly spreadsheet?: string;
  /** The Drive folder the Drive verbs stay under, from an id or its address. */
  readonly root?: string;
  /** Per-tab settings, read by the verb that formats a tab. */
  readonly tabs?: Readonly<Record<string, unknown>>;
}

export interface GoogleConfig {
  readonly account: ServiceAccount;
  readonly section: GoogleSection;
}

export type ConfigHost = Pick<PluginHost, 'credentials'>;

const NO_ACCOUNT =
  'No Google service account is stored. Store its whole JSON key as the service-account ' +
  `credential (${SERVICE_ACCOUNT_VARIABLE} on the command line, the keychain in the desktop).`;

/**
 * The section and the service account, or why they cannot be had — before any request.
 *
 * The section is checked first, so a typo in the folder's project costs no secret read.
 */
export async function resolveGoogleConfig(
  host: ConfigHost,
  sectionValue: unknown,
): Promise<GoogleResult<GoogleConfig>> {
  const section = readSection(sectionValue);
  if (!section.ok) return section;

  let stored: unknown;
  try {
    stored = await host.credentials(SERVICE_ACCOUNT_CREDENTIAL);
  } catch (thrown) {
    const hostCode = hostCodeOf(thrown);
    if (hostCode === 'E_CREDENTIAL_MISSING') {
      return googleError('E_GOOGLE_CONFIG', NO_ACCOUNT, { hostCode });
    }
    return googleError(
      'E_GOOGLE_CONFIG',
      `Tyto could not read the service-account credential: ${messageOf(thrown)}`,
      hostCode === undefined ? {} : { hostCode },
    );
  }
  if (typeof stored !== 'string' || stored.trim() === '') {
    return googleError('E_GOOGLE_CONFIG', NO_ACCOUNT, { hostCode: 'E_CREDENTIAL_MISSING' });
  }
  const account = parseServiceAccount(stored);
  if (!account.ok) return account;
  return googleOk({ account: account.value, section: section.value });
}

/**
 * A service account's JSON key, checked, or why it is refused.
 *
 * **No message quotes the text.** It holds the private key, and even `JSON.parse`'s own error
 * names a piece of its input, so a refusal says only which field is wrong.
 */
export function parseServiceAccount(text: string): GoogleResult<ServiceAccount> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return refused('is not JSON. Store the whole key file Google Cloud downloads, from { to }.');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return refused('is not a JSON object.');
  }
  const key = parsed as Readonly<Record<string, unknown>>;
  if (key['type'] !== 'service_account') {
    return refused(
      'is not a service account key (its type is not service_account). An OAuth client or a ' +
        "person's sign-in is not supported.",
    );
  }
  const clientEmail = key['client_email'];
  if (typeof clientEmail !== 'string' || !/^[^\s@]+@[^\s@]+$/.test(clientEmail)) {
    return refused('has no client_email.');
  }
  const privateKey = key['private_key'];
  if (typeof privateKey !== 'string' || !isPkcs8Pem(privateKey)) {
    return refused(
      'has no private_key in PKCS#8 PEM (-----BEGIN PRIVATE KEY-----). Download a new JSON ' +
        'key for the account in Google Cloud.',
    );
  }
  const tokenUri = key['token_uri'] ?? TOKEN_URI;
  if (tokenUri !== TOKEN_URI) {
    return refused(`names a token_uri other than ${TOKEN_URI}, which is the only one used.`);
  }
  const privateKeyId = key['private_key_id'];
  return googleOk({
    clientEmail,
    privateKey,
    tokenUri: TOKEN_URI,
    ...(typeof privateKeyId === 'string' && privateKeyId !== '' ? { privateKeyId } : {}),
  });
}

function refused(why: string): GoogleResult<never> {
  return googleError('E_GOOGLE_CONFIG', `The stored service-account credential ${why}`);
}

/** The `google` section, checked. Absent, it is an empty one: every value is optional. */
export function readSection(value: unknown): GoogleResult<GoogleSection> {
  if (value === undefined || value === null) return googleOk({});
  if (typeof value !== 'object' || Array.isArray(value)) {
    return googleError(
      'E_GOOGLE_CONFIG',
      'The google section of .tyto/project.json is not an object.',
    );
  }
  const record = value as Readonly<Record<string, unknown>>;

  let spreadsheet: string | undefined;
  if (record['spreadsheet'] !== undefined && record['spreadsheet'] !== null) {
    spreadsheet = spreadsheetIdOf(record['spreadsheet']);
    if (spreadsheet === undefined) {
      return googleError(
        'E_GOOGLE_CONFIG',
        'spreadsheet in the google section of .tyto/project.json is neither a spreadsheet id ' +
          'nor its address, such as https://docs.google.com/spreadsheets/d/<id>/edit.',
      );
    }
  }

  let root: string | undefined;
  if (record['root'] !== undefined && record['root'] !== null) {
    root = folderIdOf(record['root']);
    if (root === undefined) {
      return googleError(
        'E_GOOGLE_CONFIG',
        'root in the google section of .tyto/project.json is neither a Drive folder id nor ' +
          'its address, such as https://drive.google.com/drive/folders/<id>.',
      );
    }
  }

  const tabs = record['tabs'];
  if (tabs !== undefined && (typeof tabs !== 'object' || tabs === null || Array.isArray(tabs))) {
    return googleError(
      'E_GOOGLE_CONFIG',
      'tabs in the google section of .tyto/project.json is not an object of tab names.',
    );
  }

  return googleOk({
    ...(spreadsheet === undefined ? {} : { spreadsheet }),
    ...(root === undefined ? {} : { root }),
    ...(tabs === undefined ? {} : { tabs: tabs as Readonly<Record<string, unknown>> }),
  });
}

/** A Drive id: letters, digits, `-` and `_`, long enough not to be a word typed by mistake. */
const DRIVE_ID = /^[A-Za-z0-9_-]{10,}$/;

/** The id of a spreadsheet written as its id or as its address. */
export function spreadsheetIdOf(written: unknown): string | undefined {
  return idOf(written, /^\/spreadsheets\/d\/([A-Za-z0-9_-]+)/, 'docs.google.com');
}

/** The id of a Drive folder written as its id or as its address. */
export function folderIdOf(written: unknown): string | undefined {
  return idOf(written, /\/folders\/([A-Za-z0-9_-]+)/, 'drive.google.com');
}

function idOf(written: unknown, path: RegExp, hostname: string): string | undefined {
  if (typeof written !== 'string') return undefined;
  const trimmed = written.trim();
  if (DRIVE_ID.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hostname !== hostname) return undefined;
  const id = path.exec(url.pathname)?.[1];
  return id !== undefined && DRIVE_ID.test(id) ? id : undefined;
}
