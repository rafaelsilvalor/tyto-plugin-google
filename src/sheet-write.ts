import type { PluginHost, RecipeVerbContribution } from '@tyto/plugin-api';

import { readSection, spreadsheetIdOf } from './config.js';
import { connect } from './connect.js';
import { fingerprint } from './cursor.js';
import { messageOf } from './errors.js';
import { headerOf } from './sheet-grid.js';
import {
  formulaSeparator,
  localFormula,
  shownCell,
  writeCellOf,
  type WriteCell,
  type WriteColumn,
} from './sheet-cells.js';
import { pickTab, readGridSpreadsheet, readValues } from './sheet-snapshot.js';
import { applySheetWrites, spillKey, systemClock, type WriteClock } from './sheet-write-apply.js';
import {
  argumentsProblem,
  verbFailed,
  type ArgumentSpec,
  type Diagnostic,
  type JsonValue,
  type PlanAnswer,
  type PlannedOperation,
  type PlanRequest,
  type Table,
} from './verb.js';

export const SHEET_WRITE = 'google.sheet-write';
export const CLEAR_WRITE = 'clear';
export const ROW_WRITE = 'write-row';

/**
 * The plan's ceilings, as `@tyto/recipe`'s `PLAN_LIMITS` holds them (Tyto ADR 0135, ADR 0170).
 * Written here rather than imported, so the bundle imports nothing.
 */
export const MAX_OPERATIONS = 10_000;
export const MAX_DESCRIPTION_LENGTH = 500;
export const MAX_PAYLOAD_BYTES = 2048;
/**
 * Past this many bytes a row's cells are kept in the plugin's cache instead of the payload,
 * which then names the entry: short of the ceiling, so the entry's name and digest still fit.
 */
export const SPILL_BYTES = 1800;
/** Cache entries of plans older than this are forgotten when a new plan is made. */
const PLAN_ENTRY_DAYS = 7;

const ARGUMENTS: readonly ArgumentSpec[] = [
  { name: 'spreadsheet', type: 'text' },
  { name: 'tab', type: 'text' },
  { name: 'mode', type: 'text', required: true, values: ['replace', 'append'] },
  { name: 'formulas', type: 'text' },
];

export type SheetWriteHost = Pick<PluginHost, 'credentials' | 'fetch' | 'cache' | 'log'>;

/**
 * `google.sheet-write tab=<tab> mode=replace|append [formulas=<columns>]`: writes the table into
 * one tab of a spreadsheet, as a plan a person applies.
 *
 * `mode=replace` clears the tab's values and links and writes the table's column names in row
 * 1 and its rows under them. `mode=append` writes the rows under the last row that holds
 * anything, each cell under the header of its column's name. A column `<name>_url` beside a
 * column `<name>` links that column's text, as `google.sheet-rows` reads it.
 */
export function sheetWriteVerb(
  host: SheetWriteHost,
  clock: WriteClock = systemClock,
): RecipeVerbContribution {
  return {
    id: SHEET_WRITE,
    kind: 'sink',
    arguments: ARGUMENTS,
    writes: [CLEAR_WRITE, ROW_WRITE],
    plan: (request) => planSheetWrite(host, request),
    apply: (request) => applySheetWrites(host, request, clock),
  };
}

export type Mode = 'replace' | 'append';

/** What a `write-row` payload holds, in the payload or in the cache entry it names. */
export interface RowPayload {
  /** The sheet row, from 1. */
  readonly k: number;
  /** The plan's digest, which every operation of one plan shares. */
  readonly h: string;
  /** `<spreadsheetId>/<sheetId>`. */
  readonly s: string;
  /** `r` for replace, `a` for append. */
  readonly m: 'r' | 'a';
  /** The row's cells from column A, trailing blanks left out. */
  readonly c: readonly WriteCell[];
}

