import { googleError, googleOk, type GoogleResult } from './errors.js';
import type { GoogleClient } from './http.js';
import { columnLetter, type RawCell, type Snapshot } from './sheet-grid.js';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';

/** One tab of a spreadsheet: its id, which never changes, and its title, which may. */
export interface Tab {
  readonly sheetId: number;
  readonly title: string;
}

/**
 * Where a cell's link lives. Three places, because Buraqueira measured (2026-08-09) that
 * Sheets moves a link covering the whole cell out of the text run that wrote it and into the
 * cell's format, and fills `hyperlink` for both and for `=HYPERLINK(...)`.
 */
const LINK_FIELDS = [
  'hyperlink',
  'textFormatRuns(format(link(uri)))',
  'effectiveFormat(textFormat(link(uri)))',
];

/** The spreadsheet's tabs, in their order. */
export async function readTabs(
  client: GoogleClient,
  spreadsheetId: string,
): Promise<GoogleResult<Tab[]>> {
  const answer = await client.get(`${SHEETS}/${encodeURIComponent(spreadsheetId)}`, {
    fields: 'sheets.properties(sheetId,title)',
  });
  if (!answer.ok) return answer;
  const sheets = recordOf(answer.value)?.['sheets'];
  if (!Array.isArray(sheets)) return malformed('the spreadsheet', 'no sheets');
  const tabs: Tab[] = [];
  for (const sheet of sheets) {
    const properties = recordOf(recordOf(sheet)?.['properties']);
    const sheetId = properties?.['sheetId'] ?? 0;
    const title = properties?.['title'];
    if (!Number.isSafeInteger(sheetId) || typeof title !== 'string') {
      return malformed('the spreadsheet', 'a tab with no id or title');
    }
    tabs.push({ sheetId: sheetId as number, title });
  }
  return googleOk(tabs);
}

/** The tab named, exactly or else ignoring case; the first tab when none is named. */
export function pickTab<T extends Tab>(
  tabs: readonly T[],
  written: string | undefined,
): T | string {
  if (written === undefined) return tabs[0] ?? 'the spreadsheet has no tab';
  const exact = tabs.find((tab) => tab.title === written);
  if (exact !== undefined) return exact;
  const lowered = written.toLowerCase();
  const loose = tabs.filter((tab) => tab.title.toLowerCase() === lowered);
  if (loose.length === 1 && loose[0] !== undefined) return loose[0];
  return `the spreadsheet has no tab '${written}'; its tabs are ${tabs
    .map((tab) => `'${tab.title}'`)
    .join(', ')}`;
}

/** A tab with the size of its grid, which a write must stay inside or grow first. */
export interface GridTab extends Tab {
  readonly rowCount: number;
  readonly columnCount: number;
}

/** The spreadsheet's tabs with their grid sizes, in their order. */
export async function readGridTabs(
  client: GoogleClient,
  spreadsheetId: string,
): Promise<GoogleResult<GridTab[]>> {
  const read = await readGridSpreadsheet(client, spreadsheetId);
  return read.ok ? googleOk(read.value.tabs) : read;
}

/**
 * The spreadsheet's tabs with their grid sizes, and its locale (`pt_BR`, `en_US`), which
 * decides how a formula separates its arguments. Blank when Google answers none.
 */
