import type { TestRecipeOptions } from '@tyto/plugin-api/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { fakeDrive, INBOX_ID, INBOX_URL, type FakeGoogleDrive } from './drive.js';
import { response } from './host.js';
import {
  fakeGoogle,
  memoryCache,
  SPREADSHEET_URL,
  type FakeGoogle,
  type FakeSpreadsheet,
} from './sheets.js';

/**
 * Who every verb acts as (TYTO-677, TYTO-700, TYTO-701): the signed-in person, on a host that
 * signs in (the desktop, or a terminal after `tyto signin google`), and nobody else. On a host
 * that cannot sign in (a terminal with no system keychain) no verb runs: each fails with
 * `E_GOOGLE_SIGNIN` and makes no request. Every token, id and email is invented.
 */
type InputTable = NonNullable<TestRecipeOptions['input']>;

const PERSON_TOKEN = 'person-token-0677';
const SIGNED_IN = { google: PERSON_TOKEN };
const SIGN_IN_HINT = 'Sign in to Google on the plugins screen';
const NO_KEYCHAIN =
  "This terminal has no system keychain, so it cannot sign in to Google, and Tyto's Google " +
  'verbs act only as a signed-in person.';

const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const each of open.splice(0)) await each.close();
});

const queue = (): FakeSpreadsheet => ({
  version: '3',
  tabs: [
    {
      sheetId: 5,
      title: 'Queue',
      values: [
        ['ID', 'Title'],
        ['EX-1', 'Old title'],
        ['EX-2', 'Same'],
      ],
    },
  ],
});

function table(columns: readonly string[], rows: readonly (readonly string[])[]): InputTable {
  return {
    columns: columns.map((name) => ({ name, type: 'text', origin: 'test' })),
    rows: rows.map((cells, index) => ({
      key: cells[0] ?? `r${index + 1}`,
      values: Object.fromEntries(columns.map((name, at) => [name, cells[at] ?? null])),
      provenance: { source: 'test', id: `r${index + 1}`, fetchedAt: '2026-11-12T00:00:00.000Z' },
    })),
  };
}

const synced = (): InputTable =>
  table(
    ['ID', 'Title'],
    [
      ['EX-1', 'New title'],
      ['EX-2', 'Same'],
    ],
  );

async function sheets(options: Parameters<typeof fakeGoogle>[1] = {}): Promise<FakeGoogle> {
  const google = await fakeGoogle(queue(), {
    section: { spreadsheet: SPREADSHEET_URL },
    capabilities: memoryCache().capabilities,
    ...options,
  });
  open.push(google.plugin);
  return google;
}

async function drive(options: Parameters<typeof fakeDrive>[1] = {}): Promise<FakeGoogleDrive> {
  const opened = await fakeDrive(
    {
      items: [
        {
          id: 'object012345678',
          name: 'object.json',
          mimeType: 'application/json',
          parents: [INBOX_ID],
          content: '{"id":"EX-1"}',
          createdTime: '2026-11-01T00:00:00.000Z',
        },
      ],
    },
    { section: { root: INBOX_URL }, ...options },
  );
  open.push(opened.plugin);
  return opened;
}

/** A read, then a sync planned and applied: what the card's acceptance runs in the window. */
async function readAndSync(google: FakeGoogle) {
  const read = await google.plugin.runRecipe('google.sheet-rows tab=Queue key=ID');
  if (!read.ok) throw new Error(read.error.map((item) => item.message).join('\n'));
  const planned = await google.plugin.runRecipe('google.sheet-sync tab=Queue key=ID', {
    input: synced(),
  });
  if (!planned.ok) throw new Error(planned.error.map((item) => item.message).join('\n'));
  const plan = planned.value.cells.at(-1)?.plan;
  if (plan === undefined) throw new Error(JSON.stringify(planned.value.cells.at(-1)));
  const verb = google.plugin.recipes.verbs.get('google.sheet-sync');
  if (verb?.apply === undefined) throw new Error('google.sheet-sync has no apply');
  const applied = await verb.apply(plan);
  if (!applied.ok) throw new Error(applied.error.map((item) => item.message).join('\n'));
  return {
    rows: read.value.cells.at(-1)?.table?.rows.length,
    applied: applied.value.operations.map(({ status }) => status),
    plan,
  };
}

