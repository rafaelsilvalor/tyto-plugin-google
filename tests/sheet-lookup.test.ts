import { afterEach, describe, expect, it } from 'vitest';

import { CLIENT_EMAIL } from './google.js';
import {
  callsTo,
  fakeGoogle,
  memoryCache,
  SPREADSHEET_ID,
  SPREADSHEET_URL,
  type FakeGoogle,
  type FakeSpreadsheet,
  type FakeTab,
} from './sheets.js';

/**
 * `google.sheet-lookup` through `testPlugin` and `runRecipe`: the committed bundle, an input
 * table standing for the tracker's rows, and a synthetic spreadsheet whose tab a person edits.
 */
let open: FakeGoogle | undefined;
async function google(
  sheet: FakeSpreadsheet,
  options: Parameters<typeof fakeGoogle>[1] = { section: SECTION },
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

function demandas(): FakeTab {
  return {
    sheetId: 5,
    title: 'Demandas',
    values: [
      ['TaskFilha', 'status', 'Points', 'Brief'],
      ['EX-1', 'Done', 3, 'brief one'],
      ['EX-2', 'In review', 5, 'brief two'],
      ['', 'orphan', 1, ''],
      [' EX-4 ', 'Blocked', '', 'brief four'],
      [17, 'Numbered', 2, ''],
    ],
  };
}
const spreadsheet = (): FakeSpreadsheet => ({
  tabs: [{ sheetId: 0, title: 'Other', values: [['x'], ['y']] }, demandas()],
  version: '7',
});

interface InputColumn {
  readonly name: string;
  readonly type: 'text' | 'number';
}
function tracker(columns: readonly InputColumn[], rows: readonly (string | number | null)[][]) {
  return {
    columns: columns.map(({ name, type }) => ({ name, type, origin: 'test' })),
    rows: rows.map((cells, index) => ({
      key: `r${index + 1}`,
      values: Object.fromEntries(columns.map(({ name }, at) => [name, cells[at] ?? null])),
      provenance: { source: 'test', id: `r${index + 1}`, fetchedAt: '2026-11-11T00:00:00.000Z' },
    })),
  };
}
const TRACKER = tracker(
  [
    { name: 'TaskFilha', type: 'text' },
    { name: 'status', type: 'text' },
  ],
  [
    ['EX-2', 'Open'],
    ['EX-9', 'Open'],
    ['EX-1', 'Closed'],
    [null, 'Open'],
    ['EX-4', 'Open'],
  ],
);

async function look(sheet: FakeGoogle, step: string, input: ReturnType<typeof tracker> = TRACKER) {
  const ran = await sheet.plugin.runRecipe(step, { input });
  if (!ran.ok) throw new Error(ran.error.map((item) => item.message).join('\n'));
  const cell = ran.value.cells.at(-1);
  return {
    table: cell?.table,
    diagnostics: (cell?.diagnostics ?? []).map(({ code, message }) => ({ code, message })),
  };
}

describe('google.sheet-lookup', () => {
  it("gives each row the sheet's status by key, and null for a key the sheet lacks", async () => {
    const sheet = await google(spreadsheet());
    const answer = await look(
      sheet,
      'google.sheet-lookup tab=Demandas key=TaskFilha columns=status',
    );
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.columns.map((column) => `${column.name}:${column.type}`)).toEqual([
      'TaskFilha:text',
      'status:text',
      'sheet_status:text',
    ]);
    expect(answer.table?.rows.map((row) => [row.key, row.values['sheet_status']])).toEqual([
      ['r1', 'In review'],
      ['r2', null],
      ['r3', 'Done'],
      ['r4', null],
      ['r5', 'Blocked'],
    ]);
    // The incoming columns are kept as they were.
    expect(answer.table?.rows[0]?.values['status']).toBe('Open');
    expect(callsTo(sheet, 'values').map((call) => call.path)).toEqual([
      `/v4/spreadsheets/${SPREADSHEET_ID}/values/'Demandas'`,
    ]);
  });

  it('compares keys as text, as google.sheet-sync does: a number cell matches its digits', async () => {
    const sheet = await google(spreadsheet());
    const input = tracker([{ name: 'taskfilha', type: 'number' }], [[17], [3]]);
    const answer = await look(
      sheet,
      'google.sheet-lookup tab=demandas key=TASKFILHA columns=status,points',
      input,
    );
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.columns.map((column) => `${column.name}:${column.type}`)).toEqual([
      'taskfilha:number',
      'sheet_status:text',
      'sheet_Points:number',
    ]);
    expect(answer.table?.rows.map((row) => row.values)).toEqual([
      { taskfilha: 17, sheet_status: 'Numbered', sheet_Points: 2 },
      { taskfilha: 3, sheet_status: null, sheet_Points: null },
    ]);
    // Case is kept in a key, and spaces around it are not: 'ex-1' is not 'EX-1'.
    const cased = await look(
      sheet,
      'google.sheet-lookup tab=Demandas key=TaskFilha columns=status',
      tracker([{ name: 'TaskFilha', type: 'text' }], [['ex-1'], ['EX-4  ']]),
    );
    expect(cased.table?.rows.map((row) => row.values['sheet_status'])).toEqual([null, 'Blocked']);
  });

  it('refuses a key the sheet holds twice, naming the key and both rows', async () => {
    const twice = spreadsheet();
    twice.tabs[1]?.values.push(['EX-2', 'Done', 1, '']);
    const answer = await look(
      await google(twice),
      'google.sheet-lookup tab=Demandas key=TaskFilha columns=status',
    );
    expect(answer.diagnostics).toEqual([
      {
        code: 'E_RECIPE_ARGUMENTS',
        message:
          "'google.sheet-lookup' rows 3 and 7 of the tab 'Demandas' both hold 'EX-2' in " +
          'TaskFilha; a key must be unique, and the lookup does not guess which row is it.',
      },
    ]);
  });

  it('names the columns prefix= asks for, and adds links and notes only when asked', async () => {
    const withExtras = spreadsheet();
    const tab = withExtras.tabs[1];
    if (tab === undefined) throw new Error('no tab');
    tab.links = {
      D2: { uri: 'https://example.com/one' },
      D3: { uri: 'https://example.com/two', place: 'run' },
    };
    tab.notes = { B3: 'waiting on review' };
    const sheet = await google(withExtras);
    const plain = await look(
      sheet,
      'google.sheet-lookup tab=Demandas key=TaskFilha columns=status',
    );
    expect(callsTo(sheet, 'extras')).toEqual([]);
    expect(plain.table?.columns.map((column) => column.name)).not.toContain('sheet_Brief_url');

    const answer = await look(
      sheet,
      'google.sheet-lookup tab=Demandas key=TaskFilha columns=status prefix=local_ links=Brief notes=status',
    );
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.columns.slice(2).map((column) => `${column.name}:${column.type}`)).toEqual(
      ['local_status:text', 'local_Brief_url:link', 'local_status_note:text'],
    );
    expect(answer.table?.rows.slice(0, 3).map((row) => row.values)).toEqual([
      expect.objectContaining({
        local_status: 'In review',
        local_Brief_url: 'https://example.com/two',
        local_status_note: 'waiting on review',
      }),
      expect.objectContaining({
        local_status: null,
        local_Brief_url: null,
        local_status_note: null,
      }),
      expect.objectContaining({
        local_status: 'Done',
        local_Brief_url: 'https://example.com/one',
        local_status_note: null,
      }),
    ]);
  });

  it('never overwrites a column the table has, and names what the step lacks', async () => {
    const sheet = await google(spreadsheet());
    const taken = await look(
      sheet,
      'google.sheet-lookup tab=Demandas key=TaskFilha columns=status prefix=',
    );
    expect(taken.diagnostics).toEqual([
      {
        code: 'E_RECIPE_ARGUMENTS',
        message:
          "'google.sheet-lookup' would add the column 'status', which the table already has; " +
          'name another prefix=.',
      },
    ]);
    const noKey = await look(sheet, 'google.sheet-lookup tab=Demandas key=Card columns=status');
    expect(noKey.diagnostics[0]).toMatchObject({ code: 'E_RECIPE_ARGUMENTS' });
    expect(noKey.diagnostics[0]?.message).toContain(
      "key= names the column 'Card', which the table does not have",
    );
    const noColumn = await look(
      sheet,
      'google.sheet-lookup tab=Demandas key=TaskFilha columns=Owner',
    );
    expect(noColumn.diagnostics[0]?.message).toContain(
      "columns= names 'Owner', which is not a column of the tab 'Demandas'",
    );
    const noTab = await look(sheet, 'google.sheet-lookup tab=Nope key=TaskFilha columns=status');
    expect(noTab.diagnostics[0]?.message).toContain("the spreadsheet has no tab 'Nope'");
  });

  it('reads the tab from the cache at the same Drive version, and live once it moves', async () => {
    const cache = memoryCache();
    const options = { section: SECTION, capabilities: cache.capabilities };
    const sheetState = spreadsheet();
    const step = 'google.sheet-lookup tab=Demandas key=TaskFilha columns=status';
    const first = await google(sheetState, options);
    expect((await look(first, step)).diagnostics).toEqual([]);
    expect(callsTo(first, 'values')).toHaveLength(1);
    expect(cache.entry(`sheet/${CLIENT_EMAIL}/${SPREADSHEET_ID}/5`)).toMatchObject({
      version: '7',
    });

    // The same cache entry google.sheet-rows keeps and reads: one read serves both verbs.
    const cached = await google(sheetState, options);
    const fromCache = await look(cached, step);
    expect(callsTo(cached, 'values')).toEqual([]);
    expect(fromCache.table?.rows[0]?.values['sheet_status']).toBe('In review');
    const rowsRun = await cached.plugin.runRecipe('google.sheet-rows tab=Demandas');
    expect(rowsRun.ok).toBe(true);
    expect(callsTo(cached, 'values')).toEqual([]);

    // A person edits the status; Drive raises the version, and the lookup reads live.
    const row = sheetState.tabs[1]?.values[2];
    if (row !== undefined) row[1] = 'Approved';
    sheetState.version = '8';
    const edited = await google(sheetState, options);
    const live = await look(edited, step);
    expect(callsTo(edited, 'values')).toHaveLength(1);
    expect(live.table?.rows[0]?.values['sheet_status']).toBe('Approved');
  });
});