const problem = (text: string): Diagnostic => argumentsProblem(SHEET_WRITE, text);
const refused = (diagnostic: Diagnostic): PlanAnswer => ({ ok: false, error: [diagnostic] });

export async function planSheetWrite(
  host: SheetWriteHost,
  request: PlanRequest,
): Promise<PlanAnswer> {
  const { table } = request;
  const spreadsheetId = spreadsheetOf(
    SHEET_WRITE,
    request.arguments['spreadsheet'],
    request.section,
  );
  if (typeof spreadsheetId !== 'string') return refused(spreadsheetId);
  const mode: Mode = request.arguments['mode'] === 'append' ? 'append' : 'replace';
  const columns = writeColumns(table, String(request.arguments['formulas'] ?? ''));
  if (!Array.isArray(columns)) return refused(columns);

  const connection = await connect(host, request.section);
  if (!connection.ok) return refused(verbFailed(SHEET_WRITE, connection.error));
  const { client } = connection.value;
  const spreadsheet = await readGridSpreadsheet(client, spreadsheetId);
  if (!spreadsheet.ok) return refused(verbFailed(SHEET_WRITE, spreadsheet.error));
  const separator = formulaSeparator(spreadsheet.value.locale);
  const written = request.arguments['tab'];
  const tab = pickTab(
    spreadsheet.value.tabs,
    typeof written === 'string' ? written.trim() || undefined : undefined,
  );
  if (typeof tab === 'string') return refused(problem(tab));

  // Where each column lands, and the row the table starts at.
  let positions: number[];
  let header: string[] | undefined;
  let start: number;
  if (mode === 'replace') {
    positions = columns.map((_, index) => index);
    header = columns.map((column) => column.name);
    start = 2;
  } else {
    const values = await readValues(client, spreadsheetId, tab);
    if (!values.ok) return refused(verbFailed(SHEET_WRITE, values.error));
    if (values.value.length === 0) {
      positions = columns.map((_, index) => index);
      header = columns.map((column) => column.name);
      start = 2;
    } else {
      const names = headerOf(values.value, tab.title);
      if (typeof names === 'string') return refused(problem(names));
      const found = placed(columns, names, tab.title);
      if (!Array.isArray(found)) return refused(found);
      positions = found;
      start = values.value.length + 1;
    }
  }

  const fixed = (mode === 'replace' ? 1 : 0) + (header === undefined ? 0 : 1);
  if (fixed + table.rows.length > MAX_OPERATIONS) {
    return refused(
      problem(
        `would write ${table.rows.length.toLocaleString('en-US')} rows, over the ` +
          `${(MAX_OPERATIONS - fixed).toLocaleString('en-US')} one plan holds; split the table`,
      ),
    );
  }

  const rows = table.rows.map((row) => {
    const cells: WriteCell[] = [];
    for (const [index, column] of columns.entries()) {
      const cell = writeCellOf(
        row.values[column.name],
        column,
        column.link === undefined ? undefined : row.values[column.link],
      );
      if (cell !== null && typeof cell === 'object' && 'problem' in cell) return cell.problem;
      cells[positions[index] ?? index] =
        cell !== null && typeof cell === 'object' && 'f' in cell
          ? { f: localFormula(cell.f, separator) }
          : cell;
    }
    return trimmed(Array.from(cells, (cell) => cell ?? null));
  });
  const headerCells = header === undefined ? undefined : trimmed(header);
  const s = `${spreadsheetId}/${tab.sheetId}`;
  const h = fingerprint(JSON.stringify([s, mode, start, headerCells ?? null, rows]));
  await forgetOldPlans(host);

  const m = mode === 'replace' ? 'r' : 'a';
  const operations: PlannedOperation[] = [];
  if (mode === 'replace') {
    operations.push({
      write: CLEAR_WRITE,
      description: shortened(
        `clear every value and link of the tab '${tab.title}', then write the table from ` +
          'row 1',
      ),
      payload: { h, s },
    });
  }
  if (headerCells !== undefined) {
    operations.push(
      await rowOperation(host, undefined, `row 1: the header ${headerCells.join(', ')}`, {
        k: 1,
        h,
        s,
        m,
        c: headerCells,
      }),
    );
  }
  for (const [index, row] of table.rows.entries()) {
    const k = start + index;
    const cells = rows[index];
    if (cells === undefined) continue;
    if (typeof cells === 'string') {
      operations.push(plannedFailure(row.key, `row ${k}`, `E_GOOGLE_PLAN: ${row.key}: ${cells}`));
      continue;
    }
    const shown = cells.map(shownCell).join(' | ');
    operations.push(
      await rowOperation(host, row.key, `row ${k}: ${shown === '' ? '(blank)' : shown}`, {
        k,
        h,
        s,
        m,
        c: cells,
      }),
    );
  }
  const target = `the tab '${tab.title}' of spreadsheet ${spreadsheetId}`;
  return {
    ok: true,
    value: { target, operations, count: operations.length },
    diagnostics: [],
  };
}

