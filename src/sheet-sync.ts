import type { PluginHost, RecipeVerbContribution } from '@tyto/plugin-api';

import { connect } from './connect.js';
import { fingerprint } from './cursor.js';
import { googleOk, type GoogleResult } from './errors.js';
import { columnIndexOf, headerOf, type RawCell } from './sheet-grid.js';
import { shownCell, writeCellOf, type WriteCell, type WriteColumn } from './sheet-cells.js';
import {
  formatRequests,
  NEW_TAB,
  readTabFormat,
  tabSettingsOf,
  wantOf,
  type FormatWant,
} from './sheet-format.js';
import {
  pickTab,
  readCellExtras,
  readGridTabs,
  readValues,
  type GridTab,
} from './sheet-snapshot.js';
import { applySheetSync, headerDigest, keyText, rowDigest, rowLinks } from './sheet-sync-apply.js';
import {
  forgetOldPlans,
  keptPayload,
  listed,
  MAX_OPERATIONS,
  shortened,
  spreadsheetOf,
  trimmed,
  writeColumns,
} from './sheet-write.js';
import { spillKey, systemClock, type WriteClock } from './sheet-write-apply.js';
import {
  argumentsProblem,
  verbFailed,
  type ArgumentSpec,
  type Diagnostic,
  type JsonValue,
  type PlanAnswer,
  type PlannedOperation,
  type PlanRequest,
} from './verb.js';

export const SHEET_SYNC = 'google.sheet-sync';
export const SYNC_WRITES = ['add-tab', 'update', 'move', 'delete', 'add', 'format-tab'] as const;
export type SyncWrite = (typeof SYNC_WRITES)[number];

const ARGUMENTS: readonly ArgumentSpec[] = [
  { name: 'spreadsheet', type: 'text' },
  { name: 'tab', type: 'text', required: true },
  { name: 'key', type: 'text', required: true },
  { name: 'move', type: 'text' },
  { name: 'keep', type: 'text' },
  { name: 'archived', type: 'text' },
];

export type SheetSyncHost = Pick<PluginHost, 'credentials' | 'fetch' | 'signin' | 'cache' | 'log'>;

/**
 * `google.sheet-sync key=<col> tab=<tab> [move=<col>] [keep=<cols>] [archived=<tabs>]`: makes
 * one tab hold the table's rows, matched by key, as a plan a person applies.
 *
 * The decisions are Buraqueira's `sync.py` (2026-08-09), with its company columns turned into
 * arguments. For each key:
 *
 * | In the tab | In the table          | Decision                                            |
 * | ---------- | --------------------- | --------------------------------------------------- |
 * | yes        | yes, `move=` blank    | `update` the cells that differ, or nothing          |
 * | yes        | yes, `move=` a tab    | `move` the row to that tab (`add-tab` when missing) |
 * | yes        | no, `keep=` blank     | `delete` the row                                    |
 * | yes        | no, `keep=` with text | kept, with a warning: a person wrote there          |
 * | no         | yes, in `archived=`   | skipped: it was already filed away                  |
 * | no         | yes, `move=` a tab    | skipped: a row never in the tab is not invented     |
 * | no         | yes                   | `add` it under the last row                         |
 *
 * Two guards hold over the table: **an empty table over a tab with rows plans nothing** and
 * says so, because an empty input is indistinguishable from a failed read upstream, and every
 * row would be deleted; and **a key twice in the tab or in the table is refused**, never
 * guessed between.
 */
export function sheetSyncVerb(
  host: SheetSyncHost,
  clock: WriteClock = systemClock,
): RecipeVerbContribution {
  return {
    id: SHEET_SYNC,
    kind: 'sink',
    arguments: ARGUMENTS,
    writes: SYNC_WRITES,
    plan: (request) => planSheetSync(host, request),
    apply: (request) => applySheetSync(host, request, clock),
  };
}

/** What every row operation's payload holds, besides its own fields. */
export interface RowAnchor {
  /** The plan's digest. */
  readonly h: string;
  /** `<spreadsheetId>/<sheetId>`. */
  readonly s: string;
  /** The key column's index in the header, from 0. */
  readonly kc: number;
  /** {@link headerDigest} of the tab's header when planned. */
  readonly hd: string;
  /** The row's key. */
  readonly k: string;
}

interface SheetRow {
  readonly number: number;
  readonly cells: readonly RawCell[];
}

