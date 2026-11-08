import type { TestRecipeOptions } from '@tyto/plugin-api/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { tabSettingsOf } from '../src/sheet-format.js';
import {
  fakeGoogle,
  memoryCache,
  SPREADSHEET_ID,
  SPREADSHEET_URL,
  type FakeGoogle,
  type FakeSpreadsheet,
  type FakeTab,
} from './sheets.js';

/**
 * `google.sheet-sync` through `testPlugin`, over a synthetic queue whose rows reproduce each
 * branch of the decision table: updated, unchanged, deleted, kept for its hand-written note,
 * moved to a tab that does not exist yet, added, skipped as archived, and skipped as never
 * there. Every key and name is invented.
 */
type InputTable = NonNullable<TestRecipeOptions['input']>;

let open: FakeGoogle | undefined;
async function google(
  sheet: FakeSpreadsheet,
  cache = memoryCache(),
  tabs?: Record<string, unknown>,
): Promise<FakeGoogle> {
  await open?.plugin.close();
  open = await fakeGoogle(sheet, {
    section: { spreadsheet: SPREADSHEET_URL, ...(tabs === undefined ? {} : { tabs }) },
    capabilities: cache.capabilities,
  });
  return open;
}
afterEach(async () => {
  await open?.plugin.close();
  open = undefined;
});

const BATCH = `/v4/spreadsheets/${SPREADSHEET_ID}:batchUpdate`;
const STEP = 'google.sheet-sync tab=Queue key=ID move=Filed keep=Notes archived=Archive';

const queue = (): FakeTab => ({
  sheetId: 5,
  title: 'Queue',
  values: [
    ['ID', 'Title', 'Owner', 'Notes'],
    ['EX-1', 'Old title', 'Ana', ''],
    ['EX-2', 'Same', 'Bruno', ''],
    ['EX-3', 'Gone', 'Clara', ''],
    ['EX-4', 'Kept', 'Dora', 'call back'],
    ['EX-5', 'Ship', 'Enzo', 'draft ok'],
    ['EX-6', 'Also gone', 'Fabi', ''],
  ],
});
const archive = (): FakeTab => ({
  sheetId: 9,
  title: 'Archive',
  values: [
    ['ID', 'Title'],
    ['EX-8', 'Filed before'],
  ],
});

function input(rows: readonly (readonly [string, string, string, string])[]): InputTable {
  const names = ['ID', 'Title', 'Owner', 'Filed'];
  return {
    columns: names.map((name) => ({ name, type: 'text' as const, origin: 'test' })),
    rows: rows.map((cells, index) => ({
      key: cells[0] || `r${index + 1}`,
      values: Object.fromEntries(names.map((name, at) => [name, cells[at] || null])),
      provenance: { source: 'test', id: `r${index + 1}`, fetchedAt: '2026-11-07T00:00:00.000Z' },
    })),
  };
}

const everyBranch = () =>
  input([
    ['EX-1', 'New title', 'Ana', ''],
    ['EX-2', 'Same', 'Bruno', ''],
    ['EX-5', 'Ship', 'Enzo', 'Shipped'],
    ['EX-7', 'Fresh', 'Gil', ''],
    ['EX-8', 'Filed before', 'Hugo', ''],
    ['EX-9', 'Never here', 'Ivo', 'Shipped'],
  ]);

async function planAndApply(
  sheet: FakeGoogle,
  step: string,
  table: InputTable,
  between: () => void | Promise<void> = () => {},
) {
  const ran = await sheet.plugin.runRecipe(step, { input: table });
  if (!ran.ok) throw new Error(ran.error.map((item) => item.message).join('\n'));
  const cell = ran.value.cells.at(-1);
  const diagnostics = (cell?.diagnostics ?? []).map(({ severity, message }) => ({
    severity,
    message,
  }));
  const plan = cell?.plan;
  if (plan === undefined) return { diagnostics, plan, applied: undefined };
  await between();
  const verb = sheet.plugin.recipes.verbs.get('google.sheet-sync');
  if (verb?.apply === undefined) throw new Error('google.sheet-sync has no apply');
  const applied = await verb.apply(plan);
  if (!applied.ok) throw new Error(applied.error.map((item) => item.message).join('\n'));
  return {
    diagnostics,
    plan,
    applied: applied.value.operations.map(({ status, reason }) => ({
      status,
      ...(reason === undefined ? {} : { reason }),
    })),
  };
}