export async function readGridSpreadsheet(
  client: GoogleClient,
  spreadsheetId: string,
): Promise<GoogleResult<{ readonly locale: string; readonly tabs: GridTab[] }>> {
  const answer = await client.get(`${SHEETS}/${encodeURIComponent(spreadsheetId)}`, {
    fields:
      'properties.locale,sheets.properties(sheetId,title,gridProperties(rowCount,columnCount))',
  });
  if (!answer.ok) return answer;
  const locale = recordOf(recordOf(answer.value)?.['properties'])?.['locale'];
  const sheets = recordOf(answer.value)?.['sheets'];
  if (!Array.isArray(sheets)) return malformed('the spreadsheet', 'no sheets');
  const tabs: GridTab[] = [];
  for (const sheet of sheets) {
    const properties = recordOf(recordOf(sheet)?.['properties']);
    const sheetId = properties?.['sheetId'] ?? 0;
    const title = properties?.['title'];
    const grid = recordOf(properties?.['gridProperties']);
    if (!Number.isSafeInteger(sheetId) || typeof title !== 'string') {
      return malformed('the spreadsheet', 'a tab with no id or title');
    }
    tabs.push({
      sheetId: sheetId as number,
      title,
      rowCount: numberOr(grid?.['rowCount'], 0),
      columnCount: numberOr(grid?.['columnCount'], 0),
    });
  }
  return googleOk({ locale: typeof locale === 'string' ? locale : '', tabs });
}

/**
 * Which of the sheet rows `from` to `to` hold any value, read in one `values.get`. Google
 * answers the rows of the range up to the last one that holds anything.
 */
export async function filledRows(
  client: GoogleClient,
  spreadsheetId: string,
  tab: Tab,
  from: number,
  to: number,
): Promise<GoogleResult<Set<number>>> {
  const range = encodeURIComponent(`${quotedTitle(tab.title)}!${from}:${to}`);
  const answer = await client.get(
    `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values/${range}`,
    { majorDimension: 'ROWS', valueRenderOption: 'FORMULA' },
  );
  if (!answer.ok) return answer;
  const rows = recordOf(answer.value)?.['values'] ?? [];
  if (!Array.isArray(rows)) return malformed(`the tab '${tab.title}'`, 'values that are no list');
  const filled = new Set<number>();
  rows.forEach((row, offset) => {
    if (Array.isArray(row) && row.some((cell) => cell !== null && cell !== '')) {
      filled.add(from + offset);
    }
  });
  return googleOk(filled);
}

/** `'Tab name'`, quoted as A1 notation quotes a title, which works for every title. */
export function quotedTitle(title: string): string {
  return `'${title.replace(/'/g, "''")}'`;
}

/**
 * The tab's values: numbers and booleans as Google holds them, and dates as the text the sheet
 * shows, so a date is never a serial number a person did not write.
 */
export async function readValues(
  client: GoogleClient,
  spreadsheetId: string,
  tab: Tab,
): Promise<GoogleResult<RawCell[][]>> {
  const range = encodeURIComponent(quotedTitle(tab.title));
  const answer = await client.get(
    `${SHEETS}/${encodeURIComponent(spreadsheetId)}/values/${range}`,
    {
      majorDimension: 'ROWS',
      valueRenderOption: 'UNFORMATTED_VALUE',
      dateTimeRenderOption: 'FORMATTED_STRING',
    },
  );
  if (!answer.ok) return answer;
  const body = recordOf(answer.value);
  if (body === undefined) return malformed(`the tab '${tab.title}'`, 'no values object');
  const rows = body['values'] ?? [];
  if (!Array.isArray(rows)) return malformed(`the tab '${tab.title}'`, 'values that are no list');
  const values: RawCell[][] = [];
  for (const row of rows) {
    if (!Array.isArray(row)) return malformed(`the tab '${tab.title}'`, 'a row that is no list');
    const cells: RawCell[] = [];
    for (const cell of row) {
      if (typeof cell === 'string' || typeof cell === 'boolean') cells.push(cell);
      else if (typeof cell === 'number' && Number.isFinite(cell)) cells.push(cell);
      else if (cell === null) cells.push('');
      else return malformed(`the tab '${tab.title}'`, 'a cell that is no value');
    }
    values.push(cells);
  }
  return googleOk(values);
}

/**
 * The links and notes of the columns asked for, rows 2 to `lastRow`, in one `spreadsheets.get`.
 * The field mask names only what was asked: no link field without `links=`, no note without
 * `notes=`, because a mask is what keeps the answer from carrying every cell's whole format.
 */
