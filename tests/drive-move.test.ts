import type { TestRecipeOptions } from '@tyto/plugin-api/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { applyDriveMoves } from '../src/drive-move.js';
import { NOT_REACHED } from '../src/sheet-write-apply.js';
import {
  FOLDER_MIME,
  INBOX_ID,
  fakeDrive,
  inboxFile,
  type FakeDrive,
  type FakeGoogleDrive,
  type FakeItem,
} from './drive.js';
import { testClock, testKey, tokenEndpoint } from './google.js';
import { googleHost, response } from './host.js';

/**
 * `google.drive-move` and `google.drive-count` through `testPlugin`: planned or transformed
 * over an input table by `runRecipe`, and applied as the notebook's Apply does, over a
 * synthetic Drive. Every id and name is invented.
 */
type InputTable = NonNullable<TestRecipeOptions['input']>;

const ROOT_ID = 'root0123456789';
const PROCESSED_ID = 'processed012345';
const OTHER_ID = 'other0123456789';

let open: FakeGoogleDrive | undefined;
async function google(
  drive: FakeDrive,
  section: unknown = { root: ROOT_ID },
): Promise<FakeGoogleDrive> {
  await open?.plugin.close();
  open = await fakeDrive(drive, { section });
  return open;
}
afterEach(async () => {
  await open?.plugin.close();
  open = undefined;
});

const folder = (id: string, name: string, parents: string[]): FakeItem => ({
  id,
  name,
  mimeType: FOLDER_MIME,
  parents,
  createdTime: '2026-11-01T09:00:00.000Z',
});

/** The root, an inbox under it with a `processed` folder, and things outside it. */
function studio(): FakeDrive {
  return {
    items: [
      folder(ROOT_ID, 'Studio', ['top0123456789x']),
      folder(INBOX_ID, 'Inbox', [ROOT_ID]),
      folder(PROCESSED_ID, 'processed', [INBOX_ID]),
      inboxFile('fileA0123456789', 'return-a.json', 5, '[]'),
      inboxFile('fileB0123456789', 'return-b.json', 6, '[]'),
      folder(OTHER_ID, 'Elsewhere', []),
      { ...inboxFile('outside0123456', 'stray.json', 7, '[]'), parents: [OTHER_ID] },
      // Two folders whose parents loop: Drive should never answer this, and the walk ends.
      folder('loopA012345678', 'Loop A', ['loopB012345678']),
      folder('loopB012345678', 'Loop B', ['loopA012345678']),
      { ...inboxFile('looped01234567', 'looped.json', 8, '[]'), parents: ['loopA012345678'] },
    ],
  };
}

function table(
  columns: readonly string[],
  rows: readonly (readonly (string | null)[])[],
): InputTable {
  return {
    columns: columns.map((name) => ({ name, type: 'text', origin: 'test' })),
    rows: rows.map((cells, index) => ({
      key: cells[0] ?? `r${index + 1}`,
      values: Object.fromEntries(columns.map((name, at) => [name, cells[at] ?? null])),
      provenance: { source: 'test', id: `r${index + 1}`, fetchedAt: '2026-11-07T00:00:00.000Z' },
    })),
  };
}

/** A `google.drive-list` table of the inbox, as far as the move reads it. */
const listed = (...ids: string[]): InputTable =>
  table(
    ['id', 'parent_id'],
    ids.map((id) => [id, INBOX_ID]),
  );

async function plan(drive: FakeGoogleDrive, step: string, input: InputTable) {
  const ran = await drive.plugin.runRecipe(step, { input });
  if (!ran.ok) throw new Error(ran.error.map((item) => item.message).join('\n'));
  const cell = ran.value.cells.at(-1);
  return {
    plan: cell?.plan,
    table: cell?.table,
    diagnostics: (cell?.diagnostics ?? []).map(({ code, message }) => ({ code, message })),
  };
}

async function apply(
  drive: FakeGoogleDrive,
  planned: NonNullable<Awaited<ReturnType<typeof plan>>['plan']>,
) {
  const verb = drive.plugin.recipes.verbs.get('google.drive-move');
  if (verb?.apply === undefined) throw new Error('google.drive-move has no apply');
  const applied = await verb.apply(planned);
  if (!applied.ok) throw new Error(applied.error.map((item) => item.message).join('\n'));
  return applied.value.operations.map(({ status, reason }) => ({
    status,
    ...(reason === undefined ? {} : { reason }),
  }));
}

const parentsOf = (drive: FakeGoogleDrive, id: string): string[] | undefined =>
  drive.drive.items.find((item) => item.id === id)?.parents;

