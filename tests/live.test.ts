import { readFileSync } from 'node:fs';

import type { FetchedResponse, HostFetchInit } from '@tyto/plugin-api';
import { testPlugin, type PluginHarness } from '@tyto/plugin-api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createTokenSource } from '../src/auth.js';
import { parseServiceAccount } from '../src/config.js';

/**
 * The plugin against the real Google, read-only: a token, `google.sheet-rows` on one sheet and
 * `google.drive-list` on one folder. Skipped unless all three variables are set, so CI and
 * every agent skip it; the maintainer runs it with `pnpm test:live` and a service account the
 * sheet and the folder are shared with. Nothing is written, nothing is printed but counts, and
 * the asserts read shapes only, so no real name or value enters this repository.
 */
const SA_FILE = process.env['GOOGLE_LIVE_SA_FILE'];
const SHEET = process.env['GOOGLE_LIVE_SHEET'];
const FOLDER = process.env['GOOGLE_LIVE_FOLDER'];
const configured = [SA_FILE, SHEET, FOLDER].every((value) => value !== undefined && value !== '');

const manifest = readFileSync(new URL('../tyto-plugin.json', import.meta.url), 'utf8');
const entry = new URL('../dist/index.js', import.meta.url).href;

/** The network as the host hands it: redirects not followed, the body as bytes. */
async function realFetch(url: string, init: HostFetchInit): Promise<FetchedResponse> {
  const answer = await fetch(url, {
    method: init.method ?? 'GET',
    redirect: 'manual',
    ...(init.headers === undefined ? {} : { headers: init.headers }),
    ...(init.body === undefined ? {} : { body: init.body }),
  });
  return {
    url,
    status: answer.status,
    statusText: answer.statusText,
    headers: Object.fromEntries(answer.headers),
    body: new Uint8Array(await answer.arrayBuffer()),
  };
}

function count(label: string, value: number): void {
  // Through stdout: the count is the only thing a live run shows.
  process.stdout.write(`live: ${label} ${value}\n`);
}

describe.skipIf(!configured)('live Google, read-only', () => {
  let key = '';
  let plugin: PluginHarness | undefined;

  beforeAll(async () => {
    key = readFileSync(SA_FILE ?? '', 'utf8');
    const loaded = await testPlugin({
      manifest,
      load: () => import(entry),
      secrets: { 'service-account': key },
      section: { spreadsheet: SHEET, root: FOLDER },
      fetch: realFetch,
      deadlineMs: 30_000,
    });
    if (!loaded.ok) throw new Error(loaded.error.map((item) => item.code).join(', '));
    plugin = loaded.value;
  });
  afterAll(async () => {
    await plugin?.close();
  });

  it('buys a token with the service account', async () => {
    const account = parseServiceAccount(key);
    expect(account.ok).toBe(true);
    if (!account.ok) return;
    const tokens = createTokenSource({
      account: account.value,
      transport: {
        fetch: async (url, init) => {
          const fetched = await realFetch(url, init ?? {});
          const text = new TextDecoder().decode(fetched.body);
          return {
            ...fetched,
            ok: fetched.status >= 200 && fetched.status < 300,
            text: async () => text,
            json: async () => JSON.parse(text) as unknown,
          };
        },
      },
    });
    const token = await tokens.token();
    expect(token.ok ? typeof token.value : token.error.code).toBe('string');
  }, 30_000);

  it('reads the sheet with google.sheet-rows', async () => {
    const ran = await plugin?.runRecipe('google.sheet-rows');
    expect(ran?.ok).toBe(true);
    const cell = ran?.ok ? ran.value.cells[0] : undefined;
    expect((cell?.diagnostics ?? []).filter((each) => each.severity === 'error')).toEqual([]);
    expect(Array.isArray(cell?.table?.columns)).toBe(true);
    count('sheet columns', cell?.table?.columns.length ?? 0);
    count('sheet rows', cell?.table?.rows.length ?? 0);
  }, 60_000);

  it('lists the folder with google.drive-list', async () => {
    const ran = await plugin?.runRecipe('google.drive-list');
    expect(ran?.ok).toBe(true);
    const cell = ran?.ok ? ran.value.cells[0] : undefined;
    expect((cell?.diagnostics ?? []).filter((each) => each.severity === 'error')).toEqual([]);
    expect(cell?.table?.columns.map((each) => each.name)).toEqual([
      'id',
      'name',
      'mime_type',
      'kind',
      'size',
      'created',
      'modified',
      'url',
      'parent_id',
    ]);
    count('folder items', cell?.table?.rows.length ?? 0);
  }, 60_000);
});
