import { beforeAll, describe, expect, it } from 'vitest';

import {
  TOKEN_URI,
  folderIdOf,
  parseServiceAccount,
  readSection,
  resolveGoogleConfig,
  spreadsheetIdOf,
} from '../src/config.js';
import { googleHost } from './host.js';
import { CLIENT_EMAIL, KEY_ID, testKey, type TestKey } from './google.js';

const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const FOLDER_ID = '0BxExampleFolderId123';

let key: TestKey;

beforeAll(async () => {
  key = await testKey();
});

function withKey(change: (key: Record<string, unknown>) => void): string {
  const parsed = JSON.parse(key.json) as Record<string, unknown>;
  change(parsed);
  return JSON.stringify(parsed);
}

describe('resolveGoogleConfig', () => {
  it('reads the service account from its credential, and the section', async () => {
    const { host } = googleHost({ secrets: { 'service-account': key.json } });
    const config = await resolveGoogleConfig(host, {
      spreadsheet: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0`,
      root: `https://drive.google.com/drive/folders/${FOLDER_ID}?usp=sharing`,
      tabs: { Done: { colour: 'green' } },
    });
    expect(config).toEqual({
      ok: true,
      value: {
        account: {
          clientEmail: CLIENT_EMAIL,
          privateKey: key.account.privateKey,
          privateKeyId: KEY_ID,
          tokenUri: TOKEN_URI,
        },
        section: { spreadsheet: SHEET_ID, root: FOLDER_ID, tabs: { Done: { colour: 'green' } } },
      },
    });
  });

  it('says how to store the key when none is stored', async () => {
    const { host } = googleHost();
    const config = await resolveGoogleConfig(host, undefined);
    expect(config.ok ? undefined : config.error).toMatchObject({
      code: 'E_GOOGLE_CONFIG',
      hostCode: 'E_CREDENTIAL_MISSING',
    });
    expect(config.ok ? '' : config.error.message).toContain('TYTO_PLUGIN_GOOGLE_SERVICE_ACCOUNT');
  });

  it('checks the section before reading the secret', async () => {
    let read = false;
    const config = await resolveGoogleConfig(
      {
        credentials: async () => {
          read = true;
          return key.json;
        },
      } as unknown as Parameters<typeof resolveGoogleConfig>[0],
      { spreadsheet: 'not an id' },
    );
    expect(config.ok ? '' : config.error.code).toBe('E_GOOGLE_CONFIG');
    expect(read).toBe(false);
  });
});

describe('parseServiceAccount', () => {
  it('never quotes the stored text', () => {
    const text = `{"type":"service_account","private_key":"SECRET-MARKER-${'k'.repeat(40)}"`;
    const parsed = parseServiceAccount(text);
    expect(parsed.ok ? '' : parsed.error.message).not.toContain('SECRET-MARKER');
    expect(parsed.ok ? '' : parsed.error.message).toContain('is not JSON');
  });

  it.each([
    [
      'an OAuth client',
      (k: Record<string, unknown>) => (k['type'] = 'authorized_user'),
      'service_account',
    ],
    ['no email', (k: Record<string, unknown>) => delete k['client_email'], 'client_email'],
    [
      'a PKCS#1 key',
      (k: Record<string, unknown>) =>
        (k['private_key'] =
          '-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----\n'),
      'PKCS#8',
    ],
    [
      'another token endpoint',
      (k: Record<string, unknown>) => (k['token_uri'] = 'https://token.example.com/token'),
      'token_uri',
    ],
  ])('refuses %s', (_name, change, says) => {
    const parsed = parseServiceAccount(withKey(change));
    expect(parsed.ok ? undefined : parsed.error.code).toBe('E_GOOGLE_CONFIG');
    expect(parsed.ok ? '' : parsed.error.message).toContain(says);
    expect(parsed.ok ? '' : parsed.error.message).not.toContain('MII');
  });

  it('pins the token endpoint when the key names none', () => {
    const parsed = parseServiceAccount(withKey((k) => delete k['token_uri']));
    expect(parsed.ok ? parsed.value.tokenUri : '').toBe(TOKEN_URI);
  });
});

describe('readSection', () => {
  it('is empty when the folder has no section', () => {
    expect(readSection(undefined)).toEqual({ ok: true, value: {} });
  });

  it.each([
    ['a list', []],
    [
      'a spreadsheet on another host',
      { spreadsheet: `https://example.com/spreadsheets/d/${SHEET_ID}` },
    ],
    ['a root that is a word', { root: 'drive' }],
    ['tabs as a list', { tabs: ['Done'] }],
  ])('refuses %s', (_name, section) => {
    expect(readSection(section).ok).toBe(false);
  });

  it('takes an id as it is', () => {
    expect(spreadsheetIdOf(SHEET_ID)).toBe(SHEET_ID);
    expect(folderIdOf(` ${FOLDER_ID} `)).toBe(FOLDER_ID);
  });
});