describe('google.drive-move', () => {
  it('moves each listed file into the folder named under the folder it was listed in', async () => {
    const drive = await google(studio());
    const answer = await plan(
      drive,
      'google.drive-move to=processed',
      listed('fileA0123456789', 'fileB0123456789'),
    );
    expect(answer.diagnostics).toEqual([]);
    expect(answer.plan?.target).toBe(`Drive folder 'processed' (${PROCESSED_ID})`);
    expect(answer.plan?.operations.map((each) => [each.write, each.rowKey, each.payload])).toEqual([
      ['move', 'fileA0123456789', { f: 'fileA0123456789', from: [INBOX_ID], to: PROCESSED_ID }],
      ['move', 'fileB0123456789', { f: 'fileB0123456789', from: [INBOX_ID], to: PROCESSED_ID }],
    ]);
    // The destination is found by its name, with the query ported from Jacurutu.
    expect(drive.calls.find((call) => call.query['q']?.includes('name ='))?.query['q']).toBe(
      `'${INBOX_ID}' in parents and name = 'processed' and trashed = false`,
    );
    expect(drive.calls.some((call) => call.method === 'PATCH')).toBe(false);

    const applied = await apply(drive, answer.plan!);
    expect(applied).toEqual([{ status: 'applied' }, { status: 'applied' }]);
    const patches = drive.calls.filter((call) => call.method === 'PATCH');
    expect(patches.map((call) => [call.path, call.query])).toEqual([
      [
        '/drive/v3/files/fileA0123456789',
        {
          addParents: PROCESSED_ID,
          removeParents: INBOX_ID,
          supportsAllDrives: 'true',
          fields: 'id, parents',
        },
      ],
      [
        '/drive/v3/files/fileB0123456789',
        {
          addParents: PROCESSED_ID,
          removeParents: INBOX_ID,
          supportsAllDrives: 'true',
          fields: 'id, parents',
        },
      ],
    ]);
    expect(parentsOf(drive, 'fileA0123456789')).toEqual([PROCESSED_ID]);
  });

  it('reads each folder above the files once, however many files share it', async () => {
    const drive = await google(studio());
    await plan(
      drive,
      'google.drive-move to=processed',
      listed('fileA0123456789', 'fileB0123456789'),
    );
    const reads = drive.calls
      .filter((call) => call.method === 'GET' && call.path.startsWith('/drive/v3/files/'))
      .map((call) => call.path.slice('/drive/v3/files/'.length));
    expect(reads.sort()).toEqual(
      ['fileA0123456789', 'fileB0123456789', INBOX_ID, PROCESSED_ID].sort(),
    );
  });

  it('refuses to move a file outside the root, or one whose parents loop', async () => {
    const drive = await google(studio());
    const answer = await plan(
      drive,
      'google.drive-move to=processed',
      listed('outside0123456', 'looped01234567', 'fileA0123456789'),
    );
    expect(answer.plan?.operations.map((each) => [each.rowKey, each.payload])).toEqual([
      [
        'outside0123456',
        {
          x: "E_GOOGLE_PLAN: outside0123456: 'stray.json' is not under the root folder: it is not under the root folder",
        },
      ],
      [
        'looped01234567',
        {
          x: "E_GOOGLE_PLAN: looped01234567: 'looped.json' is not under the root folder: its parents loop back to loopA012345678",
        },
      ],
      ['fileA0123456789', { f: 'fileA0123456789', from: [INBOX_ID], to: PROCESSED_ID }],
    ]);
    const applied = await apply(drive, answer.plan!);
    expect(applied.map((each) => each.status)).toEqual(['failed', 'failed', 'applied']);
    expect(parentsOf(drive, 'outside0123456')).toEqual([OTHER_ID]);
  });

  it('refuses a file more than six folders under the root', async () => {
    const chain = Array.from({ length: 6 }, (_, level) =>
      folder(`level${level}012345678`, `L${level}`, [
        level === 0 ? ROOT_ID : `level${level - 1}012345678`,
      ]),
    );
    const drive = studio();
    drive.items.push(
      ...chain,
      { ...inboxFile('deep0123456789', 'deep.json', 9, '[]'), parents: ['level5012345678'] },
      { ...inboxFile('ok0123456789xx', 'ok.json', 9, '[]'), parents: ['level4012345678'] },
    );
    const google_ = await google(drive);
    const answer = await plan(
      google_,
      'google.drive-move to=processed',
      table(['id'], [['deep0123456789'], ['ok0123456789xx']]),
    );
    // Without parent_id the name is looked for under the root, which has no `processed`.
    expect(answer.diagnostics[0]?.message).toMatch(
      /to= names 'processed', and no folder of that name is in root0123456789; creating folders/,
    );
    const byId = await plan(
      google_,
      `google.drive-move to=https://drive.google.com/drive/folders/${PROCESSED_ID}`,
      table(['id'], [['deep0123456789'], ['ok0123456789xx']]),
    );
    expect(byId.plan?.operations.map((each) => each.payload)).toEqual([
      {
        x: "E_GOOGLE_PLAN: deep0123456789: 'deep.json' is not under the root folder: the root is not within 6 folders above it",
      },
      { f: 'ok0123456789xx', from: ['level4012345678'], to: PROCESSED_ID },
    ]);
    // The shallow file first: the folders its walk learnt must not let the deep one through.
    const reversed = await plan(
      google_,
      `google.drive-move to=https://drive.google.com/drive/folders/${PROCESSED_ID}`,
      table(['id'], [['ok0123456789xx'], ['deep0123456789']]),
    );
    expect(reversed.plan?.operations.map((each) => 'x' in (each.payload as object))).toEqual([
      false,
      true,
    ]);
  });

  it('refuses the plan when the destination is missing, outside the root, or a file', async () => {
    const drive = await google(studio());
    const missing = await plan(drive, 'google.drive-move to=archive', listed('fileA0123456789'));
    expect(missing.plan).toBeUndefined();
    expect(missing.diagnostics.map((each) => each.message)).toEqual([
      `'google.drive-move' to= names 'archive', and no folder of that name is in ${INBOX_ID}; ` +
        'creating folders comes in a later version.',
    ]);
    const outside = await plan(
      drive,
      `google.drive-move to=${OTHER_ID}`,
      listed('fileA0123456789'),
    );
    expect(outside.diagnostics.map((each) => each.message)).toEqual([
      `'google.drive-move' to= names 'Elsewhere', which is not under the root folder ${ROOT_ID}: ` +
        'it is not under the root folder.',
    ]);
    const file = await plan(drive, 'google.drive-move to=return-b.json', listed('fileA0123456789'));
    expect(file.diagnostics[0]?.message).toMatch(/no folder of that name is in/);
  });

  it('fails a move whose file changed folders since the plan, and moves the others', async () => {
    const drive = await google(studio());
    const answer = await plan(
      drive,
      'google.drive-move to=processed',
      listed('fileA0123456789', 'fileB0123456789'),
    );
    // Someone moves return-a.json by hand between the plan and Apply.
    const moved = drive.drive.items.find((item) => item.id === 'fileA0123456789');
    if (moved !== undefined) moved.parents = [ROOT_ID];
    const applied = await apply(drive, answer.plan!);
    expect(applied).toEqual([
      {
        status: 'failed',
        reason: `E_GOOGLE_CHANGED: 'return-a.json' is in ${ROOT_ID} now, not in ${INBOX_ID} as planned; run the cell again for a new plan`,
      },
      { status: 'applied' },
    ]);
    expect(parentsOf(drive, 'fileA0123456789')).toEqual([ROOT_ID]);
    expect(drive.calls.filter((call) => call.method === 'PATCH').map((call) => call.path)).toEqual([
      '/drive/v3/files/fileB0123456789',
    ]);
  });

  it('plans nothing for a file already in the destination, and says so', async () => {
    const drive = studio();
    drive.items.push({
      ...inboxFile('done0123456789', 'done.json', 9, '[]'),
      parents: [PROCESSED_ID],
    });
    const google_ = await google(drive);
    const answer = await plan(
      google_,
      'google.drive-move to=processed',
      table(['id', 'parent_id'], [['done0123456789', INBOX_ID]]),
    );
    expect(answer.plan?.operations).toEqual([]);
    expect(answer.diagnostics).toEqual([
      {
        code: 'E_RECIPE_VERB',
        message: "'google.drive-move' plans nothing for 'done.json': already in the destination.",
      },
    ]);
  });

  it('needs root in the section', async () => {
    const drive = await google(studio(), {});
    const answer = await plan(drive, 'google.drive-move to=processed', listed('fileA0123456789'));
    expect(answer.diagnostics.map((each) => each.message)).toEqual([
      "'google.drive-move' needs root in the google section of .tyto/project.json: it moves only files under it.",
    ]);
  });
});

