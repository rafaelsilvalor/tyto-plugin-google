import { readFileSync } from 'node:fs';

import type { FetchedResponse, HostCapabilities, HostFetchInit } from '@tyto/plugin-api';
import { testPlugin, type PluginHarness } from '@tyto/plugin-api/testing';

import { response } from './host.js';
import { testClock, testKey, tokenEndpoint, type TestKey } from './google.js';

/**
 * A synthetic spreadsheet for `google.sheet-rows`, answered through the contract's own
 * harness: the committed `dist/index.js`, activated over the isolation protocol, with the
 * manifest's permissions in front of every request. Nothing here is a real file or person.
 */
const manifest = readFileSync(new URL('../tyto-plugin.json', import.meta.url), 'utf8');
const entry = new URL('../dist/index.js', import.meta.url).href;

export const SPREADSHEET_ID = 'sheet0123456789abcdef';
export const SPREADSHEET_URL = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`;

/** Where a cell's link lives, as Sheets answers it. */
export type LinkPlace = 'hyperlink' | 'run' | 'format';

export interface FakeTab {
  readonly sheetId: number;
  title: string;
  values: unknown[][];
  /** By A1 cell, such as `B2`. */
  links?: Record<string, { readonly uri: string; readonly place?: LinkPlace }>;
  notes?: Record<string, string>;
  /** The grid's size, 1,000 by 26 when left out, as a new tab's. */
  rowCount?: number;
  columnCount?: number;
  /** By A1 cell, the formula a cell holds; `values` holds what it shows. */
  formulas?: Record<string, string>;
  /** Native tables, as `spreadsheets.get` answers `tables`. */
  tables?: FakeTable[];
  /** Ids of the tab's alternating colours. */
  banded?: number[];
  /** By column, row 1's background. */
  headerColours?: Record<number, { red?: number; green?: number; blue?: number }>;
  /** By column, the values of the dropdown rule set on the column from row 2. */
  validation?: Record<number, string[]>;
}

export interface FakeTable {
  tableId: string;
  name: string;
  range: Record<string, number>;
  columnProperties?: Record<string, unknown>[];
}

export interface FakeSpreadsheet {
  tabs: FakeTab[];
  /** The spreadsheet's locale, `en_US` when left out. */
  locale?: string;
  /** Drive's `version`; a string, as Drive answers it. */
  version: string;
  /** Drive's answer to the version, when a test wants it to fail. */
  driveFailure?: FetchedResponse;
  /** Answers to the next batchUpdates, in order, in place of writing them. */
  batchFailures?: FetchedResponse[];
  /** Request kinds a batchUpdate is refused for, whole, as Google refuses a bad request. */
  refuseKinds?: string[];
}

export interface SheetCall {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string | string[]>>;
  /** The JSON body, parsed, when the call sent one. */
  readonly body?: unknown;
}

export interface FakeGoogle {
  readonly plugin: PluginHarness;
  readonly calls: SheetCall[];
  /** Every Sheets and Drive request's `Authorization` header, in order: whose token signed it. */
  readonly bearers: string[];
  /** How many times the service account's token was asked for at Google's token endpoint. */
  readonly assertions: { count: number };
  readonly sheet: FakeSpreadsheet;
}

let key: TestKey | undefined;

export async function fakeGoogle(
  sheet: FakeSpreadsheet,
  options: {
    readonly section?: unknown;
    readonly capabilities?: Partial<HostCapabilities>;
    /**
     * Left out, the host is the command line's: it has no sign-in port, so the plugin acts as
     * the service account. Given, it is the desktop's, with these people signed in (`{}` for
     * nobody), and the plugin acts as the person.
     */
    readonly signins?: Readonly<Record<string, string>>;
    /** Whether a service account is stored; `true` when left out. */
    readonly serviceAccount?: boolean;
  } = {},
): Promise<FakeGoogle> {
  key ??= await testKey();
  const endpoint = tokenEndpoint(key.publicKey, testClock(Date.now()));
  const calls: SheetCall[] = [];
  const bearers: string[] = [];
  const assertions = { count: 0 };
  const loaded = await testPlugin({
    manifest,
    load: () => import(entry),
    secrets: options.serviceAccount === false ? {} : { 'service-account': key.json },
    ...(options.section === undefined ? {} : { section: options.section }),
    ...(options.signins === undefined ? {} : { signins: options.signins }),
    capabilities: {
      ...(options.signins === undefined ? withoutSigninPort() : {}),
      ...options.capabilities,
    },
    async fetch(url: string, init: HostFetchInit) {
      const parsed = new URL(url);
      if (parsed.host === 'oauth2.googleapis.com') {
        assertions.count += 1;
        const answer = await endpoint.answer(init);
        return response(answer.status, await answer.text());
      }
      bearers.push(String(init.headers?.['Authorization'] ?? ''));
      const query: Record<string, string | string[]> = {};
      for (const name of new Set(parsed.searchParams.keys())) {
        const all = parsed.searchParams.getAll(name);
        query[name] = all.length === 1 ? (all[0] ?? '') : all;
      }
      const call: SheetCall = {
        method: init.method ?? 'GET',
        host: parsed.host,
        path: decodeURIComponent(parsed.pathname),
        query,
        ...(typeof init.body === 'string' ? { body: JSON.parse(init.body) as unknown } : {}),
      };
      calls.push(call);
      return answerOf(sheet, call);
    },
  });
  if (!loaded.ok) {
    throw new Error(loaded.error.map((item) => `${item.code}: ${item.message}`).join('\n'));
  }
  return { plugin: loaded.value, calls, bearers, assertions, sheet };
}

/**
 * The command line's host: no `signinAccessToken` port, so `host.signin` answers
 * `E_SIGNIN_UNAVAILABLE`, as `tyto recipe run` and `tyto mcp` do.
 */
export function withoutSigninPort(): Partial<HostCapabilities> {
  return { signinAccessToken: undefined } as unknown as Partial<HostCapabilities>;
}

function answerOf(sheet: FakeSpreadsheet, call: SheetCall): FetchedResponse {
  if (call.host === 'www.googleapis.com' && call.path === `/drive/v3/files/${SPREADSHEET_ID}`) {
    return sheet.driveFailure ?? response(200, { version: sheet.version });
  }
  const base = `/v4/spreadsheets/${SPREADSHEET_ID}`;
  if (call.host !== 'sheets.googleapis.com') throw new Error(`no fake answers ${call.path}`);
  if (call.path === base && call.query['fields'] === 'sheets.properties(sheetId,title)') {
    return response(200, {
      sheets: sheet.tabs.map((tab) => ({ properties: { sheetId: tab.sheetId, title: tab.title } })),
    });
  }
  if (call.path === base && String(call.query['fields']).includes('gridProperties')) {
    return response(200, {
      ...(String(call.query['fields']).includes('properties.locale')
        ? { properties: { locale: sheet.locale ?? 'en_US' } }
        : {}),
      sheets: sheet.tabs.map((tab) => ({
        properties: {
          sheetId: tab.sheetId,
          title: tab.title,
          gridProperties: { rowCount: rowsOf(tab), columnCount: tab.columnCount ?? 26 },
        },
      })),
    });
  }
  if (call.method === 'POST' && call.path === `${base}:batchUpdate`) {
    return sheet.batchFailures?.shift() ?? batchUpdate(sheet, call.body);
  }
  if (call.path.startsWith(`${base}/values/`)) {
    const range = call.path.slice(`${base}/values/`.length);
    const rows = /^(.*)!(\d+):(\d+)$/.exec(range);
    if (rows !== null) {
      const tab = tabOf(sheet, rows[1] ?? '');
      const from = Number(rows[2]);
      const slice = tab.values.slice(from - 1, Number(rows[3]));
      while (slice.length > 0 && (slice.at(-1) ?? []).every((cell) => cell === '')) slice.pop();
      return response(200, { range, majorDimension: 'ROWS', values: slice });
    }
    const tab = tabOf(sheet, range);
    return response(200, { range: tab.title, majorDimension: 'ROWS', values: tab.values });
  }
  if (call.path === base && String(call.query['fields']).includes('tables(')) {
    return response(200, formatOf(sheet, call));
  }
  if (call.path === base && call.query['ranges'] !== undefined) {
    return response(200, extrasOf(sheet, call));
  }
  throw new Error(`no fake answers ${call.method} ${call.path}`);
}

function rowsOf(tab: FakeTab): number {
  return tab.rowCount ?? 1000;
}

/**
 * `spreadsheets.batchUpdate` over the fake, as Google runs it: every request in order on a
 * copy, kept only when all of them succeed. A cell written outside the grid is Google's 400.
 */
function batchUpdate(sheet: FakeSpreadsheet, body: unknown): FetchedResponse {
  const requests = (body as { requests: Record<string, Record<string, unknown>>[] }).requests;
  if (requests.some((request) => sheet.refuseKinds?.includes(Object.keys(request)[0] ?? ''))) {
    return response(400, {
      error: { code: 400, message: 'Invalid request.', status: 'INVALID_ARGUMENT' },
    });
  }
  const copies = new Map<number, FakeTab>();
  const created: FakeTab[] = [];
  const copyOf = (sheetId: unknown): FakeTab => {
    const found = [...sheet.tabs, ...created].find((tab) => tab.sheetId === sheetId);
    if (found === undefined) throw new Error(`no tab ${String(sheetId)}`);
    const copy = copies.get(found.sheetId) ?? structuredClone(found);
    copies.set(found.sheetId, copy);
    return copy;
  };
  for (const request of requests) {
    const [kind, detail] = Object.entries(request)[0] ?? [];
    if (kind === 'appendDimension' && detail !== undefined) {
      const tab = copyOf(detail['sheetId']);
      const length = Number(detail['length']);
      if (detail['dimension'] === 'ROWS') tab.rowCount = rowsOf(tab) + length;
      else tab.columnCount = (tab.columnCount ?? 26) + length;
      continue;
    }
    if (kind === 'addSheet' && detail !== undefined) {
      const properties = detail['properties'] as {
        sheetId: number;
        title: string;
        gridProperties: { rowCount: number; columnCount: number };
      };
      if ([...sheet.tabs, ...created].some((tab) => tab.title === properties.title)) {
        return response(400, {
          error: {
            code: 400,
            message: 'A sheet with that name exists.',
            status: 'INVALID_ARGUMENT',
          },
        });
      }
      const added: FakeTab = {
        sheetId: properties.sheetId,
        title: properties.title,
        values: [],
        ...properties.gridProperties,
      };
      created.push(added);
      continue;
    }
    if (kind === 'deleteDimension' && detail !== undefined) {
      const range = detail['range'] as { sheetId: number; startIndex: number; endIndex: number };
      const tab = copyOf(range.sheetId);
      tab.values.splice(range.startIndex, range.endIndex - range.startIndex);
      tab.rowCount = rowsOf(tab) - (range.endIndex - range.startIndex);
      tab.links = shifted(tab.links, range.startIndex, range.endIndex);
      tab.formulas = shifted(tab.formulas, range.startIndex, range.endIndex);
      continue;
    }
    if (kind === 'copyPaste' && detail !== undefined) {
      const failure = copyPaste(copyOf, detail);
      if (failure !== undefined) return failure;
      continue;
    }
    if (kind !== undefined && detail !== undefined && kind in FORMAT_REQUESTS) {
      const failure = FORMAT_REQUESTS[kind]?.(detail, [...sheet.tabs, ...created], copyOf);
      if (failure !== undefined) return failure;
      continue;
    }
    if (kind === 'appendCells' && detail !== undefined) {
      const tab = copyOf(detail['sheetId']);
      while (tab.values.length > 0 && (tab.values.at(-1) ?? []).every((cell) => cell === '')) {
        tab.values.pop();
      }
      const top = tab.values.length;
      const rows = detail['rows'] as { values: Record<string, unknown>[] }[];
      writeRows(tab, top, 0, rows);
      tab.rowCount = Math.max(rowsOf(tab), top + rows.length);
      continue;
    }
    if (kind !== 'updateCells' || detail === undefined) throw new Error(`unknown ${kind}`);
    const range = detail['range'] as Record<string, number>;
    const tab = copyOf(range['sheetId']);
    const rows = detail['rows'] as { values: Record<string, unknown>[] }[] | undefined;
    if (rows === undefined) {
      tab.values = [];
      tab.links = {};
      continue;
    }
    const top = range['startRowIndex'] ?? 0;
    if (
      top + rows.length > rowsOf(tab) ||
      (range['endColumnIndex'] ?? 0) > (tab.columnCount ?? 26)
    ) {
      return response(400, {
        error: { code: 400, message: 'Range exceeds grid limits.', status: 'INVALID_ARGUMENT' },
      });
    }
    writeRows(tab, top, range['startColumnIndex'] ?? 0, rows);
  }
  for (const tab of created) copyOf(tab.sheetId);
  for (const copy of copies.values()) {
    const index = sheet.tabs.findIndex((tab) => tab.sheetId === copy.sheetId);
    if (index < 0) sheet.tabs.push(copy);
    else sheet.tabs[index] = copy;
  }
  return response(200, { spreadsheetId: SPREADSHEET_ID, replies: requests.map(() => ({})) });
}

/** Cells written from `top` (a row index from 0) and `left`, as Sheets keeps them. */
function writeRows(
  tab: FakeTab,
  top: number,
  left: number,
  rows: readonly { values: Record<string, unknown>[] }[],
): void {
  rows.forEach((row, offset) => {
    while (tab.values.length < top + offset) tab.values.push([]);
    const values = tab.values[top + offset] ?? [];
    row.values.forEach((cell, index) => {
      const column = left + index;
      while (values.length < column) values.push('');
      const entered = (cell['userEnteredValue'] ?? {}) as Record<string, unknown>;
      values[column] =
        entered['stringValue'] ??
        entered['numberValue'] ??
        entered['boolValue'] ??
        entered['formulaValue'] ??
        '';
      const run = (cell['textFormatRuns'] as { format: { link?: { uri: string } } }[])?.[0];
      const at = a1(column, top + offset + 1);
      tab.links ??= {};
      if (run?.format.link !== undefined)
        tab.links[at] = { uri: run.format.link.uri, place: 'run' };
      else delete tab.links[at];
      const formula = entered['formulaValue'];
      if (typeof formula === 'string') (tab.formulas ??= {})[at] = formula;
      else delete tab.formulas?.[at];
    });
    while (values.length > 0 && values.at(-1) === '') values.pop();
    tab.values[top + offset] = values;
  });
}

/** `B2`: the fake reads one-letter columns only. */
function a1(column: number, row: number): string {
  return `${String.fromCharCode(65 + column)}${row}`;
}

/** A1-keyed cells once rows `start` to `end` (from 0, `end` excluded) are deleted. */
function shifted<T>(
  cells: Record<string, T> | undefined,
  start: number,
  end: number,
): Record<string, T> {
  const kept: Record<string, T> = {};
  for (const [at, value] of Object.entries(cells ?? {})) {
    const letter = at.replace(/[0-9]+$/, '');
    const row = Number(at.slice(letter.length)) - 1;
    if (row >= start && row < end) continue;
    kept[`${letter}${row >= end ? row - (end - start) + 1 : row + 1}`] = value;
  }
  return kept;
}

const exceeds = (): FetchedResponse =>
  response(400, {
    error: { code: 400, message: 'Range exceeds grid limits.', status: 'INVALID_ARGUMENT' },
  });

/** `copyPaste` of one row's cells, values, links and formulas, as `PASTE_NORMAL` copies them. */
function copyPaste(
  copyOf: (sheetId: unknown) => FakeTab,
  detail: Record<string, unknown>,
): FetchedResponse | undefined {
  const from = detail['source'] as Record<string, number>;
  const to = detail['destination'] as Record<string, number>;
  const source = copyOf(from['sheetId']);
  const target = copyOf(to['sheetId']);
  // copyPaste does not grow the grid (Buraqueira, 2026-08).
  if ((to['endRowIndex'] ?? 0) > rowsOf(target)) return exceeds();
  const row = from['startRowIndex'] ?? 0;
  const top = to['startRowIndex'] ?? 0;
  while (target.values.length <= top) target.values.push([]);
  const values = target.values[top] ?? [];
  const width = (from['endColumnIndex'] ?? 0) - (from['startColumnIndex'] ?? 0);
  for (let offset = 0; offset < width; offset += 1) {
    const column = (from['startColumnIndex'] ?? 0) + offset;
    const into = (to['startColumnIndex'] ?? 0) + offset;
    while (values.length < into) values.push('');
    values[into] = source.values[row]?.[column] ?? '';
    const link = source.links?.[a1(column, row + 1)];
    if (link === undefined) delete target.links?.[a1(into, top + 1)];
    else (target.links ??= {})[a1(into, top + 1)] = link;
    const formula = source.formulas?.[a1(column, row + 1)];
    if (formula === undefined) delete target.formulas?.[a1(into, top + 1)];
    else (target.formulas ??= {})[a1(into, top + 1)] = formula;
  }
  while (values.length > 0 && values.at(-1) === '') values.pop();
  target.values[top] = values;
  return undefined;
}

type FormatRequest = (
  detail: Record<string, unknown>,
  tabs: readonly FakeTab[],
  copyOf: (sheetId: unknown) => FakeTab,
) => FetchedResponse | undefined;

/** The requests that change how a tab looks, as Google runs them. */
const FORMAT_REQUESTS: Readonly<Record<string, FormatRequest>> = {
  deleteBanding(detail, tabs, copyOf) {
    const id = Number(detail['bandedRangeId']);
    const owner = tabs.find((tab) => tab.banded?.includes(id));
    if (owner === undefined) throw new Error(`no banded range ${id}`);
    const tab = copyOf(owner.sheetId);
    tab.banded = (tab.banded ?? []).filter((each) => each !== id);
    return undefined;
  },
  addTable(detail, _tabs, copyOf) {
    const table = detail['table'] as Omit<FakeTable, 'tableId'>;
    const tab = copyOf(table.range['sheetId']);
    // Google refuses a table over a range with alternating colours (Buraqueira, 2026-08).
    if ((tab.banded ?? []).length > 0) {
      return response(400, {
        error: { code: 400, message: 'Table overlaps banding.', status: 'INVALID_ARGUMENT' },
      });
    }
    tab.tables = [...(tab.tables ?? []), { ...table, tableId: `table-${tab.sheetId}` }];
    return undefined;
  },
  updateTable(detail, tabs, copyOf) {
    const table = detail['table'] as Partial<FakeTable>;
    const owner = tabs.find((tab) => tab.tables?.some((each) => each.tableId === table.tableId));
    if (owner === undefined) throw new Error(`no table ${String(table.tableId)}`);
    const found = copyOf(owner.sheetId).tables?.find((each) => each.tableId === table.tableId);
    if (found === undefined) return undefined;
    for (const field of String(detail['fields']).split(',')) {
      if (field === 'range' && table.range !== undefined) found.range = table.range;
      if (field === 'columnProperties') found.columnProperties = table.columnProperties ?? [];
    }
    return undefined;
  },
  setDataValidation(detail, _tabs, copyOf) {
    const range = detail['range'] as Record<string, number>;
    const rule = detail['rule'] as { condition: { values: { userEnteredValue: string }[] } };
    const tab = copyOf(range['sheetId']);
    tab.validation = {
      ...tab.validation,
      [range['startColumnIndex'] ?? 0]: rule.condition.values.map((each) => each.userEnteredValue),
    };
    return undefined;
  },
  repeatCell(detail, _tabs, copyOf) {
    const range = detail['range'] as Record<string, number>;
    const cell = detail['cell'] as { userEnteredFormat: { backgroundColor: object } };
    const tab = copyOf(range['sheetId']);
    tab.headerColours ??= {};
    for (let at = range['startColumnIndex'] ?? 0; at < (range['endColumnIndex'] ?? 0); at += 1) {
      tab.headerColours[at] = cell.userEnteredFormat.backgroundColor;
    }
    return undefined;
  },
};

/** `spreadsheets.get` for a tab's look: its tables, banding, row 1's colours, row 2's rules. */
function formatOf(sheet: FakeSpreadsheet, call: SheetCall): unknown {
  const [range = ''] = ([] as string[]).concat(call.query['ranges'] ?? []);
  const match = /^(.*)!A1:([A-Z])2$/.exec(range);
  if (match === null) throw new Error(`a format range the fake does not read: ${range}`);
  const tab = tabOf(sheet, match[1] ?? '');
  const columns = Array.from({ length: (match[2] ?? 'A').charCodeAt(0) - 64 }, (_, at) => at);
  const header = columns.map((at) => {
    const colour = tab.headerColours?.[at];
    return colour === undefined ? {} : { userEnteredFormat: { backgroundColor: colour } };
  });
  const rules = columns.map((at) => {
    const values = tab.validation?.[at];
    if (values === undefined) return {};
    const listed = values.map((userEnteredValue) => ({ userEnteredValue }));
    return { dataValidation: { condition: { type: 'ONE_OF_LIST', values: listed } } };
  });
  return {
    sheets: [
      {
        properties: { sheetId: tab.sheetId },
        ...(tab.tables === undefined ? {} : { tables: tab.tables }),
        ...(tab.banded === undefined
          ? {}
          : { bandedRanges: tab.banded.map((bandedRangeId) => ({ bandedRangeId })) }),
        data: [{ rowData: [{ values: header }, { values: rules }] }],
      },
    ],
  };
}

function tabOf(sheet: FakeSpreadsheet, quoted: string): FakeTab {
  const title = quoted.replace(/^'|'$/g, '').replace(/''/g, "'");
  const tab = sheet.tabs.find((each) => each.title === title);
  if (tab === undefined) throw new Error(`no tab ${quoted}`);
  return tab;
}

/** `spreadsheets.get` with ranges, answering only the fields the mask names, as Google does. */
function extrasOf(sheet: FakeSpreadsheet, call: SheetCall): unknown {
  const fields = String(call.query['fields']);
  const ranges = ([] as string[]).concat(call.query['ranges'] ?? []);
  const data = ranges.map((range) => {
    const match = /^(.*)!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
    if (match === null) throw new Error(`a range the fake does not read: ${range}`);
    const [, quoted = '', letter = 'A', from = '2', , to = '2'] = match;
    const tab = tabOf(sheet, quoted);
    const column = letter.charCodeAt(0) - 65;
    const rowData = [];
    for (let row = Number(from); row <= Number(to); row += 1) {
      const cell: Record<string, unknown> = {};
      const link = tab.links?.[`${letter}${row}`];
      const place = link?.place ?? 'hyperlink';
      if (link !== undefined && place === 'hyperlink' && fields.includes('hyperlink')) {
        cell['hyperlink'] = link.uri;
      }
      if (link !== undefined && place === 'run' && fields.includes('textFormatRuns')) {
        cell['textFormatRuns'] = [
          { format: {} },
          { startIndex: 2, format: { link: { uri: link.uri } } },
        ];
      }
      if (link !== undefined && place === 'format' && fields.includes('effectiveFormat')) {
        cell['effectiveFormat'] = { textFormat: { link: { uri: link.uri } } };
      }
      const note = tab.notes?.[`${letter}${row}`];
      if (note !== undefined && fields.includes('note')) cell['note'] = note;
      rowData.push(Object.keys(cell).length === 0 ? {} : { values: [cell] });
    }
    return { startRow: Number(from) - 1, startColumn: column, rowData };
  });
  return { sheets: [{ data }] };
}

/** What a one-step recipe answered: its table, or its diagnostics. */
export async function rows(google: FakeGoogle, step: string) {
  const run = await google.plugin.runRecipe(step);
  if (!run.ok) throw new Error(run.error.map((item) => item.message).join('\n'));
  const cell = run.value.cells[0];
  return {
    table: cell?.table,
    diagnostics: (cell?.diagnostics ?? []).map(({ code, message }) => ({ code, message })),
  };
}

/** `google.sheet-rows`'s `page`, called as the host's loop calls it. */
export function pageOf(google: FakeGoogle) {
  const verb = google.plugin.host.registry
    .recipeVerbs()
    .find((each) => each.id === 'google.sheet-rows');
  if (verb?.page === undefined) throw new Error('google.sheet-rows is not registered');
  return verb.page;
}

/** A host cache in memory. */
export interface MemoryCache {
  readonly capabilities: Partial<HostCapabilities>;
  readonly entries: Map<string, { bytes: Uint8Array; storedAt: string }>;
  entry(key: string): Record<string, unknown>;
}

export function memoryCache(): MemoryCache {
  const entries = new Map<string, { bytes: Uint8Array; storedAt: string }>();
  const now = () => new Date().toISOString();
  return {
    entries,
    capabilities: {
      cacheGet: async (_plugin, key) => entries.get(key),
      async cachePut(_plugin, key, bytes) {
        const storedAt = now();
        entries.set(key, { bytes, storedAt });
        return { storedAt };
      },
      cacheDelete: async (_plugin, key) => entries.delete(key),
      cacheList: async (_plugin, prefix) =>
        [...entries]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, { bytes, storedAt }]) => ({ key, storedAt, size: bytes.byteLength })),
    },
    entry(key) {
      const stored = entries.get(key);
      if (stored === undefined) throw new Error(`no cache entry ${key}`);
      return JSON.parse(new TextDecoder().decode(stored.bytes)) as Record<string, unknown>;
    },
  };
}

/** A small tab: a header and three people, every type of cell Sheets answers. */
export function peopleTab(): FakeTab {
  return {
    sheetId: 0,
    title: 'People',
    values: [
      ['Name', 'Age', 'Active', 'Joined', 'Code', 'Profile'],
      ['Ana', 31, true, '01/03/2026', 'A1', 'profile'],
      ['Bruno', 27, false, '15/04/2026', 7, 'profile'],
      ['Clara', '', true, '', 'C3', 'none'],
    ],
  };
}

/** The calls a run made to one kind of endpoint. */
export function callsTo(google: FakeGoogle, kind: 'tabs' | 'values' | 'extras' | 'version') {
  return google.calls.filter((call) => {
    if (kind === 'version') return call.host === 'www.googleapis.com';
    if (kind === 'values') return call.path.includes('/values/');
    if (call.host !== 'sheets.googleapis.com' || call.path.includes('/values/')) return false;
    return kind === 'extras'
      ? call.query['ranges'] !== undefined
      : call.query['ranges'] === undefined;
  });
}