/** The batchUpdates sent, as their requests' kinds and rows. */
function batches(sheet: FakeGoogle): string[][] {
  return sheet.calls
    .filter((call) => call.method === 'POST' && call.path === BATCH)
    .map((call) =>
      (call.body as { requests: Record<string, Record<string, unknown>>[] }).requests.map(
        (request) => {
          const [kind = '', detail = {}] = Object.entries(request)[0] ?? [];
          const range = (detail['range'] ?? {}) as Record<string, number>;
          if (kind === 'deleteDimension') return `delete row ${(range['startIndex'] ?? 0) + 1}`;
          if (kind === 'updateCells') {
            return `cells ${range['sheetId']}:${(range['startRowIndex'] ?? 0) + 1}:${range['startColumnIndex']}`;
          }
          if (kind === 'appendCells') return `append ${String(detail['sheetId'])}`;
          if (kind === 'copyPaste') {
            const from = detail['source'] as Record<string, number>;
            const to = detail['destination'] as Record<string, number>;
            return (
              `copy ${(from['startRowIndex'] ?? 0) + 1} to ` +
              `${to['sheetId']}:${(to['startRowIndex'] ?? 0) + 1}`
            );
          }
          if (kind === 'addSheet') return 'add tab';
          return kind;
        },
      ),
    );
}

const tabNamed = (sheet: FakeGoogle, title: string) =>
  sheet.sheet.tabs.find((tab) => tab.title === title);

describe('google.sheet-sync decisions', () => {
  it('plans each branch of the decision table, and applies them in one batchUpdate', async () => {
    const sheet = await google({ tabs: [queue(), archive()], version: '1' });
    const answer = await planAndApply(sheet, STEP, everyBranch());
    expect(answer.plan?.target).toBe(`the tab 'Queue' of spreadsheet ${SPREADSHEET_ID}`);
    expect(
      answer.plan?.operations.map((each) => [each.write, each.rowKey, each.description]),
    ).toEqual([
      ['add-tab', undefined, "add the tab 'Shipped', with the header ID, Title, Owner, Notes"],
      ['update', 'EX-1', 'update EX-1 (row 2): Title: Old title → New title'],
      ['move', 'EX-5', "move EX-5 (row 6) to the tab 'Shipped'"],
      ['delete', undefined, 'delete EX-3 (row 4), which the table no longer holds'],
      ['delete', undefined, 'delete EX-6 (row 7), which the table no longer holds'],
      ['add', 'EX-7', 'add EX-7: EX-7 | Fresh | Gil'],
    ]);
    expect(answer.diagnostics).toEqual([
      {
        severity: 'warning',
        message:
          "'google.sheet-sync' keeps 1 row(s) the table no longer holds, because their 'Notes' " +
          "hold text a person wrote: 'EX-4'",
      },
      {
        severity: 'warning',
        message: "'google.sheet-sync' does not add 'EX-8', already in 'Archive'",
      },
      {
        severity: 'warning',
        message:
          "'google.sheet-sync' does not add 'EX-9': move= sends them to another tab, and they " +
          "were never in 'Queue'",
      },
    ]);
    // Only the cell that changed is in the update's payload.
    expect(answer.plan?.operations[1]?.payload).toMatchObject({ k: 'EX-1', u: [[1, 'New title']] });

    expect(answer.applied?.every((each) => each.status === 'applied')).toBe(true);
    expect(batches(sheet)).toEqual([
      [
        'add tab',
        'cells 10:1:0',
        'cells 5:2:1',
        'copy 6 to 10:2',
        'delete row 7',
        'delete row 6',
        'delete row 4',
        'append 5',
      ],
    ]);
    expect(tabNamed(sheet, 'Queue')?.values).toEqual([
      ['ID', 'Title', 'Owner', 'Notes'],
      ['EX-1', 'New title', 'Ana'],
      ['EX-2', 'Same', 'Bruno', ''],
      ['EX-4', 'Kept', 'Dora', 'call back'],
      ['EX-7', 'Fresh', 'Gil'],
    ]);
    // The moved row carries the hand-written note with it.
    expect(tabNamed(sheet, 'Shipped')?.values).toEqual([
      ['ID', 'Title', 'Owner', 'Notes'],
      ['EX-5', 'Ship', 'Enzo', 'draft ok'],
    ]);
  });

  it('places a moved row by the destination header, whatever its column order', async () => {
    const step = 'google.sheet-sync tab=Queue key=ID move=Filed keep=Notes';
    const table = input([['EX-5', 'Ship', 'Enzo', 'Shipped']]);
    const narrow: FakeTab = { sheetId: 11, title: 'Shipped', values: [['Title', 'ID', 'Owner']] };
    const refused = await planAndApply(
      await google({ tabs: [queue(), narrow], version: '1' }),
      step,
      table,
    );
    expect(refused.plan?.operations[0]?.description).toMatch(
      /will fail: E_GOOGLE_PLAN: the tab 'Shipped' has no column 'Notes', which EX-5 fills/,
    );
    const wide: FakeTab = { ...narrow, values: [['Notes', 'Owner', 'ID', 'Title']] };
    const sheet = await google({ tabs: [queue(), wide], version: '1' });
    const placed = await planAndApply(sheet, step, table);
    expect(placed.applied?.[0]).toEqual({ status: 'applied' });
    expect(tabNamed(sheet, 'Shipped')?.values[1]).toEqual(['draft ok', 'Enzo', 'EX-5', 'Ship']);
  });
});