describe('applyDriveMoves budget', () => {
  it('sends no PATCH past its 20 s and answers what it did not reach as skipped', async () => {
    const key = await testKey();
    const clock = testClock(Date.now());
    const endpoint = tokenEndpoint(key.publicKey, clock);
    const { host, requests } = googleHost({
      secrets: { 'service-account': key.json },
      fetch: async (url, init) => {
        if (url.startsWith('https://oauth2.googleapis.com/')) {
          const answer = await endpoint.answer(init);
          return response(answer.status, await answer.text());
        }
        // The first re-read is slow: the budget is gone when it answers.
        clock.advance(21_000);
        return response(200, {
          id: 'fileA0123456789',
          name: 'return-a.json',
          mimeType: 'application/json',
          parents: [INBOX_ID],
        });
      },
    });
    const payload = (f: string) => ({ f, from: [INBOX_ID], to: PROCESSED_ID });
    const answer = await applyDriveMoves(
      host,
      {
        arguments: {},
        target: 'the folder',
        operations: [
          { write: 'move', description: 'a', payload: payload('fileA0123456789') },
          { write: 'move', description: 'b', payload: payload('fileB0123456789') },
          { write: 'move', description: 'c', payload: { x: 'E_GOOGLE_PLAN: planned' } },
        ],
      },
      clock,
    );
    expect(answer.ok && answer.value.operations).toEqual([
      { status: 'skipped', reason: NOT_REACHED },
      { status: 'skipped', reason: NOT_REACHED },
      { status: 'failed', reason: 'E_GOOGLE_PLAN: planned' },
    ]);
    expect(requests.filter((each) => each.init.method === 'PATCH')).toEqual([]);
  });
});

