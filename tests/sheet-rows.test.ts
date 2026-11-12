import { afterEach, describe, expect, it } from 'vitest';

import { decodeCursor, encodeCursor, fingerprint } from '../src/cursor.js';
import { columnLetter, inferType } from '../src/sheet-grid.js';
import { response } from './host.js';
import { CLIENT_EMAIL } from './google.js';
import {
  callsTo,
  fakeGoogle,
  memoryCache,
  pageOf,
  peopleTab,
  rows,
  SPREADSHEET_ID,
  SPREADSHEET_URL,
  type FakeGoogle,
  type FakeSpreadsheet,
} from './sheets.js';

/**
 * `google.sheet-rows` through `testPlugin` and `runRecipe`, over a synthetic spreadsheet: the
 * committed bundle in its own isolated host, the host's own paging loop between the pages, and
 * the manifest's permissions in front of every request.
 */
let open: FakeGoogle | undefined;
async function google(
  sheet: FakeSpreadsheet,
  options: Parameters<typeof fakeGoogle>[1] = { section: { spreadsheet: SPREADSHEET_URL } },
): Promise<FakeGoogle> {
  await open?.plugin.close();
  open = await fakeGoogle(sheet, options);
  return open;
}
afterEach(async () => {
  await open?.plugin.close();
  open = undefined;
});

const SECTION = { spreadsheet: SPREADSHEET_URL };
const people = (): FakeSpreadsheet => ({ tabs: [peopleTab()], version: '41' });

