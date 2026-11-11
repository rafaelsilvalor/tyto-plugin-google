import type { PluginHost, RecipeVerbContribution } from '@tyto/plugin-api';

import { readSection, spreadsheetIdOf } from './config.js';
import { connect } from './connect.js';
import { decodeCursor, encodeCursor, fingerprint, type SheetCursor } from './cursor.js';
import type { GoogleClient } from './http.js';
import { readCache } from './sheet-cache.js';
import { gridOf } from './sheet-grid.js';
import {
  covers,
  firstSnapshot,
  liveSnapshot,
  readOf,
  type Read,
  type TabAsk,
} from './sheet-read.js';
import { readTabs } from './sheet-snapshot.js';
import {
  argumentsProblem,
  failed,
  verbFailed,
  type ArgumentSpec,
  type ArgumentValues,
  type Diagnostic,
  type PageAnswer,
  type PageRequest,
  type Row,
} from './verb.js';

export const SHEET_ROWS = 'google.sheet-rows';

/** The most rows one page answers: the host's own ceiling on a page (Tyto `PAGE_LIMITS`). */
export const PAGE_ROWS = 5000;
/** A page stops short of this many bytes of rows, well under the host's 8 MiB per page. */
export const PAGE_BYTES = 6 * 1024 * 1024;
export const DEFAULT_MAX = 100_000;
export const MAX_MAX = 100_000;

const ARGUMENTS: readonly ArgumentSpec[] = [
  { name: 'spreadsheet', type: 'text' },
  { name: 'tab', type: 'text' },
  { name: 'key', type: 'text' },
  { name: 'links', type: 'text' },
  { name: 'notes', type: 'text' },
  { name: 'max', type: 'number' },
];

export type SheetRowsHost = Pick<PluginHost, 'credentials' | 'fetch' | 'cache' | 'log'>;

/**
 * `google.sheet-rows`: one tab of a spreadsheet as a table, one row per sheet row under the
 * header. The tab is read once, by the first page, and kept in the plugin's cache; every page
 * after it is cut from that one snapshot by offset, so the host's paging loop never stitches
 * two states of the sheet into one table.
 */
export function sheetRowsVerb(host: SheetRowsHost): RecipeVerbContribution {
  return {
    id: SHEET_ROWS,
    kind: 'source',
    arguments: ARGUMENTS,
    page: (request) => sheetRowsPage(host, request),
  };
}

interface Asked extends TabAsk {
  readonly max: number;
}

const problem = (text: string): Diagnostic => argumentsProblem(SHEET_ROWS, text);
const sheetFailed = (text: string): PageAnswer =>
  failed({ severity: 'error', code: 'E_RECIPE_VERB', message: `'${SHEET_ROWS}' failed: ${text}.` });

export async function sheetRowsPage(
  host: SheetRowsHost,
  request: PageRequest,
): Promise<PageAnswer> {
  const asked = readArguments(request.arguments, request.section);
  if ('severity' in asked) return failed(asked);
  let cursor: SheetCursor | undefined;
  if (request.cursor !== undefined) {
    const decoded = decodeCursor(request.cursor);
    if (typeof decoded === 'string') return sheetFailed(`${decoded}; run again`);
    cursor = decoded;
  }
  const print = fingerprint(
    JSON.stringify([
      asked.spreadsheetId,
      asked.tab ?? null,
      asked.key ?? null,
      asked.links,
      asked.notes,
      asked.max,
    ]),
  );
  if (cursor !== undefined && cursor.f !== print) {
    return sheetFailed('the step changed between two pages of one run; run again');
  }

  const connection = await connect(host, request.section);
  if (!connection.ok) return failed(verbFailed(SHEET_ROWS, connection.error));
  const { client } = connection.value;

  const read =
    cursor === undefined
      ? await firstSnapshot(host, SHEET_ROWS, client, asked, request.refresh === true)
      : await laterSnapshot(host, client, asked, cursor);
  if ('severity' in read) return failed(read);
  const { snapshot, names, plan, fetchedAt } = read;

  const grid = gridOf(snapshot, names, plan, fetchedAt);
  if (typeof grid === 'string') return sheetFailed(grid);
  const { columns, rows } = grid;

  const start = cursor?.o ?? 0;
  const page = pageOf(rows, start);
  const table = { columns, rows: page };
  // Never a partial table: more rows than `max=` allows is a source cut short, which the host
  // turns into an error rather than a short table.
  if (rows.length > asked.max)
    return { ok: true, value: { table, truncated: true }, diagnostics: [] };
  const end = start + page.length;
  if (end >= rows.length) return { ok: true, value: { table }, diagnostics: [] };
  const next = encodeCursor({ v: 1, o: end, d: read.digest, s: snapshot.sheetId, f: print });
  return { ok: true, value: { table, cursor: next }, diagnostics: [] };
}