/** A `write-row` operation, its cells spilled to the cache when the payload would be too big. */
async function rowOperation(
  host: SheetWriteHost,
  rowKey: string | undefined,
  description: string,
  payload: RowPayload,
): Promise<PlannedOperation> {
  const kept = await keptPayload(host, spillKey(payload.h, payload.k), payload);
  if (!kept.ok) {
    return plannedFailure(
      rowKey,
      `row ${payload.k}`,
      `E_GOOGLE_PLAN: row ${payload.k} ${kept.reason}`,
    );
  }
  return {
    write: ROW_WRITE,
    ...(rowKey === undefined ? {} : { rowKey }),
    description: shortened(description),
    payload: kept.payload,
  };
}

/**
 * The payload as it is, or, past {@link SPILL_BYTES}, kept in the plugin's cache under `key`
 * and replaced by `{ ck, cd }`, the entry's name and digest, which Apply reads it back by.
 */
export async function keptPayload(
  host: Pick<PluginHost, 'cache'>,
  key: string,
  payload: object,
): Promise<
  | { readonly ok: true; readonly payload: JsonValue }
  | { readonly ok: false; readonly reason: string }
> {
  const text = JSON.stringify(payload);
  if (utf8Bytes(text) <= SPILL_BYTES) return { ok: true, payload: payload as JsonValue };
  try {
    await host.cache.put(key, text);
  } catch (thrown) {
    return {
      ok: false,
      reason:
        `needs ${utf8Bytes(text).toLocaleString('en-US')} bytes, more than a plan keeps per ` +
        `row, and the plugin's cache refused them: ${messageOf(thrown)}`,
    };
  }
  return { ok: true, payload: { ck: key, cd: fingerprint(text) } };
}

/** Forgets the cache entries of plans made over {@link PLAN_ENTRY_DAYS} ago; never fails. */
export async function forgetOldPlans(host: Pick<PluginHost, 'cache' | 'log'>): Promise<void> {
  try {
    const cutoff = Date.now() - PLAN_ENTRY_DAYS * 24 * 60 * 60 * 1000;
    for (const entry of await host.cache.list('plan/')) {
      if (Date.parse(entry.storedAt) < cutoff) await host.cache.delete(entry.key);
    }
  } catch (thrown) {
    host.log.warn(`the google plugin kept old plans in its cache: ${messageOf(thrown)}`);
  }
}

/**
 * A row the plan already knows cannot be written. Shown with the others and answered `failed`
 * on Apply with this reason and no request: the person reads it before confirming.
 */
function plannedFailure(
  rowKey: string | undefined,
  description: string,
  reason: string,
): PlannedOperation {
  return {
    write: ROW_WRITE,
    ...(rowKey === undefined ? {} : { rowKey }),
    description: shortened(`${description} (will fail: ${reason})`),
    payload: { x: shortened(reason) },
  };
}

