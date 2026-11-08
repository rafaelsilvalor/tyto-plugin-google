import { readSection } from './config.js';
import { googleError, googleOk, type GoogleResult } from './errors.js';
import type { GoogleClient } from './http.js';
import { columnLetter } from './sheet-grid.js';
import { quotedTitle, type Tab } from './sheet-snapshot.js';
import type { JsonValue } from './verb.js';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

/**
 * How one tab looks, from `google.tabs.<tab>` in `.tyto/project.json`:
 *
 * ```json
 * { "table": "QueueTable", "header": "#D9EAD3", "dropdowns": { "Status": ["To do", "Done"] } }
 * ```
 *
 * - `table`: a native table (Format › Convert to table) over the header and every row, by this
 *   name, or `true` for `Table_<tab>`. Names take letters, digits and `_` only, and are unique
 *   in the spreadsheet (Buraqueira, 2026-08).
 * - `header`: row 1's background colour, as `#RRGGBB`.
 * - `dropdowns`: per column, the values its dropdown offers.
 */
export interface TabSettings {
  readonly table?: string;
  readonly header?: string;
  readonly dropdowns: readonly (readonly [string, readonly string[]])[];
}

/** What a `format-tab` operation asks for, as its payload carries it. */
export interface FormatWant {
  /** The tab's header names when planned: the columns' places, checked again on Apply. */
  readonly c: readonly string[];
  /** The table's name, when the settings ask for one. */
  readonly n?: string;
  /** The header colour, `#RRGGBB`. */
  readonly b?: string;
  /** Per column index, the dropdown's values. */
  readonly v?: readonly (readonly [number, readonly string[]])[];
}

interface GridRange {
  readonly sheetId?: number;
  readonly startRowIndex?: number;
  readonly endRowIndex?: number;
  readonly startColumnIndex?: number;
  readonly endColumnIndex?: number;
}

/** How a tab looks now, as far as the settings reach. */
export interface TabFormat {
  readonly table?: {
    readonly tableId: string;
    readonly range: GridRange;
    readonly columnProperties: readonly Readonly<Record<string, unknown>>[];
  };
  readonly banded: readonly number[];
  /** Per column of row 1, its background as `#RRGGBB`, or `undefined` when it has none. */
  readonly header: readonly (string | undefined)[];
  /** Per column, the values of the `ONE_OF_LIST` rule row 2 holds, if any. */
  readonly validation: readonly (readonly string[] | undefined)[];
}

/** A tab that does not exist yet: no table, no colour, no rule. */
export const NEW_TAB: TabFormat = { banded: [], header: [], validation: [] };

const HEX = /^#[0-9A-Fa-f]{6}$/;
const TABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
const MAX_DROPDOWN_VALUES = 500;

/** The tab's settings, `undefined` when the section names none for it, or what is wrong. */
export function tabSettingsOf(section: unknown, title: string): TabSettings | undefined | string {
  const read = readSection(section);
  if (!read.ok) return read.error.message;
  const tabs = read.value.tabs ?? {};
  const name =
    title in tabs
      ? title
      : Object.keys(tabs).find((each) => each.toLowerCase() === title.toLowerCase());
  if (name === undefined) return undefined;
  const where = `tabs.${name} in the google section of .tyto/project.json`;
  const value = tabs[name];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return `${where} is not an object`;
  }
  const record = value as Readonly<Record<string, unknown>>;
  const unknown = Object.keys(record).filter(
    (key) => !['table', 'header', 'dropdowns'].includes(key),
  );
  if (unknown.length > 0) {
    return `${where} holds ${unknown.join(', ')}, which is none of table, header, dropdowns`;
  }

  let table: string | undefined;
  if (record['table'] === true) table = `Table_${title.replace(/[^A-Za-z0-9_]/g, '_')}`;
  else if (typeof record['table'] === 'string') table = record['table'];
  else if (record['table'] !== undefined && record['table'] !== false) {
    return `${where}: table is neither a name nor true`;
  }
  if (table !== undefined && !TABLE_NAME.test(table)) {
    return `${where}: the table name '${table}' may hold only letters, digits and _`;
  }

  const header = record['header'];
  if (header !== undefined && (typeof header !== 'string' || !HEX.test(header))) {
    return `${where}: header is not a colour such as #D9EAD3`;
  }

  const dropdowns: [string, string[]][] = [];
  const asked = record['dropdowns'] ?? {};
  if (typeof asked !== 'object' || asked === null || Array.isArray(asked)) {
    return `${where}: dropdowns is not an object of column names`;
  }
  for (const [column, values] of Object.entries(asked as Record<string, unknown>)) {
    const list = Array.isArray(values) ? (values as unknown[]) : [];
    const valid =
      list.length > 0 &&
      list.length <= MAX_DROPDOWN_VALUES &&
      list.every((each) => typeof each === 'string' && each.trim() !== '') &&
      new Set(list).size === list.length;
    if (!valid) {
      return (
        `${where}: dropdowns.${column} is not a list of 1 to ${MAX_DROPDOWN_VALUES} different, ` +
        'non-blank texts'
      );
    }
    dropdowns.push([column, list as string[]]);
  }
  return {
    ...(table === undefined ? {} : { table }),
    ...(typeof header === 'string' ? { header: header.toUpperCase() } : {}),
    dropdowns,
  };
}