describe('in the window (a host with a sign-in port)', () => {
  it('reads and syncs a sheet as the signed-in person', async () => {
    const google = await sheets({ signins: SIGNED_IN });
    const answer = await readAndSync(google);
    expect(answer.rows).toBe(2);
    expect(answer.applied).toEqual(['applied']);
    expect(google.sheet.tabs[0]?.values[1]).toEqual(['EX-1', 'New title']);
    expect(new Set(google.bearers)).toEqual(new Set([`Bearer ${PERSON_TOKEN}`]));
    expect(JSON.stringify(answer.plan)).not.toContain(PERSON_TOKEN);
  });

  it('says to sign in on every verb when nobody is signed in', async () => {
    const google = await sheets({ signins: {} });
    const steps: [string, InputTable | undefined][] = [
      ['google.sheet-rows tab=Queue', undefined],
      ['google.sheet-lookup tab=Queue key=ID columns=Title', synced()],
      ['google.sheet-write tab=Queue mode=replace', synced()],
      ['google.sheet-sync tab=Queue key=ID', synced()],
    ];
    const signedOut = await drive({ signins: {} });
    const driveSteps: [FakeGoogleDrive, string, InputTable][] = [
      [signedOut, 'google.drive-list', table(['id'], [])],
      [signedOut, 'google.drive-read file=object012345678', table(['id'], [])],
      [
        signedOut,
        'google.drive-move to=processed',
        table(['id', 'parent_id'], [['object012345678', INBOX_ID]]),
      ],
      [signedOut, 'google.drive-count folder=Folder', table(['Folder'], [[INBOX_ID]])],
    ];
    const runs = [
      ...steps.map(([step, input]) =>
        google.plugin.runRecipe(step, input === undefined ? {} : { input }),
      ),
      ...driveSteps.map(([opened, step, input]) =>
        // The sources take no input; a transform or an action does.
        opened.plugin.runRecipe(
          step,
          step.includes('drive-list') || step.includes('drive-read') ? {} : { input },
        ),
      ),
    ];
    const answers = await Promise.all(runs);
    expect(answers).toHaveLength(8);
    for (const answer of answers) {
      const said = JSON.stringify(answer);
      expect(said).toContain('E_GOOGLE_SIGNIN');
      expect(said).toContain(SIGN_IN_HINT);
    }
    // Not one request reached Google.
    expect(google.bearers).toEqual([]);
    expect(signedOut.calls).toEqual([]);
  });

  it('says to sign in when the person signs out between the plan and Apply', async () => {
    const google = await sheets({ signins: SIGNED_IN });
    const planned = await google.plugin.runRecipe('google.sheet-sync tab=Queue key=ID', {
      input: synced(),
    });
    const plan = planned.ok ? planned.value.cells.at(-1)?.plan : undefined;
    if (plan === undefined) throw new Error('no plan');
    expect(google.plugin.signOut('google')).toBe(true);
    const applied = await google.plugin.recipes.verbs.get('google.sheet-sync')?.apply?.(plan);
    expect(JSON.stringify(applied)).toContain(SIGN_IN_HINT);
    expect(google.sheet.tabs[0]?.values[1]).toEqual(['EX-1', 'Old title']);
  });

  it('tells the person a file is not shared with their account', async () => {
    const google = await sheets({
      signins: SIGNED_IN,
      capabilities: {
        fetch: () =>
          Promise.resolve(
            response(403, {
              error: {
                code: 403,
                message: 'The caller does not have permission',
                status: 'PERMISSION_DENIED',
              },
            }),
          ),
      },
    });
    const said = JSON.stringify(await google.plugin.runRecipe('google.sheet-rows'));
    expect(said).toContain('is not shared with the Google account signed in on the plugins screen');
    expect(said).not.toContain('service account');
  });
});

describe('on a terminal with no keychain (a host without a sign-in port)', () => {
  it('runs no verb: each says the terminal cannot sign in, and nothing reaches Google', async () => {
    const google = await sheets({ keychain: false });
    const steps: [string, InputTable | undefined][] = [
      ['google.sheet-rows tab=Queue', undefined],
      ['google.sheet-lookup tab=Queue key=ID columns=Title', synced()],
      ['google.sheet-write tab=Queue mode=replace', synced()],
      ['google.sheet-sync tab=Queue key=ID', synced()],
    ];
    const terminal = await drive({ keychain: false });
    const driveSteps: [string, InputTable | undefined][] = [
      ['google.drive-list', undefined],
      ['google.drive-read file=object012345678', undefined],
      [
        'google.drive-move to=processed',
        table(['id', 'parent_id'], [['object012345678', INBOX_ID]]),
      ],
      ['google.drive-count folder=Folder', table(['Folder'], [[INBOX_ID]])],
      ['google.drive-folder', table(['name'], [['Clients']])],
      ['google.sheet-create name=name', table(['name'], [['Clients']])],
    ];
    const answers = await Promise.all([
      ...steps.map(([step, input]) =>
        google.plugin.runRecipe(step, input === undefined ? {} : { input }),
      ),
      ...driveSteps.map(([step, input]) =>
        terminal.plugin.runRecipe(step, input === undefined ? {} : { input }),
      ),
    ]);
    expect(answers).toHaveLength(10);
    for (const answer of answers) {
      const said = JSON.stringify(answer);
      expect(said).toContain('E_GOOGLE_SIGNIN');
      expect(said).toContain(NO_KEYCHAIN);
      expect(said).not.toContain(SIGN_IN_HINT);
      expect(said).not.toContain('service account');
    }
    expect(google.bearers).toEqual([]);
    expect(google.calls).toEqual([]);
    expect(terminal.calls).toEqual([]);
  });
});