interface Draft {
  readonly write: SyncWrite;
  readonly rowKey?: string;
  readonly description: string;
  /** The payload without the plan's digest, which is known only once every draft is. */
  readonly payload?: Readonly<Record<string, JsonValue>>;
  /** Why the operation will fail, shown in the plan and answered by Apply. */
  readonly failure?: string;
}

const problem = (text: string): Diagnostic => argumentsProblem(SHEET_SYNC, text);
const refused = (diagnostic: Diagnostic): PlanAnswer => ({ ok: false, error: [diagnostic] });
/**
 * Tyto's closed catalogue has no warning code for a verb, so a decision a person should read
 * rides `E_RECIPE_VERB` at warning severity: shown with the plan, stopping nothing.
 */
const warning = (message: string): Diagnostic => ({
  severity: 'warning',
  code: 'E_RECIPE_VERB',
  message: `'${SHEET_SYNC}' ${message}`,
});

export async function planSheetSync(
  host: SheetSyncHost,
  request: PlanRequest,
): Promise<PlanAnswer> {
  const { table } = request;
  const text = (name: string): string => {
    const value = request.arguments[name];
    return typeof value === 'string' ? value.trim() : '';
  };
  const spreadsheetId = spreadsheetOf(
    SHEET_SYNC,
    request.arguments['spreadsheet'],
    request.section,
  );
  if (typeof spreadsheetId !== 'string') return refused(spreadsheetId);
  const columns = writeColumns(table, '');
  if (!Array.isArray(columns)) return refused(columns);
  const tableColumn = (name: string): WriteColumn | undefined =>
    columns.find((column) => column.name.toLowerCase() === name.toLowerCase());
  const keyColumn = tableColumn(text('key'));
  if (keyColumn === undefined) {
    return refused(problem(`key= names '${text('key')}', which is not a column of the table`));
  }
  const moveName = text('move');
  const moveColumn = moveName === '' ? undefined : tableColumn(moveName);
  if (moveName !== '' && moveColumn === undefined) {
    return refused(problem(`move= names '${moveName}', which is not a column of the table`));
  }

  const connection = await connect(host, request.section);
  if (!connection.ok) return refused(verbFailed(SHEET_SYNC, connection.error));
  const { client } = connection.value;
  const tabs = await readGridTabs(client, spreadsheetId);
  if (!tabs.ok) return refused(verbFailed(SHEET_SYNC, tabs.error));
  const tab = pickTab(tabs.value, text('tab'));
  if (typeof tab === 'string') return refused(problem(tab));
  const values = await readValues(client, spreadsheetId, tab);
  if (!values.ok) return refused(verbFailed(SHEET_SYNC, values.error));
  const names = headerOf(values.value, tab.title);
  if (typeof names === 'string') return refused(problem(names));
  const kc = columnIndexOf(names, keyColumn.name);
  if (kc === undefined) {
    return refused(problem(`the tab '${tab.title}' has no column '${keyColumn.name}' in row 1`));
  }
  const keep = listOf(text('keep')).map((name) => [name, columnIndexOf(names, name)] as const);
  const unknownKeep = keep.filter(([, index]) => index === undefined).map(([name]) => name);
  if (unknownKeep.length > 0) {
    return refused(
      problem(`keep= names ${listed(unknownKeep)}, which the tab '${tab.title}' has no column for`),
    );
  }
  const keepIndexes = new Set(keep.map(([, index]) => index as number));

  // Where each table column lands; keep= columns are the person's, never overwritten.
  const placed: { readonly column: WriteColumn; readonly at: number }[] = [];
  const unplaced: string[] = [];
  for (const column of columns) {
    const at = columnIndexOf(names, column.name);
    if (at === undefined) {
      if (column !== moveColumn) unplaced.push(column.name);
    } else if (!keepIndexes.has(at)) {
      placed.push({ column, at });
    }
  }
  if (unplaced.length > 0) {
    return refused(
      problem(
        `cannot write ${listed(unplaced)}: the tab '${tab.title}' has no column of that name ` +
          `in row 1. Its columns are ${listed(names)}`,
      ),
    );
  }

  // The tab's rows by key: a blank key is left alone, a repeated one refuses the plan.
  const inTab = new Map<string, SheetRow>();
  const unkeyed: number[] = [];
  for (let index = 1; index < values.value.length; index += 1) {
    const cells = values.value[index] ?? [];
    const number = index + 1;
    const key = keyText(cells[kc]);
    if (key === '') {
      if (cells.some((cell) => cell !== '')) unkeyed.push(number);
      continue;
    }
    const before = inTab.get(key);
    if (before !== undefined) {
      return refused(
        problem(
          `rows ${before.number} and ${number} of the tab '${tab.title}' both hold '${key}' in ` +
            `${names[kc] ?? ''}; a key must be unique, and the sync does not guess which row is it`,
        ),
      );
    }
    inTab.set(key, { number, cells });
  }
  const inTable = new Map<string, (typeof table.rows)[number]>();
  const drafts: Draft[] = [];
  for (const row of table.rows) {
    const key = keyText(row.values[keyColumn.name]);
    if (key === '') {
      drafts.push({
        write: 'add',
        rowKey: row.key,
        description: `add ${row.key}`,
        failure: `E_GOOGLE_PLAN: ${row.key} has no ${keyColumn.name}, which key= names`,
      });
      continue;
    }
    if (inTable.has(key)) {
      return refused(
        problem(`the table holds '${key}' in ${keyColumn.name} twice; a key must be unique`),
      );
    }
    inTable.set(key, row);
  }

  if (table.rows.length === 0 && inTab.size > 0) {
    return {
      ok: true,
      value: { target: targetOf(tab, spreadsheetId), operations: [], count: 0 },
      diagnostics: [
        warning(
          `was handed no rows, and the tab '${tab.title}' holds ${inTab.size}: it deletes ` +
            'nothing. An empty table is what a failed read before this step looks like; check ' +
            'it before you trust this run',
        ),
      ],
    };
  }

  const tabsRead = new Map<string, readonly (readonly RawCell[])[]>();
  const archived = new Set<string>();
  for (const title of listOf(text('archived'))) {
    const found = pickTab(tabs.value, title);
    // A tab named but not there yet, such as next month's, has filed nothing away.
    if (typeof found === 'string') continue;
    const read = await readValues(client, spreadsheetId, found);
    if (!read.ok) return refused(verbFailed(SHEET_SYNC, read.error));
    tabsRead.set(found.title, read.value);
    if (read.value.length === 0) continue;
    const archivedNames = headerOf(read.value, found.title);
    if (typeof archivedNames === 'string') return refused(problem(archivedNames));
    const at = columnIndexOf(archivedNames, keyColumn.name);
    if (at === undefined) {
      return refused(
        problem(`archived= names '${found.title}', which has no column '${keyColumn.name}'`),
      );
    }
    for (const row of read.value.slice(1)) {
      const key = keyText(row[at]);
      if (key !== '') archived.add(key);
    }
  }

  const linked = placed.filter(
    ({ column }) => column.link !== undefined || column.linksItself === true,
  );
  const cellsOf = (row: (typeof table.rows)[number]) => {
    const cells = new Map<number, WriteCell>();
    for (const { column, at } of placed) {
      const cell = writeCellOf(
        row.values[column.name],
        column,
        column.link === undefined ? undefined : row.values[column.link],
      );
      if (cell !== null && typeof cell === 'object' && 'problem' in cell) return cell.problem;
      cells.set(at, cell);
    }
    return cells;
  };
  const destinationOf = (key: string): string =>
    moveColumn === undefined ? '' : keyText(inTable.get(key)?.values[moveColumn.name]);
  // Every column's links: a row's digest covers them, so a link changed before Apply fails it.
  const lastRow = values.value.length;
  const extras = await readCellExtras(
    client,
    spreadsheetId,
    tab,
    { links: names.map((_, index) => index), notes: [] },
    lastRow,
  );
  if (!extras.ok) return refused(verbFailed(SHEET_SYNC, extras.error));
  const linkAt = (at: number, number: number): string | undefined =>
    extras.value.links[String(at)]?.[String(number)];
  const digestOf = (row: SheetRow): string =>
    rowDigest(row.cells, rowLinks(extras.value.links, row.number));
  /** The table's cells that would change the sheet's, with the sheet's link where it reads one. */
  const changedOf = (cells: ReadonlyMap<number, WriteCell>, row: SheetRow) => {
    const changed: [number, WriteCell][] = [];
    for (const [at, cell] of cells) {
      const read = linked.some((each) => each.at === at);
      if (!sameCell(cell, row.cells[at], read ? linkAt(at, row.number) : undefined)) {
        changed.push([at, cell]);
      }
    }
    return changed;
  };

  const s = `${spreadsheetId}/${tab.sheetId}`;
  const hd = headerDigest(names);
  const anchor = (key: string) => ({ s, kc, hd, k: key });
  const shownChanges = (changed: readonly (readonly [number, WriteCell])[], row: SheetRow) =>
    changed
      .map(([at, cell]) => `${names[at] ?? ''}: ${shownRaw(row.cells[at])} → ${shownCell(cell)}`)
      .join('; ');
  const preserved: string[] = [];
  let unchanged = 0;
  const moves: {
    key: string;
    row: SheetRow;
    destination: string;
    cells: Map<number, WriteCell>;
  }[] = [];
  const deletes: Draft[] = [];
  for (const [key, row] of inTab) {
    const input = inTable.get(key);
    if (input === undefined) {
      const kept = [...keepIndexes].some((at) => keyText(row.cells[at]) !== '');
      if (kept) preserved.push(key);
      else {
        deletes.push({
          write: 'delete',
          // No rowKey: the host names only rows of the table, and this one left it.
          description: `delete ${key} (row ${row.number}), which the table no longer holds`,
          payload: { ...anchor(key), d: digestOf(row) },
        });
      }
      continue;
    }
    const cells = cellsOf(input);
    if (typeof cells === 'string') {
      drafts.push({
        write: 'update',
        rowKey: input.key,
        description: `update ${key}`,
        failure: `E_GOOGLE_PLAN: ${key}: ${cells}`,
      });
      continue;
    }
    const destination = destinationOf(key);
    if (destination !== '') {
      moves.push({ key, row, destination, cells });
      continue;
    }
    const changed = changedOf(cells, row);
    if (changed.length === 0) {
      unchanged += 1;
      continue;
    }
    const shown = shownChanges(changed, row);
    drafts.push({
      write: 'update',
      rowKey: input.key,
      description: `update ${key} (row ${row.number}): ${shown}`,
      payload: {
        ...anchor(key),
        d: digestOf(row),
        u: changed.map(([at, cell]) => [at, cell]),
      },
    });
  }

  // Moves: each destination's header, read once, or a new tab with this tab's header.
  const destinations = new Map<string, readonly string[] | string>();
  const tabDrafts: Draft[] = [];
  for (const { destination } of moves) {
    if (destinations.has(destination)) continue;
    const found = pickTab(tabs.value, destination);
    if (typeof found === 'string') {
      destinations.set(destination, names);
      tabDrafts.push({
        write: 'add-tab',
        description: `add the tab '${destination}', with the header ${names.join(', ')}`,
        payload: { s, t: destination, c: names },
      });
      continue;
    }
    if (found.sheetId === tab.sheetId) {
      destinations.set(destination, `move= names the tab '${tab.title}' this step syncs`);
      continue;
    }
    let read = tabsRead.get(found.title);
    if (read === undefined) {
      const answer = await readValues(client, spreadsheetId, found);
      if (!answer.ok) return refused(verbFailed(SHEET_SYNC, answer.error));
      read = answer.value;
      tabsRead.set(found.title, read);
    }
    const header = read.length === 0 ? 'is empty' : headerOf(read, found.title);
    destinations.set(
      destination,
      header === 'is empty'
        ? `the tab '${found.title}' is empty; write its header in row 1, or delete the tab ` +
            'so the sync adds it'
        : header,
    );
  }
  const moveDrafts: Draft[] = moves.map(({ key, row, destination, cells }) => {
    const header = destinations.get(destination) ?? names;
    const changed = changedOf(cells, row);
    const base = {
      write: 'move' as const,
      rowKey: inTable.get(key)?.key ?? key,
      description:
        `move ${key} (row ${row.number}) to the tab '${destination}'` +
        (changed.length === 0 ? '' : `, writing ${shownChanges(changed, row)}`),
    };
    if (typeof header === 'string') return { ...base, failure: `E_GOOGLE_PLAN: ${header}` };
    // The row travels by copyPaste, cell by cell under the column of its name: what the
    // table changes is written over the row first, so the copy carries it too.
    const filled = (at: number): boolean => {
      const cell = cells.get(at);
      if (cells.has(at)) return cell !== null;
      return (row.cells[at] ?? '') !== '' || linkAt(at, row.number) !== undefined;
    };
    const pairs: [number, number][] = [];
    const missing: string[] = [];
    names.forEach((name, at) => {
      const to = columnIndexOf(header, name);
      if (to !== undefined) pairs.push([at, to]);
      else if (filled(at)) missing.push(name);
    });
    if (missing.length > 0) {
      return {
        ...base,
        failure: `E_GOOGLE_PLAN: the tab '${destination}' has no column ${listed(missing)}, which ${key} fills`,
      };
    }
    const title = pickTab(tabs.value, destination);
    return {
      ...base,
      payload: {
        ...anchor(key),
        d: digestOf(row),
        t: typeof title === 'string' ? destination : title.title,
        dh: headerDigest(header),
        m: pairs,
        ...(changed.length === 0 ? {} : { u: changed.map(([at, cell]) => [at, cell]) }),
      },
    };
  });

  const skippedArchived: string[] = [];
  const skippedNeverHere: string[] = [];
  const addDrafts: Draft[] = [];
  for (const [key, row] of inTable) {
    if (inTab.has(key)) continue;
    if (archived.has(key)) {
      skippedArchived.push(key);
      continue;
    }
    if (destinationOf(key) !== '') {
      skippedNeverHere.push(key);
      continue;
    }
    const cells = cellsOf(row);
    if (typeof cells === 'string') {
      addDrafts.push({
        write: 'add',
        rowKey: row.key,
        description: `add ${key}`,
        failure: `E_GOOGLE_PLAN: ${key}: ${cells}`,
      });
      continue;
    }
    const line = trimmed(names.map((_, at) => cells.get(at) ?? null));
    addDrafts.push({
      write: 'add',
      rowKey: row.key,
      description: `add ${key}: ${line.map(shownCell).join(' | ')}`,
      payload: { ...anchor(key), c: line },
    });
  }

  // How the tabs look: the synced one, and each tab rows move to, when the section says.
  const writes = (list: readonly Draft[]): number =>
    list.filter((each) => each.payload !== undefined && each.failure === undefined).length;
  const formatDrafts: Draft[] = [];
  const format = async (
    title: string,
    sheetId: number | undefined,
    header: readonly string[],
    last: number,
    destination: boolean,
  ): Promise<GoogleResult<void>> => {
    const settings = tabSettingsOf(request.section, title);
    if (settings === undefined) return googleOk(undefined);
    const description = `format the tab '${title}'`;
    const want = typeof settings === 'string' ? settings : wantOf(settings, header);
    if (typeof want === 'string') {
      formatDrafts.push({ write: 'format-tab', description, failure: `E_GOOGLE_CONFIG: ${want}` });
      return googleOk(undefined);
    }
    let now = NEW_TAB;
    if (sheetId !== undefined) {
      const read = await readTabFormat(client, spreadsheetId, { sheetId, title }, header.length);
      if (!read.ok) return read;
      now = read.value;
    }
    const { said } = formatRequests(sheetId ?? 0, want, now, last);
    if (said.length === 0) return googleOk(undefined);
    formatDrafts.push({
      write: 'format-tab',
      description: `${description}: ${said.join('; ')}`,
      payload: { s, ...(destination ? { t: title } : {}), ...formatPayload(want) },
    });
    return googleOk(undefined);
  };
  const formatted = await format(
    tab.title,
    tab.sheetId,
    names,
    lastRow - writes(deletes) - writes(moveDrafts) + writes(addDrafts),
    false,
  );
  if (!formatted.ok) return refused(verbFailed(SHEET_SYNC, formatted.error));
  for (const [destination, header] of destinations) {
    if (typeof header === 'string') continue;
    const into = moveDrafts.filter(
      (draft, index) => draft.payload !== undefined && moves[index]?.destination === destination,
    ).length;
    const found = pickTab(tabs.value, destination);
    const done =
      typeof found === 'string'
        ? await format(destination, undefined, header, 1 + into, true)
        : await format(
            found.title,
            found.sheetId,
            header,
            (tabsRead.get(found.title)?.length ?? 1) + into,
            true,
          );
    if (!done.ok) return refused(verbFailed(SHEET_SYNC, done.error));
  }

  const ordered = [
    ...tabDrafts,
    ...drafts,
    ...moveDrafts,
    ...deletes,
    ...addDrafts,
    ...formatDrafts,
  ];
  if (ordered.length > MAX_OPERATIONS) {
    return refused(
      problem(
        `would plan ${ordered.length.toLocaleString('en-US')} operations, over the ` +
          `${MAX_OPERATIONS.toLocaleString('en-US')} one plan holds; split the table`,
      ),
    );
  }
  const h = fingerprint(JSON.stringify([s, hd, ordered]));
  await forgetOldPlans(host);
  const operations: PlannedOperation[] = [];
  for (const [index, draft] of ordered.entries()) {
    operations.push(await operationOf(host, draft, h, index + 1));
  }

  const diagnostics: Diagnostic[] = [];
  if (preserved.length > 0) {
    diagnostics.push(
      warning(
        `keeps ${preserved.length} row(s) the table no longer holds, because their ` +
          `${listed(keep.map(([name]) => name))} hold text a person wrote: ${listed(preserved)}`,
      ),
    );
  }
  if (skippedArchived.length > 0) {
    diagnostics.push(
      warning(
        `does not add ${listed(skippedArchived)}, already in ${listed(listOf(text('archived')))}`,
      ),
    );
  }
  if (skippedNeverHere.length > 0) {
    diagnostics.push(
      warning(
        `does not add ${listed(skippedNeverHere)}: move= sends them to another tab, and they ` +
          `were never in '${tab.title}'`,
      ),
    );
  }
  if (unkeyed.length > 0) {
    diagnostics.push(
      warning(
        `leaves rows ${unkeyed.join(', ')} of '${tab.title}' as they are: they hold no ` +
          `${names[kc] ?? ''}`,
      ),
    );
  }
  if (unchanged > 0)
    host.log.info(`${SHEET_SYNC}: ${unchanged} row(s) already as the table has them`);
  return {
    ok: true,
    value: { target: targetOf(tab, spreadsheetId), operations, count: operations.length },
    diagnostics,
  };
}

