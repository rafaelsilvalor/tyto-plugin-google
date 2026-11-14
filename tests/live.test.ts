import { readFileSync } from 'node:fs';

import type { FetchedResponse, HostFetchInit } from '@tyto/plugin-api';
import { testPlugin, type PluginHarness } from '@tyto/plugin-api/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The plugin against the real Google, read-only, as a person: `google.sheet-rows` on one sheet
 * and `google.drive-list` on one folder, signed with the access token `GOOGLE_LIVE_ACCESS_TOKEN`
 * holds (one of your own sign-in's, with the Drive scope), as every verb acts (TYTO-701).
 * Skipped unless all three variables are set, so CI and every agent skip it; the maintainer
 * runs it with `pnpm test:live`. Nothing is written, nothing is printed but counts, and the
 * asserts read shapes only, so no real name or value enters this repository.
 */
const ACCESS_TOKEN = process.env['GOOGLE_LIVE_ACCESS_TOKEN'];
const SHEET = process.env['GOOGLE_LIVE_SHEET'];
const FOLDER = process.env['GOOGLE_LIVE_FOLDER'];
const configured = [ACCESS_TOKEN, SHEET, FOLDER].every(
  (value) => value !== undefined && value !== '',
);

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
  let plugin: PluginHarness | undefined;

  beforeAll(async () => {
    const loaded = await testPlugin({
      manifest,
      load: () => import(entry),
      signins: { google: ACCESS_TOKEN ?? '' },
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

/**
 * The creating verbs against the real Google, as a person: one folder with
 * `google.drive-folder` and one spreadsheet with `google.sheet-create`, in the folder
 * `GOOGLE_LIVE_PARENT` names, signed with the access token `GOOGLE_LIVE_ACCESS_TOKEN` holds (one
 * of your own sign-in's, with the Drive scope). Skipped unless both are set. Each item is named
 * with the run's time, so a run never meets an earlier one's. **It deletes nothing**: remove the
 * two items by hand afterwards. With `GOOGLE_LIVE_SHARE_EMAIL`, each is shared with that address
 * as a reader, with no email sent.
 */
const PARENT = process.env['GOOGLE_LIVE_PARENT'];
const SHARE_EMAIL = process.env['GOOGLE_LIVE_SHARE_EMAIL'];
const creating = [ACCESS_TOKEN, PARENT].every((value) => value !== undefined && value !== '');

describe.skipIf(!creating)('live Google, creating as a person', () => {
  let plugin: PluginHarness | undefined;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');

  beforeAll(async () => {
    const loaded = await testPlugin({
      manifest,
      load: () => import(entry),
      signins: { google: ACCESS_TOKEN ?? '' },
      section: { root: PARENT },
      fetch: realFetch,
      deadlineMs: 30_000,
    });
    if (!loaded.ok) throw new Error(loaded.error.map((item) => item.code).join(', '));
    plugin = loaded.value;
  });
  afterAll(async () => {
    await plugin?.close();
  });

  for (const verbId of ['google.drive-folder', 'google.sheet-create']) {
    it(`creates one item with ${verbId}, and a second run plans nothing`, async () => {
      const share =
        SHARE_EMAIL === undefined || SHARE_EMAIL === '' ? null : `${SHARE_EMAIL}:reader`;
      const input = {
        columns: [
          { name: 'name', type: 'text' as const, origin: 'live' },
          { name: 'share', type: 'text' as const, origin: 'live' },
        ],
        rows: [
          {
            key: 'r1',
            values: { name: `${stamp} tyto live ${verbId}`, share },
            provenance: { source: 'live', id: 'r1', fetchedAt: new Date().toISOString() },
          },
        ],
      };
      const step = `${verbId} share=share`;
      const planned = await plugin?.runRecipe(step, { input });
      const plan = planned?.ok ? planned.value.cells.at(-1)?.plan : undefined;
      expect(plan?.operations.length).toBe(share === null ? 1 : 2);
      const verb = plugin?.recipes.verbs.get(verbId);
      const applied = plan === undefined ? undefined : await verb?.apply?.(plan);
      expect(applied?.ok ? applied.value.operations.map((each) => each.status) : []).toEqual(
        plan?.operations.map(() => 'applied'),
      );
      const again = await plugin?.runRecipe(step, { input });
      const second = again?.ok ? again.value.cells.at(-1)?.plan : undefined;
      expect(second?.operations.length).toBe(0);
      count(`${verbId} operations applied`, plan?.operations.length ?? 0);
    }, 60_000);
  }
});