describe('google.sheet-sync guards', () => {
  it('deletes nothing when handed no rows over a tab that has some, and says so', async () => {
    const sheet = await google({ tabs: [queue()], version: '1' });
    const answer = await planAndApply(
      sheet,
      'google.sheet-sync tab=Queue key=ID move=Filed',
      input([]),
    );
    expect(answer.plan?.operations).toEqual([]);
    expect(answer.diagnostics).toEqual([
      {
        severity: 'warning',
        message: expect.stringMatching(
          /was handed no rows, and the tab 'Queue' holds 6: it deletes nothing/,
        ) as string,
      },
    ]);
    expect(sheet.calls.filter((call) => call.path === BATCH)).toEqual([]);
  });

  it('refuses a key the tab holds twice, naming both rows, before planning anything', async () => {
    const twice = queue();
    twice.values.push(['EX-2', 'Again', 'Gil', '']);
    const sheet = await google({ tabs: [twice], version: '1' });
    const run = await sheet.plugin.runRecipe('google.sheet-sync tab=Queue key=ID move=Filed', {
      input: everyBranch(),
    });
    const messages = run.ok ? run.value.cells.flatMap((cell) => cell.diagnostics) : run.error;
    expect(messages.map((each) => each.message).join('\n')).toMatch(
      /rows 3 and 8 of the tab 'Queue' both hold 'EX-2' in ID; a key must be unique/,
    );
    expect(run.ok ? run.value.cells.at(-1)?.plan : undefined).toBeUndefined();
  });

  it('refuses a key the table holds twice', async () => {
    const sheet = await google({ tabs: [queue()], version: '1' });
    const run = await sheet.plugin.runRecipe('google.sheet-sync tab=Queue key=ID move=Filed', {
      input: input([
        ['EX-1', 'a', '', ''],
        ['EX-1', 'b', '', ''],
      ]),
    });
    const messages = run.ok ? run.value.cells.flatMap((cell) => cell.diagnostics) : run.error;
    expect(messages.map((each) => each.message).join('\n')).toMatch(
      /the table holds 'EX-1' in ID twice; a key must be unique/,
    );
  });
});

describe('google.sheet-sync apply', () => {
  it('finds each row by its key, not by the number it had when planned', async () => {
    const sheet = await google({ tabs: [queue(), archive()], version: '1' });
    const answer = await planAndApply(sheet, STEP, everyBranch(), () => {
      // A person inserts a row at the top: every planned row is one lower now.
      tabNamed(sheet, 'Queue')?.values.splice(1, 0, ['EX-0', 'Inserted', 'Zoe', '']);
    });
    expect(answer.applied?.every((each) => each.status === 'applied')).toBe(true);
    expect(batches(sheet)[0]).toContain('delete row 8');
    expect(tabNamed(sheet, 'Queue')?.values.map((row) => row[0])).toEqual([
      'ID',
      'EX-0',
      'EX-1',
      'EX-2',
      'EX-4',
      'EX-7',
    ]);
  });

  it('fails a row changed since the plan, alone, and writes the others', async () => {
    const sheet = await google({ tabs: [queue(), archive()], version: '1' });
    const answer = await planAndApply(sheet, STEP, everyBranch(), () => {
      const tab = tabNamed(sheet, 'Queue');
      if (tab?.values[3] !== undefined) tab.values[3][3] = 'a person wrote this';
      if (tab?.values[1] !== undefined) tab.values[1][2] = 'Someone else';
    });
    expect(answer.applied).toEqual([
      { status: 'applied' },
      {
        status: 'failed',
        reason:
          'E_GOOGLE_CHANGED: EX-1 (row 2): the row changed since the plan; run the cell again ' +
          'for a new plan',
      },
      { status: 'applied' },
      {
        status: 'failed',
        reason: expect.stringMatching(
          /^E_GOOGLE_CHANGED: EX-3 \(row 4\): the row changed/,
        ) as string,
      },
      { status: 'applied' },
      { status: 'applied' },
    ]);
    expect(tabNamed(sheet, 'Queue')?.values.map((row) => row[0])).toEqual([
      'ID',
      'EX-1',
      'EX-2',
      'EX-3',
      'EX-4',
      'EX-7',
    ]);
  });

  it('fails an add whose key reached the tab since the plan', async () => {
    const sheet = await google({ tabs: [queue(), archive()], version: '1' });
    const answer = await planAndApply(sheet, STEP, everyBranch(), () => {
      tabNamed(sheet, 'Queue')?.values.push(['EX-7', 'Typed by hand', '', '']);
    });
    expect(answer.applied?.[5]).toEqual({
      status: 'failed',
      reason: expect.stringMatching(/^E_GOOGLE_CHANGED: EX-7 is in the tab already/) as string,
    });
  });

  it('moves a row in one batchUpdate: a refused one neither copies nor deletes it', async () => {
    // Google refuses the removal: the copy, in the same batch, must not land either.
    const sheet = await google({
      tabs: [queue(), archive()],
      version: '1',
      refuseKinds: ['deleteDimension'],
    });
    const answer = await planAndApply(sheet, STEP, everyBranch());
    expect(sheet.calls.filter((call) => call.path === BATCH)).toHaveLength(1);
    expect(batches(sheet)[0]).toEqual(expect.arrayContaining(['copy 6 to 10:2', 'delete row 6']));
    expect(answer.applied?.[2]?.reason).toMatch(/None of this batch was written/);
    expect(tabNamed(sheet, 'Queue')?.values).toEqual(queue().values);
    expect(tabNamed(sheet, 'Shipped')).toBeUndefined();
  });

  it('keeps a row too big for its payload in the cache, and fails it when the cache lost it', async () => {
    const cache = memoryCache();
    const long = 'y'.repeat(2500);
    const table = input([['EX-1', long, 'Ana', '']]);
    const sheet = await google({ tabs: [queue()], version: '1' }, cache);
    const kept = await planAndApply(
      sheet,
      'google.sheet-sync tab=Queue key=ID move=Filed keep=Notes',
      table,
    );
    const payload = kept.plan?.operations.find((each) => each.write === 'update')?.payload;
    expect(Object.keys(payload as object).sort()).toEqual(['cd', 'ck']);
    expect(kept.applied?.every((each) => each.status === 'applied')).toBe(true);
    expect(tabNamed(sheet, 'Queue')?.values[1]?.[1]).toBe(long);

    const lost = await planAndApply(
      await google({ tabs: [queue()], version: '1' }, cache),
      'google.sheet-sync tab=Queue key=ID move=Filed keep=Notes',
      table,
      () => {
        for (const key of cache.entries.keys())
          if (key.startsWith('plan/')) cache.entries.delete(key);
      },
    );
    expect(lost.applied?.[0]?.reason).toMatch(/^E_GOOGLE_PLAN: .*no longer holds them/);
  });
});