/** The settings over a header, or which dropdown column the header lacks. */
export function wantOf(settings: TabSettings, names: readonly string[]): FormatWant | string {
  const v: [number, readonly string[]][] = [];
  for (const [column, values] of settings.dropdowns) {
    const at = names.findIndex((name) => name.toLowerCase() === column.toLowerCase());
    if (at < 0) return `the settings give '${column}' a dropdown, and the tab has no such column`;
    v.push([at, values]);
  }
  return {
    c: names,
    ...(settings.table === undefined ? {} : { n: settings.table }),
    ...(settings.header === undefined ? {} : { b: settings.header }),
    ...(v.length === 0 ? {} : { v }),
  };
}

/** A `format-tab` payload's fields, checked, or `undefined`. */
export function readWant(object: Readonly<Record<string, JsonValue>>): FormatWant | undefined {
  const { c, n, b, v } = object;
  if (!Array.isArray(c) || c.length === 0 || !c.every((name) => typeof name === 'string')) {
    return undefined;
  }
  if (n !== undefined && (typeof n !== 'string' || !TABLE_NAME.test(n))) return undefined;
  if (b !== undefined && (typeof b !== 'string' || !HEX.test(b))) return undefined;
  const dropdowns: [number, string[]][] = [];
  for (const each of v === undefined ? [] : Array.isArray(v) ? v : [null]) {
    if (!Array.isArray(each) || each.length !== 2) return undefined;
    const [at, values] = each;
    if (
      typeof at !== 'number' ||
      !Number.isSafeInteger(at) ||
      at < 0 ||
      at >= c.length ||
      !Array.isArray(values) ||
      !values.every((value) => typeof value === 'string')
    ) {
      return undefined;
    }
    dropdowns.push([at, values as string[]]);
  }
  return {
    c: c as string[],
    ...(n === undefined ? {} : { n }),
    ...(b === undefined ? {} : { b }),
    ...(dropdowns.length === 0 ? {} : { v: dropdowns }),
  };
}

/**
 * How the tab looks, in one `spreadsheets.get` over rows 1 and 2: its first native table, its
 * alternating colours, row 1's backgrounds and row 2's dropdown rules.
 */
