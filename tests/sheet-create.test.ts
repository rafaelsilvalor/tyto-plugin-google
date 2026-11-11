import { afterEach, describe, expect, it } from 'vitest';

import {
  applyWith,
  FOLDER_MIME,
  fakeDrive,
  inputTable,
  planOver,
  SPREADSHEET_MIME,
  type FakeDrive,
  type FakeGoogleDrive,
  type FakeItem,
} from './drive.js';

/**
 * `google.sheet-create` through `testPlugin`, over a synthetic Drive, signed in as a synthetic
 * person. It shares the folder verb's planning and Apply (tested in `drive-folder.test.ts`);
 * these tests hold what differs: the type created, the link, and that only a spreadsheet of
 * the name counts as already there. Every id, name and email is invented.
 */
const ROOT_ID = 'root0123456789';
const PERSON_TOKEN = 'person-token-0123';
const VERB = 'google.sheet-create';

let open: FakeGoogleDrive | undefined;
async function google(drive: FakeDrive): Promise<FakeGoogleDrive> {
  await open?.plugin.close();
  open = await fakeDrive(drive, { section: { root: ROOT_ID }, signins: { google: PERSON_TOKEN } });
  return open;
}
afterEach(async () => {
  await open?.plugin.close();
  open = undefined;
});

const made = (id: string, name: string, mimeType: string): FakeItem => ({
  id,
  name,
  mimeType,
  parents: [ROOT_ID],
  createdTime: '2026-11-01T09:00:00.000Z',
});

function studio(extra: FakeItem[] = []): FakeDrive {
  return {
    items: [{ ...made(ROOT_ID, 'Studio', FOLDER_MIME), parents: ['top0123456789x'] }, ...extra],
    ids: ['newA0123456789', 'newB0123456789'],
  };
}

const posts = (drive: FakeGoogleDrive) => drive.calls.filter((call) => call.method === 'POST');

describe('google.sheet-create', () => {
  it('creates an empty spreadsheet per row as the person, and shares it', async () => {
    const drive = await google(studio());
    const answer = await planOver(
      drive,
      `${VERB} name=Client share=Access`,
      inputTable(['Client', 'Access'], [['Acme budget', 'ana@example.com:writer']]),
    );
    expect(answer.diagnostics).toEqual([]);
    expect(answer.plan?.operations.map((each) => [each.write, each.description])).toEqual([
      [
        'create',
        `create spreadsheet "Acme budget" in 'Studio' (${ROOT_ID}), at https://docs.google.com/spreadsheets/d/newA0123456789/edit`,
      ],
      ['share', 'share "Acme budget" with ana@example.com as writer'],
    ]);
    expect(await applyWith(drive, VERB, answer.plan!)).toEqual([
      { status: 'applied' },
      { status: 'applied' },
    ]);
    // A Drive files.create of the spreadsheet type, under the parent: no Sheets API request.
    expect(posts(drive)[0]?.path).toBe('/drive/v3/files');
    expect(posts(drive)[0]?.body).toEqual({
      id: 'newA0123456789',
      name: 'Acme budget',
      mimeType: SPREADSHEET_MIME,
      parents: [ROOT_ID],
    });
    expect(drive.drive.items.find((each) => each.id === 'newA0123456789')?.permissions).toEqual([
      { email: 'ana@example.com', role: 'writer', notified: false },
    ]);
    expect(new Set(drive.calls.map((call) => call.authorization))).toEqual(
      new Set([`Bearer ${PERSON_TOKEN}`]),
    );
  });

  it('counts only a spreadsheet of the name as already there, and plans its missing shares', async () => {
    const sheet = made('sheetOld012345', 'Acme budget', SPREADSHEET_MIME);
    sheet.permissions = [{ email: 'ana@example.com', role: 'writer', notified: false }];
    // A folder of the same name is another item: it neither blocks nor counts as the sheet.
    const drive = await google(studio([sheet, made('folderOld01234', 'Acme budget', FOLDER_MIME)]));
    const answer = await planOver(
      drive,
      `${VERB} name=Client share=Access`,
      inputTable(
        ['Client', 'Access'],
        [
          ['Acme budget', 'ana@example.com:writer; bo@example.com:reader'],
          ['Globex budget', null],
        ],
      ),
    );
    expect(answer.plan?.operations.map((each) => [each.write, each.payload])).toEqual([
      [
        'share',
        { s: 'sheetOld012345', n: 'Acme budget', e: 'bo@example.com', r: 'reader', notify: false },
      ],
      ['create', { c: 'newA0123456789', n: 'Globex budget', p: ROOT_ID, m: SPREADSHEET_MIME }],
    ]);
    expect(answer.diagnostics.map((each) => each.message)).toEqual([
      `'${VERB}' creates nothing for 'Acme budget': already in 'Studio' (${ROOT_ID}); ` +
        'it plans only the shares they lack.',
    ]);
    expect(await applyWith(drive, VERB, answer.plan!)).toEqual([
      { status: 'applied' },
      { status: 'applied' },
    ]);
    expect(sheet.permissions).toEqual([
      { email: 'ana@example.com', role: 'writer', notified: false },
      { email: 'bo@example.com', role: 'reader', notified: false },
    ]);
    expect(drive.drive.items.filter((each) => each.name === 'Acme budget')).toHaveLength(2);
  });
});