describe('google.sheet-sync refusals', () => {
  const refusalOf = async (step: string, table: InputTable, tabs: FakeTab[]) => {
    const sheet = await google({ tabs, version: '1' });
    const run = await sheet.plugin.runRecipe(step, { input: table });
    const found = run.ok ? run.value.cells.flatMap((cell) => cell.diagnostics) : run.error;
    expect(run.ok ? run.value.cells.at(-1)?.plan : undefined).toBeUndefined();
    expect(sheet.calls.filter((call) => call.path === BATCH)).toEqual([]);
    return found.map((each) => each.message).join('\n');
  };

  it.each([
    ['a table column the tab lacks', 'tab=Queue key=ID', /cannot write 'Filed': the tab 'Queue'/],
    ['an unknown keep= column', 'tab=Queue key=ID move=Filed keep=Memo', /keep= names 'Memo'/],
    ['a key= the table lacks', 'tab=Queue key=Code move=Filed', /key= names 'Code', which is not/],
    ['an unknown move= column', 'tab=Queue key=ID move=Status', /move= names 'Status', which/],
    [
      'an archived tab with no key column',
      'tab=Queue key=ID move=Filed archived=Notes',
      /archived= names 'Notes', which has no column 'ID'/,
    ],
  ])('refuses %s before reading or writing a row', async (_, args, words) => {
    const notes: FakeTab = { sheetId: 3, title: 'Notes', values: [['Memo'], ['x']] };
    expect(await refusalOf(`google.sheet-sync ${args}`, everyBranch(), [queue(), notes])).toMatch(
      words,
    );
  });
});

describe('google.sheet-sync planned failures', () => {
  it('shows a move it cannot make, and a row with no key, as failures in the plan', async () => {
    const empty: FakeTab = { sheetId: 4, title: 'Empty', values: [] };
    const sheet = await google({ tabs: [queue(), empty], version: '1' });
    const table = input([
      ['EX-1', 'Old title', 'Ana', 'queue'],
      ['EX-2', 'Same', 'Bruno', 'Empty'],
      ['', 'No key', 'Gil', ''],
    ]);
    const answer = await planAndApply(
      sheet,
      'google.sheet-sync tab=Queue key=ID move=Filed keep=Notes',
      table,
    );
    const failures = answer.plan?.operations.map((each) => [each.write, each.payload]);
    expect(failures).toEqual([
      ['add', { x: 'E_GOOGLE_PLAN: r3 has no ID, which key= names' }],
      ['move', { x: "E_GOOGLE_PLAN: move= names the tab 'Queue' this step syncs" }],
      [
        'move',
        {
          x:
            "E_GOOGLE_PLAN: the tab 'Empty' is empty; write its header in row 1, or delete " +
            'the tab so the sync adds it',
        },
      ],
      ...['EX-3', 'EX-6'].map(() => ['delete', expect.objectContaining({ d: expect.any(String) })]),
    ]);
    expect(answer.applied?.slice(0, 3).map((each) => each.status)).toEqual([
      'failed',
      'failed',
      'failed',
    ]);
    expect(tabNamed(sheet, 'Queue')?.values.map((row) => row[0])).toEqual([
      'ID',
      'EX-1',
      'EX-2',
      'EX-4',
      'EX-5',
    ]);
  });
});

