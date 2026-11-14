import type { TestRecipeOptions } from '@tyto/plugin-api/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { fakeDrive, INBOX_ID, INBOX_URL, type FakeGoogleDrive } from './drive.js';
import { CLIENT_EMAIL } from './google.js';
import { response } from './host.js';
import {
  callsTo,
  fakeGoogle,
  memoryCache,
  SPREADSHEET_ID,
  SPREADSHEET_URL,
  type FakeGoogle,
  type FakeSpreadsheet,
} from './sheets.js';

/**
 * Who every existing verb acts as (TYTO-677, TYTO-700): on a host that signs in (the desktop,
 * or a terminal after `tyto signin google`), the signed-in person, never the service account,
 * even when one is stored; on a host that cannot (a terminal with no system keychain), the
 * service account. Every token, id and email is invented.
 */
type InputTable = NonNullable<TestRecipeOptions['input']>;

const PERSON_TOKEN = 'person-token-0677';
const SIGNED_IN = { google: PERSON_TOKEN };
const SIGN_IN_HINT = 'Sign in to Google on the plugins screen';

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
  it('reads and syncs a sheet as the signed-in person, with no service account stored', async () => {
    const google = await sheets({ signins: SIGNED_IN, serviceAccount: false });
    const answer = await readAndSync(google);
    expect(answer.rows).toBe(2);
    expect(answer.applied).toEqual(['applied']);
    expect(google.sheet.tabs[0]?.values[1]).toEqual(['EX-1', 'New title']);
    expect(new Set(google.bearers)).toEqual(new Set([`Bearer ${PERSON_TOKEN}`]));
    expect(google.assertions.count).toBe(0);
    expect(JSON.stringify(answer.plan)).not.toContain(PERSON_TOKEN);
  });

  it('acts as the person even when a service account is stored', async () => {
    const google = await sheets({ signins: SIGNED_IN });
    await readAndSync(google);
    expect(new Set(google.bearers)).toEqual(new Set([`Bearer ${PERSON_TOKEN}`]));
    expect(google.assertions.count).toBe(0);
  });

  it('says to sign in, never falling back to the stored service account, on every verb', async () => {
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
    // Not one request reached Google: no token was bought, no file was read.
    expect(google.bearers).toEqual([]);
    expect(google.assertions.count).toBe(0);
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
    expect(google.assertions.count).toBe(0);
  });

  it("tells the person a file is not shared with their account, never a robot's email", async () => {
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
    expect(said).not.toContain(CLIENT_EMAIL);
    expect(said).not.toContain('service account');
  });
});

describe('on a terminal with no keychain (a host without a sign-in port)', () => {
  it('reads and syncs a sheet as the service account', async () => {
    const google = await sheets();
    const answer = await readAndSync(google);
    expect(answer.applied).toEqual(['applied']);
    expect(google.bearers.length).toBeGreaterThan(0);
    expect(google.bearers.every((each) => each.startsWith('Bearer ya29.test-token-'))).toBe(true);
    // No count of token requests: a token the module already holds for the account is reused.
  });

  it('says a terminal with no keychain needs a service account, never to sign in', async () => {
    const google = await sheets({ serviceAccount: false });
    const said = JSON.stringify(await google.plugin.runRecipe('google.sheet-rows'));
    expect(said).toContain('E_GOOGLE_CONFIG');
    expect(said).toContain('this terminal cannot sign in to Google as a person');
    expect(said).not.toContain(SIGN_IN_HINT);
    expect(google.bearers).toEqual([]);
  });

  it('lists Drive as the service account', async () => {
    const opened = await drive();
    const ran = await opened.plugin.runRecipe('google.drive-list');
    expect(ran.ok && ran.value.cells.at(-1)?.table?.rows.length).toBe(1);
    expect(opened.calls.every((call) => call.authorization.startsWith('Bearer ya29.'))).toBe(true);
  });
});

describe('the sheet cache', () => {
  it("never serves the service account's read of a tab to the person, nor the other way", async () => {
    const cache = memoryCache();
    const robot = await sheets({ capabilities: cache.capabilities });
    expect((await robot.plugin.runRecipe('google.sheet-rows')).ok).toBe(true);
    expect(callsTo(robot, 'values')).toHaveLength(1);

    const person = await sheets({ signins: SIGNED_IN, capabilities: cache.capabilities });
    expect((await person.plugin.runRecipe('google.sheet-rows')).ok).toBe(true);
    // Same Drive version, yet read live: the robot's entry is not the person's.
    expect(callsTo(person, 'values')).toHaveLength(1);
    expect([...cache.entries.keys()].sort()).toEqual([
      `sheet/person/${SPREADSHEET_ID}/5`,
      `sheet/${CLIENT_EMAIL}/${SPREADSHEET_ID}/5`,
    ]);

    // Each one's next run is served from its own entry.
    expect((await person.plugin.runRecipe('google.sheet-rows')).ok).toBe(true);
    expect(callsTo(person, 'values')).toHaveLength(1);
  });
});