export async function readTabFormat(
  client: GoogleClient,
  spreadsheetId: string,
  tab: Tab,
  width: number,
): Promise<GoogleResult<TabFormat>> {
  const answer = await client.get(`${SHEETS}/${encodeURIComponent(spreadsheetId)}`, {
    ranges: [`${quotedTitle(tab.title)}!A1:${columnLetter(Math.max(0, width - 1))}2`],
    fields:
      'sheets(properties(sheetId),tables(tableId,range,columnProperties),' +
      'bandedRanges(bandedRangeId),' +
      'data(rowData(values(userEnteredFormat(backgroundColor),dataValidation))))',
  });
  if (!answer.ok) return answer;
  const sheets = listOf(recordOf(answer.value)?.['sheets']);
  const sheet =
    sheets.map(recordOf).find((each) => {
      return recordOf(each?.['properties'])?.['sheetId'] === tab.sheetId;
    }) ?? recordOf(sheets[0]);
  if (sheet === undefined) {
    return googleError(
      'E_GOOGLE_RESPONSE',
      `Google answered the tab '${tab.title}' with no sheet.`,
    );
  }
  const first = recordOf(listOf(sheet['tables'])[0]);
  const tableId = first?.['tableId'];
  const rows = listOf(recordOf(listOf(sheet['data'])[0])?.['rowData']).map((row) =>
    listOf(recordOf(row)?.['values']).map(recordOf),
  );
  return googleOk({
    ...(typeof tableId === 'string'
      ? {
          table: {
            tableId,
            range: (recordOf(first?.['range']) ?? {}) as GridRange,
            columnProperties: listOf(first?.['columnProperties']).flatMap((each) => {
              const property = recordOf(each);
              return property === undefined ? [] : [property];
            }),
          },
        }
      : {}),
    banded: listOf(sheet['bandedRanges']).flatMap((each) => {
      const id = recordOf(each)?.['bandedRangeId'];
      return typeof id === 'number' ? [id] : [];
    }),
    header: (rows[0] ?? []).map((cell) =>
      hexOf(recordOf(recordOf(cell?.['userEnteredFormat'])?.['backgroundColor'])),
    ),
    validation: (rows[1] ?? []).map((cell) => listValues(recordOf(cell?.['dataValidation']))),
  });
}

/**
 * The requests that make the tab look as `want` asks, with `lastRow` its last row (from 1)
 * once the batch is written, and one line per change for a person. None when it looks so.
 *
 * - **A table is added only after the tab's alternating colours are removed**, because Sheets
 *   refuses `addTable` over a banded range (Buraqueira, 2026-08); an existing table only has its
 *   range stretched with `updateTable`.
 * - **A dropdown is rewritten only when its values change**: rewriting it drops the colours a
 *   person gave its options (Buraqueira, 2026-10-02). In a table it is the column's
 *   `columnProperties`, because Sheets refuses a cell rule in a typed column.
 */
export function formatRequests(
  sheetId: number,
  want: FormatWant,
  now: TabFormat,
  lastRow: number,
): { readonly requests: unknown[]; readonly said: string[] } {
  const requests: unknown[] = [];
  const said: string[] = [];
  const width = want.c.length;
  const endRow = Math.max(2, lastRow);
  const range = {
    sheetId,
    startRowIndex: 0,
    endRowIndex: endRow,
    startColumnIndex: 0,
    endColumnIndex: width,
  };
  const changedDropdowns = (want.v ?? []).filter(([at, values]) => {
    const current = now.table === undefined ? now.validation[at] : tableValues(now.table, at);
    return !sameList(current, values);
  });
  const shownDropdowns = changedDropdowns.map(
    ([at, values]) => `the dropdown of ${want.c[at] ?? ''}: ${values.join(', ')}`,
  );

  if (now.table !== undefined) {
    const { table } = now;
    const stretch =
      want.n !== undefined &&
      (table.range.startRowIndex ?? 0) === 0 &&
      ((table.range.endRowIndex ?? 0) !== endRow ||
        (table.range.startColumnIndex ?? 0) !== 0 ||
        (table.range.endColumnIndex ?? 0) !== width);
    const fields = [
      ...(stretch ? ['range'] : []),
      ...(changedDropdowns.length > 0 ? ['columnProperties'] : []),
    ];
    if (fields.length > 0) {
      requests.push({
        updateTable: {
          table: {
            tableId: table.tableId,
            ...(stretch ? { range } : {}),
            ...(changedDropdowns.length > 0
              ? { columnProperties: mergedProperties(table, want, changedDropdowns) }
              : {}),
          },
          fields: fields.join(','),
        },
      });
      if (stretch) said.push(`stretch its table over rows 1 to ${endRow}`);
      said.push(...shownDropdowns);
    }
  } else if (want.n !== undefined) {
    for (const bandedRangeId of now.banded) requests.push({ deleteBanding: { bandedRangeId } });
    if (now.banded.length > 0) said.push(`remove its ${now.banded.length} alternating colours`);
    requests.push({
      addTable: {
        table: {
          name: want.n,
          range,
          ...((want.v ?? []).length > 0
            ? {
                columnProperties: (want.v ?? []).map(([at, values]) =>
                  dropdownProperty(at, want.c[at] ?? '', values),
                ),
              }
            : {}),
        },
      },
    });
    said.push(`add the table '${want.n}' over rows 1 to ${endRow}`);
    said.push(
      ...(want.v ?? []).map(
        ([at, values]) => `the dropdown of ${want.c[at] ?? ''}: ${values.join(', ')}`,
      ),
    );
  } else {
    for (const [at, values] of changedDropdowns) {
      requests.push({
        setDataValidation: {
          range: { sheetId, startRowIndex: 1, startColumnIndex: at, endColumnIndex: at + 1 },
          rule: { condition: listCondition(values), strict: false, showCustomUi: true },
        },
      });
    }
    said.push(...shownDropdowns);
  }

  if (want.b !== undefined && want.c.some((_, at) => now.header[at] !== want.b)) {
    requests.push({
      repeatCell: {
        range: {
          sheetId,
          startRowIndex: 0,
          endRowIndex: 1,
          startColumnIndex: 0,
          endColumnIndex: width,
        },
        cell: { userEnteredFormat: { backgroundColor: colourOf(want.b) } },
        fields: 'userEnteredFormat.backgroundColor',
      },
    });
    said.push(`colour its header ${want.b}`);
  }
  return { requests, said };
}