describe('google.sheet-sync links', () => {
  it('updates a linked cell only when its text or its link differs', async () => {
    const linked: FakeTab = {
      ...queue(),
      links: {
        B2: { uri: 'https://tasks.example.com/1', place: 'run' },
        B3: { uri: 'https://tasks.example.com/old', place: 'format' },
      },
    };
    const sheet = await google({ tabs: [linked], version: '1' });
    const table: InputTable = {
      columns: [
        { name: 'ID', type: 'text', origin: 'test' },
        { name: 'Title', type: 'text', origin: 'test' },
        { name: 'Title_url', type: 'link', origin: 'test' },
      ],
      rows: [
        ['EX-1', 'Old title', 'https://tasks.example.com/1'],
        ['EX-2', 'Same', 'https://tasks.example.com/2'],
      ].map(([id = '', title, url]) => ({
        key: id,
        values: { ID: id, Title: title ?? null, Title_url: url ?? null },
        provenance: { source: 'test', id, fetchedAt: '2026-11-07T00:00:00.000Z' },
      })),
    };
    const answer = await planAndApply(
      sheet,
      'google.sheet-sync tab=Queue key=ID keep=Notes',
      table,
    );
    expect(answer.plan?.operations.filter((each) => each.write === 'update')).toEqual([
      expect.objectContaining({
        rowKey: 'EX-2',
        description: 'update EX-2 (row 3): Title: Same → Same (https://tasks.example.com/2)',
      }),
    ]);
    expect(tabNamed(sheet, 'Queue')?.links?.['B3']?.uri).toBe('https://tasks.example.com/2');
  });
});

describe('google.sheet-sync apply, after a person', () => {
  it('skips a new tab a person added since the plan, and moves the row into it', async () => {
    const sheet = await google({ tabs: [queue(), archive()], version: '1' });
    const answer = await planAndApply(sheet, STEP, everyBranch(), () => {
      sheet.sheet.tabs.push({
        sheetId: 20,
        title: 'Shipped',
        values: [['ID', 'Title', 'Owner', 'Notes']],
      });
    });
    expect(answer.applied?.[0]).toEqual({
      status: 'skipped',
      reason: "the tab 'Shipped' is in the spreadsheet already",
    });
    expect(answer.applied?.[2]).toEqual({ status: 'applied' });
    expect(tabNamed(sheet, 'Shipped')?.values[1]).toEqual(['EX-5', 'Ship', 'Enzo', 'draft ok']);
  });

  it('fails every row operation when the header changed since the plan', async () => {
    const sheet = await google({ tabs: [queue(), archive()], version: '1' });
    const answer = await planAndApply(sheet, STEP, everyBranch(), () => {
      const header = tabNamed(sheet, 'Queue')?.values[0];
      if (header !== undefined) header[1] = 'Subject';
    });
    expect(answer.applied?.slice(1).map((each) => each.reason)).toEqual(
      Array.from({ length: 5 }, () =>
        expect.stringMatching(/^E_GOOGLE_CHANGED: the header of the tab 'Queue' changed/),
      ),
    );
    expect(tabNamed(sheet, 'Queue')?.values.slice(1)).toEqual(queue().values.slice(1));
  });
});