/** At most {@link PAGE_ROWS} rows from `start`, stopping before {@link PAGE_BYTES}. */
function pageOf(rows: readonly Row[], start: number): Row[] {
  const encoder = new TextEncoder();
  const page: Row[] = [];
  let bytes = 0;
  for (let index = start; index < rows.length && page.length < PAGE_ROWS; index += 1) {
    const row = rows[index];
    if (row === undefined) break;
    bytes += encoder.encode(JSON.stringify(row)).byteLength;
    if (page.length > 0 && bytes > PAGE_BYTES) break;
    page.push(row);
  }
  return page;
}

/**
 * A later page's snapshot: the cached one whose digest the cursor carries, else the tab read
 * again, which must be the same; anything else is the sheet edited between two pages.
 */
async function laterSnapshot(
  host: SheetRowsHost,
  client: GoogleClient,
  asked: Asked,
  cursor: SheetCursor,
): Promise<Read | Diagnostic> {
  const changed: Diagnostic = {
    severity: 'error',
    code: 'E_RECIPE_VERB',
    message: `'${SHEET_ROWS}' failed: the tab changed while its pages were read; run again.`,
  };
  const entry = await readCache(host, SHEET_ROWS, asked.spreadsheetId, cursor.s);
  if (entry !== undefined) {
    const cached = readOf(SHEET_ROWS, entry.snapshot, asked, entry.fetchedAt);
    if (
      !('severity' in cached) &&
      covers(entry.snapshot, cached.plan) &&
      cached.digest === cursor.d
    ) {
      return cached;
    }
  }
  const tabs = await readTabs(client, asked.spreadsheetId);
  if (!tabs.ok) return verbFailed(SHEET_ROWS, tabs.error);
  const tab = tabs.value.find((each) => each.sheetId === cursor.s);
  if (tab === undefined) return changed;
  const live = await liveSnapshot(SHEET_ROWS, client, asked, tab);
  if ('severity' in live) return live;
  return live.digest === cursor.d ? live : changed;
}

/** The step's arguments, checked, with the spreadsheet from the section when none is named. */
export function readArguments(values: ArgumentValues, section: unknown): Asked | Diagnostic {
  const text = (name: string): string | undefined => {
    const value = values[name];
    if (value === undefined) return undefined;
    const trimmed = String(value).trim();
    return trimmed === '' ? undefined : trimmed;
  };

  let spreadsheetId: string | undefined;
  const written = text('spreadsheet');
  if (written !== undefined) {
    spreadsheetId = spreadsheetIdOf(written);
    if (spreadsheetId === undefined) {
      return problem(
        `spreadsheet= holds '${written}', which is neither a spreadsheet id nor its address, ` +
          'such as https://docs.google.com/spreadsheets/d/<id>/edit',
      );
    }
  } else {
    const read = readSection(section);
    if (!read.ok) return verbFailed(SHEET_ROWS, read.error);
    spreadsheetId = read.value.spreadsheet;
    if (spreadsheetId === undefined) {
      return problem(
        'needs spreadsheet=, or spreadsheet in the google section of .tyto/project.json, and ' +
          'was given neither',
      );
    }
  }

  const max = values['max'] ?? DEFAULT_MAX;
  if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 1 || max > MAX_MAX) {
    return problem(`max= must be a whole number from 1 to ${MAX_MAX}, not ${String(max)}`);
  }
  const list = (name: string): string[] =>
    [...new Set((text(name) ?? '').split(',').map((item) => item.trim()))].filter(
      (item) => item !== '',
    );
  const tab = text('tab');
  const key = text('key');
  return {
    spreadsheetId,
    ...(tab === undefined ? {} : { tab }),
    ...(key === undefined ? {} : { key }),
    links: list('links'),
    notes: list('notes'),
    max,
  };
}