export async function readCellExtras(
  client: GoogleClient,
  spreadsheetId: string,
  tab: Tab,
  asked: { readonly links: readonly number[]; readonly notes: readonly number[] },
  lastRow: number,
): Promise<GoogleResult<Pick<Snapshot, 'links' | 'notes'>>> {
  const links: Record<string, Record<string, string>> = {};
  const notes: Record<string, Record<string, string>> = {};
  for (const column of asked.links) links[String(column)] = {};
  for (const column of asked.notes) notes[String(column)] = {};
  const columns = [...new Set([...asked.links, ...asked.notes])].sort((a, b) => a - b);
  if (columns.length === 0 || lastRow < 2) return googleOk({ links, notes });

  const fields = [
    ...(asked.links.length > 0 ? LINK_FIELDS : []),
    ...(asked.notes.length > 0 ? ['note'] : []),
  ];
  const answer = await client.get(`${SHEETS}/${encodeURIComponent(spreadsheetId)}`, {
    ranges: columns.map((column) => {
      const letter = columnLetter(column);
      return `${quotedTitle(tab.title)}!${letter}2:${letter}${lastRow}`;
    }),
    fields: `sheets(data(startRow,startColumn,rowData(values(${fields.join(',')}))))`,
  });
  if (!answer.ok) return answer;
  const sheet = recordOf(listOf(recordOf(answer.value)?.['sheets'])[0]);
  const data = listOf(sheet?.['data']);
  for (const block of data) {
    const range = recordOf(block);
    const startRow = numberOr(range?.['startRow'], 0);
    const column = String(numberOr(range?.['startColumn'], 0));
    listOf(range?.['rowData']).forEach((rowData, offset) => {
      const cell = recordOf(listOf(recordOf(rowData)?.['values'])[0]);
      if (cell === undefined) return;
      const row = String(startRow + offset + 1);
      const link = linkOf(cell);
      const linkColumn = links[column];
      if (linkColumn !== undefined && link !== undefined) linkColumn[row] = link;
      const note = cell['note'];
      const noteColumn = notes[column];
      if (noteColumn !== undefined && typeof note === 'string' && note !== '') {
        noteColumn[row] = note;
      }
    });
  }
  return googleOk({ links, notes });
}

/** The cell's link: `hyperlink`, else the first linked text run, else the cell's format. */
function linkOf(cell: Readonly<Record<string, unknown>>): string | undefined {
  const hyperlink = cell['hyperlink'];
  if (typeof hyperlink === 'string' && hyperlink !== '') return hyperlink;
  for (const run of listOf(cell['textFormatRuns'])) {
    const uri = recordOf(recordOf(recordOf(run)?.['format'])?.['link'])?.['uri'];
    if (typeof uri === 'string' && uri !== '') return uri;
  }
  const format = recordOf(recordOf(cell['effectiveFormat'])?.['textFormat']);
  const uri = recordOf(format?.['link'])?.['uri'];
  return typeof uri === 'string' && uri !== '' ? uri : undefined;
}

/**
 * The file's Drive `version`, which rises with every change to it, edits in Sheets included:
 * a cached snapshot is served only while the version it was read at is still the file's.
 */
export async function readVersion(
  client: GoogleClient,
  spreadsheetId: string,
): Promise<GoogleResult<string>> {
  const answer = await client.get(`${DRIVE_FILES}/${encodeURIComponent(spreadsheetId)}`, {
    fields: 'version',
    supportsAllDrives: true,
  });
  if (!answer.ok) return answer;
  const version = recordOf(answer.value)?.['version'];
  if (typeof version === 'string' && /^\d+$/.test(version)) return googleOk(version);
  if (typeof version === 'number' && Number.isSafeInteger(version))
    return googleOk(String(version));
  return malformed('the Drive file', 'no version');
}

function malformed(what: string, why: string): GoogleResult<never> {
  return googleError('E_GOOGLE_RESPONSE', `Google answered ${what} with ${why}.`);
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

function listOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : fallback;
}