describe('google.sheet-sync tab formatting', () => {
  const MOVE_STEP = 'google.sheet-sync tab=Queue key=ID move=Filed keep=Notes';
  const sameRows = () =>
    input(
      queue()
        .values.slice(1)
        .map((row) => [String(row[0]), String(row[1]), String(row[2]), ''] as const),
    );
  const formats = (plan: { operations: readonly { write: string; description: string }[] }) =>
    plan.operations.filter((each) => each.write === 'format-tab').map((each) => each.description);
  const tableOf = (range: number, columnProperties?: Record<string, unknown>[]) => ({
    tableId: 'tq',
    name: 'QueueTable',
    range: {
      sheetId: 5,
      startRowIndex: 0,
      endRowIndex: range,
      startColumnIndex: 0,
      endColumnIndex: 4,
    },
    ...(columnProperties === undefined ? {} : { columnProperties }),
  });
  const ownerDropdown = (values: string[]) => ({
    columnIndex: 2,
    columnName: 'Owner',
    columnType: 'DROPDOWN',
    dataValidationRule: {
      condition: {
        type: 'ONE_OF_LIST',
        values: values.map((userEnteredValue) => ({ userEnteredValue })),
      },
    },
  });
  const lastBatch = (sheet: FakeGoogle) =>
    (
      sheet.calls.filter((call) => call.path === BATCH).at(-1)?.body as {
        requests: Record<string, Record<string, unknown>>[];
      }
    ).requests;

  it('adds a native table only after removing the alternating colours, then leaves it be', async () => {
    const settings = {
      Queue: {
        table: 'QueueTable',
        header: '#D9EAD3',
        dropdowns: { Owner: ['Ana', 'Bruno', 'Dora', 'Gil'] },
      },
      Shipped: { table: true },
    };
    const banded: FakeTab = { ...queue(), banded: [42] };
    const sheet = await google(
      { tabs: [banded, archive()], version: '1' },
      memoryCache(),
      settings,
    );
    const answer = await planAndApply(sheet, STEP, everyBranch());
    expect(answer.plan === undefined ? [] : formats(answer.plan)).toEqual([
      "format the tab 'Queue': remove its 1 alternating colours; add the table 'QueueTable' " +
        'over rows 1 to 5; the dropdown of Owner: Ana, Bruno, Dora, Gil; colour its header #D9EAD3',
      "format the tab 'Shipped': add the table 'Table_Shipped' over rows 1 to 2",
    ]);
    expect(answer.applied?.every((each) => each.status === 'applied')).toBe(true);
    expect(batches(sheet)).toHaveLength(1);
    expect(batches(sheet)[0]?.slice(-4)).toEqual([
      'deleteBanding',
      'addTable',
      'repeatCell',
      'addTable',
    ]);
    const queueTab = tabNamed(sheet, 'Queue');
    expect(queueTab?.banded).toEqual([]);
    expect(queueTab?.tables?.map((each) => [each.name, each.range['endRowIndex']])).toEqual([
      ['QueueTable', 5],
    ]);
    expect(queueTab?.tables?.[0]?.columnProperties).toEqual([
      ownerDropdown(['Ana', 'Bruno', 'Dora', 'Gil']),
    ]);
    expect(tabNamed(sheet, 'Shipped')?.tables?.map((each) => each.name)).toEqual(['Table_Shipped']);

    // Run again over what Apply left: nothing differs, so nothing is planned.
    const again = await planAndApply(sheet, STEP, everyBranch());
    expect(again.plan?.operations).toEqual([]);
  });

  it('stretches the table the tab has with updateTable, never adding a second', async () => {
    const tabbed: FakeTab = { ...queue(), banded: [42], tables: [tableOf(7)] };
    const sheet = await google({ tabs: [tabbed, archive()], version: '1' }, memoryCache(), {
      Queue: { table: 'QueueTable' },
    });
    const answer = await planAndApply(sheet, STEP, everyBranch());
    expect(answer.plan === undefined ? [] : formats(answer.plan)).toEqual([
      "format the tab 'Queue': stretch its table over rows 1 to 5",
    ]);
    const kinds = batches(sheet)[0] ?? [];
    expect(kinds.at(-1)).toBe('updateTable');
    expect(kinds).not.toContain('addTable');
    expect(kinds).not.toContain('deleteBanding');
    expect(lastBatch(sheet).at(-1)?.['updateTable']?.['fields']).toBe('range');
    expect(tabNamed(sheet, 'Queue')?.tables?.map((each) => each.range['endRowIndex'])).toEqual([5]);
  });

  it("leaves a table column's dropdown untouched while its values are the same", async () => {
    const title = { columnIndex: 1, columnName: 'Title', columnType: 'TEXT' };
    const tabbed: FakeTab = {
      ...queue(),
      tables: [tableOf(7, [title, ownerDropdown(['Ana', 'Bruno'])])],
    };
    const same = await planAndApply(
      await google({ tabs: [tabbed], version: '1' }, memoryCache(), {
        Queue: { table: 'QueueTable', dropdowns: { Owner: ['Ana', 'Bruno'] } },
      }),
      MOVE_STEP,
      sameRows(),
    );
    expect(same.plan?.operations).toEqual([]);

    const sheet = await google({ tabs: [tabbed], version: '1' }, memoryCache(), {
      Queue: { table: 'QueueTable', dropdowns: { Owner: ['Ana', 'Bruno', 'Clara'] } },
    });
    const changed = await planAndApply(sheet, MOVE_STEP, sameRows());
    expect(changed.plan === undefined ? [] : formats(changed.plan)).toEqual([
      "format the tab 'Queue': the dropdown of Owner: Ana, Bruno, Clara",
    ]);
    expect(lastBatch(sheet).map((each) => Object.keys(each)[0])).toEqual(['updateTable']);
    expect(lastBatch(sheet)[0]?.['updateTable']?.['fields']).toBe('columnProperties');
    // fields: columnProperties replaces the list, so the other column goes back as it was.
    expect(tabNamed(sheet, 'Queue')?.tables?.[0]?.columnProperties).toEqual([
      title,
      ownerDropdown(['Ana', 'Bruno', 'Clara']),
    ]);
  });

  it('leaves a cell dropdown untouched while its values are the same, outside a table', async () => {
    const ruled: FakeTab = { ...queue(), validation: { 2: ['Ana', 'Bruno'] } };
    const same = await planAndApply(
      await google({ tabs: [ruled], version: '1' }, memoryCache(), {
        Queue: { dropdowns: { Owner: ['Ana', 'Bruno'] } },
      }),
      MOVE_STEP,
      sameRows(),
    );
    expect(same.plan?.operations).toEqual([]);

    const sheet = await google({ tabs: [ruled], version: '1' }, memoryCache(), {
      Queue: { dropdowns: { Owner: ['Bruno', 'Ana'] } },
    });
    await planAndApply(sheet, MOVE_STEP, sameRows());
    expect(batches(sheet)).toEqual([['setDataValidation']]);
    expect(tabNamed(sheet, 'Queue')?.validation?.[2]).toEqual(['Bruno', 'Ana']);
  });

  it('shows settings naming a column the tab lacks as a format that will fail', async () => {
    const sheet = await google({ tabs: [queue()], version: '1' }, memoryCache(), {
      queue: { dropdowns: { Status: ['Open'] } },
    });
    const answer = await planAndApply(sheet, MOVE_STEP, sameRows());
    expect(answer.plan?.operations.map((each) => [each.write, each.payload])).toEqual([
      [
        'format-tab',
        {
          x:
            "E_GOOGLE_CONFIG: the settings give 'Status' a dropdown, and the tab has no such " +
            'column',
        },
      ],
    ]);
    expect(batches(sheet)).toEqual([]);
  });
});