describe('google.drive-count', () => {
  function shoots(): FakeDrive {
    const image = (id: string, parent: string, mimeType: string): FakeItem => ({
      ...inboxFile(id, `${id}.img`, 3, undefined, mimeType),
      parents: [parent],
    });
    return {
      pageSize: 2,
      items: [
        folder('shootA01234567', 'A', [ROOT_ID]),
        folder('shootB01234567', 'B', [ROOT_ID]),
        image('pngA1xxxxxxxxx', 'shootA01234567', 'image/png'),
        image('jpgA2xxxxxxxxx', 'shootA01234567', 'image/jpeg'),
        image('pngA3xxxxxxxxx', 'shootA01234567', 'image/png'),
        image('gifA4xxxxxxxxx', 'shootA01234567', 'image/gif'),
        { ...image('pngA5xxxxxxxxx', 'shootA01234567', 'image/png'), trashed: true },
        folder('workA01234567x', 'work', ['shootA01234567']),
        image('pngW1xxxxxxxxx', 'workA01234567x', 'image/png'),
      ],
    };
  }

  it('adds the PNG and JPEG count of each row folder, subfolders and trash left out', async () => {
    const drive = await google(shoots());
    const answer = await plan(
      drive,
      'google.drive-count folder=Folder',
      table(
        ['Name', 'Folder'],
        [
          ['a', 'https://drive.google.com/drive/folders/shootA01234567'],
          ['b', 'shootB01234567'],
          ['c', null],
          ['a2', 'shootA01234567'],
        ],
      ),
    );
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.columns.map((each) => `${each.name}:${each.type}`)).toEqual([
      'Name:text',
      'Folder:text',
      'Folder_images:number',
    ]);
    expect(answer.table?.rows.map((row) => row.values['Folder_images'])).toEqual([3, 0, null, 3]);
    // One listing per folder and page: the repeated folder is counted once.
    const counts = drive.calls.filter((call) => call.query['q']?.includes("'image/png'"));
    expect(counts.map((call) => call.query['q'])).toEqual([
      "'shootA01234567' in parents and trashed = false and (mimeType = 'image/png' or mimeType = 'image/jpeg')",
      "'shootA01234567' in parents and trashed = false and (mimeType = 'image/png' or mimeType = 'image/jpeg')",
      "'shootB01234567' in parents and trashed = false and (mimeType = 'image/png' or mimeType = 'image/jpeg')",
    ]);
  });

  it('refuses more than 100 folders in one call, before any request', async () => {
    const drive = await google(shoots());
    const rows = Array.from({ length: 101 }, (_, index) => [
      `r${index}`,
      `folder${String(index).padStart(6, '0')}xx`,
    ]);
    const answer = await plan(
      drive,
      'google.drive-count folder=Folder',
      table(['Name', 'Folder'], rows),
    );
    expect(answer.diagnostics).toEqual([
      {
        code: 'E_RECIPE_VERB',
        message:
          "'google.drive-count' would count 101 folders, over the 100 one call counts; narrow it to fewer rows first.",
      },
    ]);
    expect(drive.calls).toEqual([]);
    const hundred = await plan(
      drive,
      'google.drive-count folder=Folder',
      table(['Name', 'Folder'], rows.slice(0, 100)),
    );
    expect(hundred.table?.rows).toHaveLength(100);
  });

  it('refuses a column the table lacks, and a cell that is not a folder', async () => {
    const drive = await google(shoots());
    const missing = await plan(drive, 'google.drive-count folder=Dir', table(['Folder'], [['x']]));
    expect(missing.diagnostics[0]?.code).toBe('E_RECIPE_ARGUMENTS');
    const bad = await plan(drive, 'google.drive-count folder=Folder', table(['Folder'], [['x']]));
    expect(bad.diagnostics[0]?.message).toMatch(/holds 'x', which is neither a Drive folder id/);
  });
});