function mergedProperties(
  table: NonNullable<TabFormat['table']>,
  want: FormatWant,
  changed: readonly (readonly [number, readonly string[]])[],
): Readonly<Record<string, unknown>>[] {
  // `fields: columnProperties` replaces the whole list, so the others go back as they were.
  const start = table.range.startColumnIndex ?? 0;
  const properties = table.columnProperties.map((each) => ({ ...each }));
  for (const [at, values] of changed) {
    const index = at - start;
    const property = dropdownProperty(index, want.c[at] ?? '', values);
    const found = properties.findIndex((each) => (each['columnIndex'] ?? 0) === index);
    if (found < 0) properties.push(property);
    else properties[found] = { ...properties[found], ...property };
  }
  return properties;
}

function dropdownProperty(
  columnIndex: number,
  columnName: string,
  values: readonly string[],
): Readonly<Record<string, unknown>> {
  // A table column's rule takes only the condition: `strict` and `showCustomUi` are refused
  // there ("Unknown name strict", Buraqueira, 2026-10-02).
  return {
    columnIndex,
    columnName,
    columnType: 'DROPDOWN',
    dataValidationRule: { condition: listCondition(values) },
  };
}

function listCondition(values: readonly string[]): unknown {
  return { type: 'ONE_OF_LIST', values: values.map((value) => ({ userEnteredValue: value })) };
}

function tableValues(
  table: NonNullable<TabFormat['table']>,
  at: number,
): readonly string[] | undefined {
  const index = at - (table.range.startColumnIndex ?? 0);
  const property = table.columnProperties.find((each) => (each['columnIndex'] ?? 0) === index);
  if (property?.['columnType'] !== 'DROPDOWN') return undefined;
  return listValues(recordOf(property['dataValidationRule']));
}

function listValues(rule: Readonly<Record<string, unknown>> | undefined): string[] | undefined {
  const condition = recordOf(rule?.['condition']);
  if (condition?.['type'] !== 'ONE_OF_LIST') return undefined;
  return listOf(condition['values']).map((each) =>
    String(recordOf(each)?.['userEnteredValue'] ?? ''),
  );
}

function sameList(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return a !== undefined && a.length === b.length && a.every((value, index) => value === b[index]);
}

/** `#RRGGBB` of a Sheets colour, whose channels Google leaves out when they are 0. */
function hexOf(colour: Readonly<Record<string, unknown>> | undefined): string | undefined {
  if (colour === undefined) return undefined;
  const channel = (name: string): string => {
    const value = colour[name];
    const byte = Math.round((typeof value === 'number' ? value : 0) * 255);
    return Math.min(255, Math.max(0, byte)).toString(16).padStart(2, '0');
  };
  return `#${channel('red')}${channel('green')}${channel('blue')}`.toUpperCase();
}

function colourOf(hex: string): { red: number; green: number; blue: number } {
  const channel = (at: number): number => parseInt(hex.slice(at, at + 2), 16) / 255;
  return { red: channel(1), green: channel(3), blue: channel(5) };
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}