describe('google.sheet-sync moves by copyPaste', () => {
  const step = 'google.sheet-sync tab=Queue key=ID move=Filed keep=Notes';

  it("carries a formula and a link that is not a web one, in the move's one batchUpdate", async () => {
    const tab: FakeTab = {
      ...queue(),
      formulas: { C6: '=PROPER("enzo")' },
      links: { B6: { uri: 'ftp://files.example.com/ship', place: 'run' } },
    };
    const sheet = await google({ tabs: [tab], version: '1' });
    const answer = await planAndApply(sheet, step, input([['EX-5', 'Ship', 'Enzo', 'Shipped']]));
    const move = answer.plan?.operations.find((each) => each.write === 'move');
    expect(move?.payload).toMatchObject({
      t: 'Shipped',
      m: [
        [0, 0],
        [1, 1],
        [2, 2],
        [3, 3],
      ],
    });
    expect(move?.payload).not.toHaveProperty('u');
    expect(answer.applied?.every((each) => each.status === 'applied')).toBe(true);
    expect(batches(sheet)).toEqual([
      [
        'add tab',
        'cells 6:1:0',
        'copy 6 to 6:2',
        'delete row 7',
        'delete row 6',
        'delete row 4',
        'delete row 3',
        'delete row 2',
      ],
    ]);
    const shipped = tabNamed(sheet, 'Shipped');
    expect(shipped?.values[1]).toEqual(['EX-5', 'Ship', 'Enzo', 'draft ok']);
    expect(shipped?.formulas).toEqual({ C2: '=PROPER("enzo")' });
    expect(shipped?.links?.['B2']?.uri).toBe('ftp://files.example.com/ship');
  });

  it('writes the cells the table changes over the row before copying it', async () => {
    const sheet = await google({ tabs: [queue()], version: '1' });
    const answer = await planAndApply(
      sheet,
      step,
      input([['EX-5', 'Shipped it', 'Enzo', 'Shipped']]),
    );
    expect(answer.plan?.operations.find((each) => each.write === 'move')?.description).toBe(
      "move EX-5 (row 6) to the tab 'Shipped', writing Title: Ship → Shipped it",
    );
    expect(batches(sheet)[0]?.slice(0, 4)).toEqual([
      'add tab',
      'cells 6:1:0',
      'cells 5:6:1',
      'copy 6 to 6:2',
    ]);
    expect(tabNamed(sheet, 'Shipped')?.values[1]).toEqual([
      'EX-5',
      'Shipped it',
      'Enzo',
      'draft ok',
    ]);
  });

  it('grows a full tab before copying into it, and stretches its table over the copy', async () => {
    // copyPaste never grows a grid: a tab with no free row needs one added first.
    const shipped: FakeTab = {
      sheetId: 11,
      title: 'Shipped',
      values: [
        ['ID', 'Title', 'Owner', 'Notes'],
        ['EX-0', 'Earlier', 'Zoe', ''],
      ],
      rowCount: 2,
      tables: [
        {
          tableId: 'ts',
          name: 'ShippedTable',
          range: {
            sheetId: 11,
            startRowIndex: 0,
            endRowIndex: 2,
            startColumnIndex: 0,
            endColumnIndex: 4,
          },
        },
      ],
    };
    const sheet = await google({ tabs: [queue(), shipped], version: '1' }, memoryCache(), {
      Shipped: { table: 'ShippedTable' },
    });
    const answer = await planAndApply(sheet, step, input([['EX-5', 'Ship', 'Enzo', 'Shipped']]));
    expect(answer.plan?.operations.at(-1)?.description).toBe(
      "format the tab 'Shipped': stretch its table over rows 1 to 3",
    );
    expect(answer.applied?.every((each) => each.status === 'applied')).toBe(true);
    const kinds = batches(sheet)[0] ?? [];
    expect(kinds.indexOf('appendDimension')).toBeLessThan(kinds.indexOf('copy 6 to 11:3'));
    expect(tabNamed(sheet, 'Shipped')?.values[2]).toEqual(['EX-5', 'Ship', 'Enzo', 'draft ok']);
    expect(tabNamed(sheet, 'Shipped')?.tables?.[0]?.range['endRowIndex']).toBe(3);
  });

  it("fails a move when its tab's header changed since the plan, and copies nothing", async () => {
    const shipped: FakeTab = {
      sheetId: 11,
      title: 'Shipped',
      values: [['ID', 'Title', 'Owner', 'Notes']],
    };
    const sheet = await google({ tabs: [queue(), shipped], version: '1' });
    const answer = await planAndApply(
      sheet,
      step,
      input([['EX-5', 'Ship', 'Enzo', 'Shipped']]),
      () => {
        // A person swaps two columns: the plan's places would put the title under Owner.
        const header = tabNamed(sheet, 'Shipped')?.values[0];
        if (header !== undefined) [header[1], header[2]] = ['Owner', 'Title'];
      },
    );
    const move = answer.plan?.operations.findIndex((each) => each.write === 'move') ?? -1;
    expect(answer.applied?.[move]).toEqual({
      status: 'failed',
      reason:
        "E_GOOGLE_CHANGED: the header of the tab 'Shipped' changed since the plan; run the " +
        'cell again for a new plan',
    });
    expect(batches(sheet)[0]?.some((kind) => kind.startsWith('copy'))).toBe(false);
    expect(tabNamed(sheet, 'Queue')?.values.map((row) => row[0])).toContain('EX-5');
  });
});