/**
 * The table's columns as the tab's: each `<name>_url` link column beside a `<name>` column is
 * folded into it as that column's link, and `formulas=` names the columns whose cells starting
 * with `=` are written as formulas. Every other cell is text, whatever it starts with.
 */
export function writeColumns(table: Table, formulas: string): WriteColumn[] | Diagnostic {
  const byName = new Map(table.columns.map((column) => [column.name.toLowerCase(), column]));
  const folded = new Map<string, string>();
  for (const column of table.columns) {
    const match = /^(.*)_url$/i.exec(column.name);
    const base = match?.[1] === undefined ? undefined : byName.get(match[1].toLowerCase());
    if (column.type === 'link' && base !== undefined && base.type !== 'link') {
      folded.set(base.name, column.name);
    }
  }
  const linkColumns = new Set(folded.values());
  const asked = [
    ...new Set(
      formulas
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== ''),
    ),
  ];
  const formulaNames = new Set<string>();
  for (const name of asked) {
    const column = byName.get(name.toLowerCase());
    if (column === undefined || linkColumns.has(column.name)) {
      return problem(
        `formulas= names '${name}', which is not a column the table writes; its columns are ` +
          listed(table.columns.map((each) => each.name).filter((each) => !linkColumns.has(each))),
      );
    }
    formulaNames.add(column.name);
  }
  return table.columns
    .filter((column) => !linkColumns.has(column.name))
    .map((column) => {
      const link = folded.get(column.name);
      return {
        name: column.name,
        ...(link === undefined ? {} : { link }),
        ...(column.type === 'link' ? { linksItself: true } : {}),
        formula: formulaNames.has(column.name),
      };
    });
}

/** Where each column lands in a tab that has a header: under its name, ignoring case. */
function placed(
  columns: readonly WriteColumn[],
  names: readonly string[],
  title: string,
): number[] | Diagnostic {
  const positions: number[] = [];
  const missing: string[] = [];
  for (const column of columns) {
    const index = names.findIndex((name) => name.toLowerCase() === column.name.toLowerCase());
    if (index < 0) missing.push(column.name);
    positions.push(index);
  }
  if (missing.length > 0) {
    return problem(
      `cannot append ${listed(missing)}: the tab '${title}' has no column of that name in row 1. ` +
        `Its columns are ${listed(names)}; rename the table's columns, or add them to the tab`,
    );
  }
  return positions;
}

/** The spreadsheet's id from `spreadsheet=`, else from the section. */
export function spreadsheetOf(
  verb: string,
  written: unknown,
  section: unknown,
): string | Diagnostic {
  const text = typeof written === 'string' ? written.trim() : '';
  if (text !== '') {
    return (
      spreadsheetIdOf(text) ??
      argumentsProblem(
        verb,
        `spreadsheet= holds '${text}', which is neither a spreadsheet id nor its address, ` +
          'such as https://docs.google.com/spreadsheets/d/<id>/edit',
      )
    );
  }
  const read = readSection(section);
  if (!read.ok) return verbFailed(verb, read.error);
  return (
    read.value.spreadsheet ??
    argumentsProblem(
      verb,
      'needs spreadsheet=, or spreadsheet in the google section of .tyto/project.json, and was ' +
        'given neither',
    )
  );
}

export function trimmed<T>(cells: readonly (T | null)[]): (T | null)[] {
  let end = cells.length;
  while (end > 0 && cells[end - 1] === null) end -= 1;
  return cells.slice(0, end);
}

export function listed(names: readonly string[]): string {
  const shown = names.slice(0, 20).map((name) => `'${name}'`);
  return `${shown.join(', ')}${names.length > 20 ? ', …' : ''}`;
}

export function shortened(text: string, limit: number = MAX_DESCRIPTION_LENGTH): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

export function utf8Bytes(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}