describe('google.sheet-rows', () => {
  it('reads the first tab of the section spreadsheet as typed columns, a row per sheet row', async () => {
    const sheet = await google(people());
    const answer = await rows(sheet, 'google.sheet-rows');
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.columns.map((column) => `${column.name}:${column.type}`)).toEqual([
      'Name:text',
      'Age:number',
      'Active:boolean',
      'Joined:text',
      'Code:text',
      'Profile:text',
    ]);
    expect(answer.table?.rows.map((row) => row.key)).toEqual(['row-2', 'row-3', 'row-4']);
    expect(answer.table?.rows[1]?.values).toEqual({
      Name: 'Bruno',
      Age: 27,
      Active: false,
      Joined: '15/04/2026',
      Code: '7',
      Profile: 'profile',
    });
    expect(answer.table?.rows[2]?.values['Age']).toBeNull();
    expect(answer.table?.rows[0]?.provenance).toMatchObject({
      source: 'google',
      id: `${SPREADSHEET_ID}/0/2`,
    });
    const [values] = callsTo(sheet, 'values');
    expect(values?.path).toBe(`/v4/spreadsheets/${SPREADSHEET_ID}/values/'People'`);
    expect(values?.query).toEqual({
      majorDimension: 'ROWS',
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    });
    expect(callsTo(sheet, 'extras')).toEqual([]);
    expect(callsTo(sheet, 'version')[0]?.query).toEqual({
      fields: 'version',
      supportsAllDrives: 'true',
    });
  });

  it('reads the tab and the spreadsheet a step names, by address', async () => {
    const spreadsheet = people();
    spreadsheet.tabs.push({ sheetId: 7, title: "Bob's list", values: [['Item'], ['pen']] });
    const sheet = await google(spreadsheet, {});
    const answer = await rows(
      sheet,
      `google.sheet-rows spreadsheet="${SPREADSHEET_URL}" tab="bob's list"`,
    );
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.rows).toEqual([
      expect.objectContaining({
        key: 'row-2',
        values: { Item: 'pen' },
        provenance: expect.objectContaining({ id: `${SPREADSHEET_ID}/7/2` }),
      }),
    ]);
    expect(callsTo(sheet, 'values')[0]?.path).toMatch(/values\/'Bob''s list'$/);
  });

  it('keys rows by the key= column, and refuses a repeated or a blank key', async () => {
    const sheet = await google(people());
    const keyed = await rows(sheet, 'google.sheet-rows key=name');
    expect(keyed.table?.rows.map((row) => row.key)).toEqual(['Ana', 'Bruno', 'Clara']);

    const repeated = people();
    repeated.tabs[0]?.values.push(['Bruno', 40, true, '', 'B9', '']);
    const again = await rows(await google(repeated), 'google.sheet-rows key=Name');
    expect(again.diagnostics).toEqual([
      {
        code: 'E_RECIPE_VERB',
        message:
          "'google.sheet-rows' failed: rows 3 and 5 of the tab 'People' both hold 'Bruno' in " +
          'Name, which key= names; a key must be unique.',
      },
    ]);

    const blank = await rows(await google(people()), 'google.sheet-rows key=Age');
    expect(blank.diagnostics[0]?.message).toContain("row 4 of the tab 'People' has no Age");
  });

  it('skips a row with nothing in it, and keeps the sheet row number', async () => {
    const spreadsheet = people();
    spreadsheet.tabs[0]?.values.splice(2, 0, []);
    const answer = await rows(await google(spreadsheet), 'google.sheet-rows');
    expect(answer.table?.rows.map((row) => row.key)).toEqual(['row-2', 'row-4', 'row-5']);
  });

  it('adds <col>_url and <col>_note, reading each link wherever Sheets keeps it', async () => {
    const spreadsheet = people();
    const tab = spreadsheet.tabs[0];
    if (tab === undefined) throw new Error('no tab');
    tab.links = {
      F2: { uri: 'https://example.com/ana' },
      F3: { uri: 'https://example.com/bruno', place: 'run' },
      F4: { uri: 'https://example.com/clara', place: 'format' },
    };
    tab.notes = { A3: 'moved teams' };
    const sheet = await google(spreadsheet);
    const answer = await rows(sheet, 'google.sheet-rows links=Profile notes=Name');
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.columns.slice(-2)).toEqual([
      { name: 'Profile_url', type: 'link', origin: 'google' },
      { name: 'Name_note', type: 'text', origin: 'google' },
    ]);
    expect(
      answer.table?.rows.map((row) => [row.values['Profile_url'], row.values['Name_note']]),
    ).toEqual([
      ['https://example.com/ana', null],
      ['https://example.com/bruno', 'moved teams'],
      ['https://example.com/clara', null],
    ]);
    const [extras] = callsTo(sheet, 'extras');
    expect(extras?.query['ranges']).toEqual(["'People'!A2:A4", "'People'!F2:F4"]);
    expect(extras?.query['fields']).toBe(
      'sheets(data(startRow,startColumn,rowData(values(hyperlink,textFormatRuns(format(link(uri)))' +
        ',effectiveFormat(textFormat(link(uri))),note))))',
    );
  });

  it('asks for link fields only with links=, and for notes only with notes=', async () => {
    const linksOnly = await google(people());
    await rows(linksOnly, 'google.sheet-rows links=Profile');
    expect(String(callsTo(linksOnly, 'extras')[0]?.query['fields'])).not.toContain('note');

    const notesOnly = await google(people());
    await rows(notesOnly, 'google.sheet-rows notes=Profile');
    const fields = String(callsTo(notesOnly, 'extras')[0]?.query['fields']);
    expect(fields).toBe('sheets(data(startRow,startColumn,rowData(values(note))))');
  });

  it('refuses a header with a blank name over values, or a name twice', async () => {
    const blank = people();
    blank.tabs[0]?.values[1]?.push('stray');
    const first = await rows(await google(blank), 'google.sheet-rows');
    expect(first.diagnostics[0]?.message).toBe(
      "'google.sheet-rows' failed: the tab 'People' has no column name in G1, and column G " +
        'holds values; name it, or clear the column.',
    );

    const twice = people();
    if (twice.tabs[0]?.values[0] !== undefined) twice.tabs[0].values[0][4] = ' name ';
    const second = await rows(await google(twice), 'google.sheet-rows');
    expect(second.diagnostics[0]?.message).toContain(
      "names two columns 'name' (A1 and E1); every column name in row 1 must differ",
    );
  });

  it('names the columns when key= or links= names a header the tab no longer has', async () => {
    const renamed = people();
    if (renamed.tabs[0]?.values[0] !== undefined) renamed.tabs[0].values[0][0] = 'Full name';
    const answer = await rows(await google(renamed), 'google.sheet-rows key=Name');
    expect(answer.diagnostics).toEqual([
      {
        code: 'E_RECIPE_ARGUMENTS',
        message:
          "'google.sheet-rows' key= names 'Name', which is not a column of the tab 'People'; " +
          "its columns are 'Full name', 'Age', 'Active', 'Joined', 'Code', 'Profile'.",
      },
    ]);
  });

  it('refuses a <col>_url the tab already has as a header', async () => {
    const spreadsheet = people();
    spreadsheet.tabs[0]?.values[0]?.push('profile_URL');
    const answer = await rows(await google(spreadsheet), 'google.sheet-rows links=Profile');
    expect(answer.diagnostics[0]?.message).toContain(
      "the column 'Profile_url' this step adds is the tab 'People''s column 'profile_URL' already",
    );
  });

  it('refuses a step with no spreadsheet, an address that is not one, or a missing tab', async () => {
    const none = await rows(await google(people(), {}), 'google.sheet-rows');
    expect(none.diagnostics[0]).toEqual({
      code: 'E_RECIPE_ARGUMENTS',
      message:
        "'google.sheet-rows' needs spreadsheet=, or spreadsheet in the google section of " +
        '.tyto/project.json, and was given neither.',
    });
    const bad = await rows(
      await google(people()),
      'google.sheet-rows spreadsheet="https://example.com/d/x"',
    );
    expect(bad.diagnostics[0]?.code).toBe('E_RECIPE_ARGUMENTS');
    const tab = await rows(await google(people()), 'google.sheet-rows tab=Nobody');
    expect(tab.diagnostics[0]?.message).toBe(
      "'google.sheet-rows' the spreadsheet has no tab 'Nobody'; its tabs are 'People'.",
    );
  });

  it('is cut short, never a short table, past max=', async () => {
    const answer = await rows(await google(people()), 'google.sheet-rows max=2');
    expect(answer.table).toBeUndefined();
    expect(answer.diagnostics[0]?.code).toBe('E_RECIPE_SOURCE');
  });
});

