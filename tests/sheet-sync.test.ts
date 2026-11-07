import type { TestRecipeOptions } from '@tyto/plugin-api/testing';
import { afterEach, describe, expect, it } from 'vitest';

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
async function google(sheet: FakeSpreadsheet, cache = memoryCache()): Promise<FakeGoogle> {
  await open?.plugin.close();
  open = await fakeGoogle(sheet, {
    section: { spreadsheet: SPREADSHEET_URL },
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
        'append 10',
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
    expect(batches(sheet)[0]).toEqual(expect.arrayContaining(['append 10', 'delete row 6']));
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