async function operationOf(
  host: SheetSyncHost,
  draft: Draft,
  h: string,
  index: number,
): Promise<PlannedOperation> {
  const keyed = draft.rowKey === undefined ? {} : { rowKey: draft.rowKey };
  const failing = (reason: string): PlannedOperation => ({
    write: draft.write,
    ...keyed,
    description: shortened(`${draft.description} (will fail: ${reason})`),
    payload: { x: shortened(reason) },
  });
  if (draft.failure !== undefined || draft.payload === undefined) {
    return failing(draft.failure ?? 'E_GOOGLE_PLAN: nothing to write');
  }
  const kept = await keptPayload(host, spillKey(h, index), { h, ...draft.payload });
  if (!kept.ok) return failing(`E_GOOGLE_PLAN: ${draft.rowKey ?? draft.write} ${kept.reason}`);
  return {
    write: draft.write,
    ...keyed,
    description: shortened(draft.description),
    payload: kept.payload,
  };
}

/** Whether writing `cell` would leave the sheet's cell as it is. */
function sameCell(cell: WriteCell, raw: RawCell | undefined, link: string | undefined): boolean {
  const value = raw ?? '';
  if (cell === null) return value === '' && link === undefined;
  if (typeof cell !== 'object')
    return value === cell && (typeof cell !== 'string' || link === undefined);
  return 't' in cell && value === cell.t && link === cell.u;
}

function formatPayload(want: FormatWant): Readonly<Record<string, JsonValue>> {
  return {
    c: [...want.c],
    ...(want.n === undefined ? {} : { n: want.n }),
    ...(want.b === undefined ? {} : { b: want.b }),
    ...(want.v === undefined ? {} : { v: want.v.map(([at, values]) => [at, [...values]]) }),
  };
}

function shownRaw(raw: RawCell | undefined): string {
  if (raw === undefined || raw === '') return '(blank)';
  return typeof raw === 'boolean' ? (raw ? 'TRUE' : 'FALSE') : String(raw);
}

function listOf(text: string): string[] {
  return [
    ...new Set(
      text
        .split(',')
        .map((name) => name.trim())
        .filter((name) => name !== ''),
    ),
  ];
}

function targetOf(tab: GridTab, spreadsheetId: string): string {
  return `the tab '${tab.title}' of spreadsheet ${spreadsheetId}`;
}