/** A tab of `count` data rows, keyed by `id`. */
function bigSheet(count: number): FakeSpreadsheet {
  const values: unknown[][] = [['id', 'value']];
  for (let index = 1; index <= count; index += 1) values.push([`id-${index}`, index]);
  return { tabs: [{ sheetId: 3, title: 'Big', values }], version: '9' };
}

describe('paging and the cache', () => {
  it('reads a 12,000-row tab once and answers it in pages of 5,000', async () => {
    const cache = memoryCache();
    const sheet = await google(bigSheet(12_000), {
      section: SECTION,
      capabilities: cache.capabilities,
    });
    const answer = await rows(sheet, 'google.sheet-rows key=id');
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.rows).toHaveLength(12_000);
    expect(answer.table?.rows[11_999]?.key).toBe('id-12000');
    expect(callsTo(sheet, 'values')).toHaveLength(1);
    expect([...cache.entries.keys()]).toEqual([`sheet/${CLIENT_EMAIL}/${SPREADSHEET_ID}/3`]);
    expect(cache.entry(`sheet/${CLIENT_EMAIL}/${SPREADSHEET_ID}/3`)).toMatchObject({
      v: 1,
      version: '9',
    });
  });

  it('pages a tab with no host cache by reading it again and checking it is the same', async () => {
    const sheet = await google(bigSheet(6000));
    const answer = await rows(sheet, 'google.sheet-rows');
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.rows).toHaveLength(6000);
    expect(callsTo(sheet, 'values')).toHaveLength(2);
  });

  it('refuses a cursor cut from another snapshot of the tab', async () => {
    const sheet = await google(bigSheet(6000));
    const page = pageOf(sheet);
    const first = await page({ arguments: {}, section: SECTION });
    const cursor = first.ok ? first.value.cursor : undefined;
    expect(cursor).toBeDefined();
    sheet.sheet.tabs[0]?.values.push(['id-6001', 6001]);
    const second = await page({ arguments: {}, section: SECTION, ...(cursor ? { cursor } : {}) });
    expect(second).toEqual({
      ok: false,
      error: [
        expect.objectContaining({
          code: 'E_RECIPE_VERB',
          message:
            "'google.sheet-rows' failed: the tab changed while its pages were read; run again.",
        }),
      ],
    });
  });

  it('refuses a cursor handed to a changed step, or one it never wrote', async () => {
    const sheet = await google(bigSheet(6000));
    const page = pageOf(sheet);
    const first = await page({ arguments: {}, section: SECTION });
    const cursor = first.ok ? (first.value.cursor ?? '') : '';
    const changed = await page({ arguments: { key: 'id' }, section: SECTION, cursor });
    expect(changed.ok ? '' : changed.error[0]?.message).toBe(
      "'google.sheet-rows' failed: the step changed between two pages of one run; run again.",
    );
    const forged = await page({ arguments: {}, section: SECTION, cursor: 'not a cursor!' });
    expect(forged.ok ? '' : forged.error[0]?.message).toBe(
      "'google.sheet-rows' failed: the cursor is not base64url; run again.",
    );
  });

  it('serves the next run from the cache only while Drive gives the same version', async () => {
    const cache = memoryCache();
    const spreadsheet = people();
    const options = { section: SECTION, capabilities: cache.capabilities };
    const first = await google(spreadsheet, options);
    expect((await rows(first, 'google.sheet-rows')).diagnostics).toEqual([]);
    expect(callsTo(first, 'values')).toHaveLength(1);

    const same = await google(spreadsheet, options);
    const cached = await rows(same, 'google.sheet-rows');
    expect(cached.table?.rows).toHaveLength(3);
    expect(callsTo(same, 'version')).toHaveLength(1);
    expect(callsTo(same, 'values')).toEqual([]);

    spreadsheet.version = '42';
    spreadsheet.tabs[0]?.values.push(['Dora', 22, true, '', 'D4', '']);
    const edited = await google(spreadsheet, options);
    const fresh = await rows(edited, 'google.sheet-rows');
    expect(callsTo(edited, 'values')).toHaveLength(1);
    expect(fresh.table?.rows).toHaveLength(4);
    expect(cache.entry(`sheet/${CLIENT_EMAIL}/${SPREADSHEET_ID}/0`)).toMatchObject({
      version: '42',
    });
  });

  it('reads live, and fills the cache, when the run asks to refresh', async () => {
    const cache = memoryCache();
    const options = { section: SECTION, capabilities: cache.capabilities };
    await rows(await google(people(), options), 'google.sheet-rows');
    const again = await google(people(), options);
    const answer = await pageOf(again)({ arguments: {}, section: SECTION, refresh: true });
    expect(answer.ok).toBe(true);
    expect(callsTo(again, 'values')).toHaveLength(1);
  });

  it('reads live when the cached tab lacks the links a step now asks for', async () => {
    const cache = memoryCache();
    const options = { section: SECTION, capabilities: cache.capabilities };
    await rows(await google(people(), options), 'google.sheet-rows');
    const again = await google(people(), options);
    await rows(again, 'google.sheet-rows links=Profile');
    expect(callsTo(again, 'values')).toHaveLength(1);
    expect(callsTo(again, 'extras')).toHaveLength(1);
    const reused = await google(people(), options);
    await rows(reused, 'google.sheet-rows links=Profile');
    expect(callsTo(reused, 'values')).toEqual([]);
  });

  it('reads live and caches nothing when Drive does not give the version', async () => {
    const cache = memoryCache();
    const spreadsheet = people();
    spreadsheet.driveFailure = response(403, {
      error: {
        code: 403,
        status: 'PERMISSION_DENIED',
        message: 'Drive API has not been used in project 1',
      },
    });
    const sheet = await google(spreadsheet, { section: SECTION, capabilities: cache.capabilities });
    const answer = await rows(sheet, 'google.sheet-rows');
    expect(answer.table?.rows).toHaveLength(3);
    expect(cache.entries.size).toBe(0);
    expect(sheet.plugin.log.some((line) => line.includes("did not give the file's version"))).toBe(
      true,
    );
  });
});

describe('the parts', () => {
  it('names columns as Sheets does', () => {
    expect([0, 25, 26, 51, 52, 701, 702].map(columnLetter)).toEqual([
      'A',
      'Z',
      'AA',
      'AZ',
      'BA',
      'ZZ',
      'AAA',
    ]);
  });

  it('types a column number or boolean only when every filled cell agrees', () => {
    const values = [['h'], [1], [''], [2.5]];
    expect(inferType(values, 0)).toBe('number');
    expect(inferType([['h'], [true], [false]], 0)).toBe('boolean');
    expect(inferType([['h'], [1], ['two']], 0)).toBe('text');
    expect(inferType([['h'], [true], [1]], 0)).toBe('text');
    expect(inferType([['h']], 0)).toBe('text');
  });

  it('round-trips a cursor and refuses one it did not write', () => {
    const cursor = { v: 1, o: 5000, d: fingerprint('a'), s: 3, f: fingerprint('b') } as const;
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
    expect(decodeCursor(encodeCursor({ ...cursor, o: 0 }))).toBe(
      'the cursor is not one this plugin writes',
    );
    expect(decodeCursor('x'.repeat(1001))).toMatch(/over 1000$/);
  });
});