describe('google.sheet-sync tab settings', () => {
  const where = 'tabs.Queue in the google section of .tyto/project.json';
  it.each([
    ['not an object', ['Status'], `${where} is not an object`],
    ['an unknown key', { colour: '#FFFFFF' }, `${where} holds colour, which is none of`],
    ['a table name with -', { table: 'Queue-2026' }, "the table name 'Queue-2026' may hold"],
    ['a header that is no colour', { header: 'green' }, 'header is not a colour such as'],
    ['an empty dropdown', { dropdowns: { Status: [] } }, 'dropdowns.Status is not a list'],
    ['a repeated value', { dropdowns: { Status: ['a', 'a'] } }, 'dropdowns.Status is not a'],
  ])('refuses %s', (_, settings, words) => {
    expect(tabSettingsOf({ tabs: { Queue: settings } }, 'Queue')).toEqual(
      expect.stringContaining(words),
    );
  });

  it('reads a tab by its name ignoring case, and names a table from the tab', () => {
    expect(
      tabSettingsOf({ tabs: { 'queue 2026': { table: true, header: '#d9ead3' } } }, 'Queue 2026'),
    ).toEqual({
      table: 'Table_Queue_2026',
      header: '#D9EAD3',
      dropdowns: [],
    });
    expect(tabSettingsOf({ tabs: { Other: {} } }, 'Queue')).toBeUndefined();
    expect(tabSettingsOf(undefined, 'Queue')).toBeUndefined();
  });
});

describe('google.sheet-sync link drift', () => {
  it('fails a row whose link changed between the plan and Apply', async () => {
    const linked = (): FakeTab => ({
      ...queue(),
      links: { B2: { uri: 'https://tasks.example.com/1', place: 'run' } },
    });
    const step = 'google.sheet-sync tab=Queue key=ID move=Filed keep=Notes';
    const table = () =>
      input([
        ['EX-1', 'Old title', 'Zoe', ''],
        ['EX-2', 'Same', 'Bruno', ''],
        ['EX-4', 'Kept', 'Dora', ''],
        ['EX-5', 'Ship', 'Enzo', ''],
      ]);

    // Control: the same plan with the link left alone is written.
    const control = await google({ tabs: [linked()], version: '1' });
    const untouched = await planAndApply(control, step, table());
    expect(untouched.applied?.every((each) => each.status === 'applied')).toBe(true);

    const sheet = await google({ tabs: [linked()], version: '1' });
    const answer = await planAndApply(sheet, step, table(), () => {
      const tab = tabNamed(sheet, 'Queue');
      if (tab?.links !== undefined) tab.links['B2'] = { uri: 'https://elsewhere.example.com/1' };
    });
    expect(answer.applied?.[0]).toEqual({
      status: 'failed',
      reason:
        'E_GOOGLE_CHANGED: EX-1 (row 2): the row changed since the plan; run the cell again ' +
        'for a new plan',
    });
    expect(tabNamed(sheet, 'Queue')?.values[1]?.[2]).toBe('Ana');
  });
});
