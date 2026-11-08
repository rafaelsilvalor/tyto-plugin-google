import { connect } from './connect.js';
import { cellData, readWriteCell, WRITTEN_FIELDS, type WriteCell } from './sheet-cells.js';
import {
  formatRequests,
  NEW_TAB,
  readTabFormat,
  readWant,
  type FormatWant,
  type TabFormat,
} from './sheet-format.js';
import { readCellExtras, readGridTabs, readValues, type GridTab } from './sheet-snapshot.js';
import { fingerprint } from './cursor.js';
import { headerOf, type RawCell } from './sheet-grid.js';
import {
  batchFailed,
  budgetedTransport,
  failed,
  failedWith,
  forget,
  isDigest,
  isSheet,
  NOT_REACHED,
  PLAN_AGAIN,
  recordOf,
  shortReason,
  spilled,
  systemClock,
  UNREADABLE,
  type ApplyHost,
  type WriteClock,
} from './sheet-write-apply.js';
import type { AppliedOperation, ApplyAnswer, ApplyRequest, CellValue, JsonValue } from './verb.js';

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';
/**
 * The row's cells and links as the plan read them, so Apply can tell the row changed since: a
 * link a person changed between the plan and Apply fails the row as a changed value does. A
 * row with no link digests as its values alone, as plans made before links were digested did.
 */
export function rowDigest(
  cells: readonly RawCell[],
  links: readonly (readonly [number, string])[] = [],
): string {
  const values = [...cells];
  while (values.length > 0 && values.at(-1) === '') values.pop();
  return fingerprint(JSON.stringify(links.length === 0 ? values : [values, links]));
}

/** The links of sheet row `row`, by column, from links read by column then row. */
export function rowLinks(
  links: Readonly<Record<string, Readonly<Record<string, string>>>>,
  row: number,
): [number, string][] {
  return Object.entries(links)
    .flatMap(([column, rows]): [number, string][] => {
      const uri = rows[String(row)];
      return uri === undefined ? [] : [[Number(column), uri]];
    })
    .sort((a, b) => a[0] - b[0]);
}

export function headerDigest(names: readonly string[]): string {
  return fingerprint(JSON.stringify(names));
}

/** A key as text: blank is `''`. */
export function keyText(value: CellValue | RawCell | undefined): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.map((item) => keyText(item)).join(', ');
  return String(value as string | number | boolean).trim();
}

const CHANGED = `the row changed since the plan; ${PLAN_AGAIN}`;

interface AddTab {
  readonly kind: 'add-tab';
  readonly h: string;
  readonly s: string;
  readonly t: string;
  readonly c: readonly string[];
}

/** A `format-tab`: the synced tab's when `t` is absent, else the tab rows move to. */
interface FormatTab {
  readonly kind: 'format-tab';
  readonly h: string;
  readonly s: string;
  readonly t?: string;
  readonly want: FormatWant;
}

interface Anchored {
  readonly h: string;
  readonly s: string;
  readonly kc: number;
  readonly hd: string;
  readonly k: string;
}

type Change = readonly [number, WriteCell];

interface Move {
  readonly kind: 'move';
  readonly d: string;
  readonly t: string;
  /** {@link headerDigest} of the destination's header when planned. */
  readonly dh: string;
  /** Pairs of this tab's column and the destination's, from 0. */
  readonly m: readonly (readonly [number, number])[];
  /** Cells the table changes, written over the row before it is copied. */
  readonly u: readonly Change[];
}

type RowOperation = Anchored &
  (
    | { readonly kind: 'update'; readonly d: string; readonly u: readonly Change[] }
    | Move
    | { readonly kind: 'delete'; readonly d: string }
    | { readonly kind: 'add'; readonly c: readonly WriteCell[] }
  );

type Decoded = (AddTab | FormatTab | RowOperation) & { readonly ck?: string };

/** A tab rows move to, as this batch finds it. */
interface Destination {
  readonly sheetId: number;
  /** Its last row holding anything, from 1. */
  readonly last: number;
  readonly rowCount: number;
  readonly header?: readonly string[];
  /** Whether this batch adds it. */
  readonly added: boolean;
}

/**
 * One batch of a `google.sheet-sync` plan, written in **one `spreadsheets.batchUpdate`**, which
 * Google applies whole or not at all: a move's copy to its tab and the removal of its row
 * land together or not at all.
 *
 * The batch reads the tab once and finds each row by its key, never by the number it had when
 * planned: rows deleted or added since move the others. A row whose cells or links differ from
 * what the plan read fails alone, "the row changed since the plan". The requests go in the
 * order that keeps every row number right: new tabs, cell updates (a moved row's included),
 * moved rows copied with `copyPaste`, rows deleted from the bottom up, new rows appended
 * under the last, then each tab's format over the rows it ends with.
 */
export async function applySheetSync(
  host: ApplyHost,
  request: ApplyRequest,
  clock: WriteClock = systemClock,
): Promise<ApplyAnswer> {
  const outcomes: (AppliedOperation | undefined)[] = [];
  const decoded: (Decoded | undefined)[] = [];
  for (const operation of request.operations) {
    const each = await decodeOperation(host, operation.write, operation.payload);
    outcomes.push(typeof each === 'string' ? { status: 'failed', reason: each } : undefined);
    decoded.push(typeof each === 'string' ? undefined : each);
  }
  const pending = (): number[] =>
    decoded.flatMap((each, index) =>
      each !== undefined && outcomes[index] === undefined ? [index] : [],
    );
  const settle = (indexes: readonly number[], outcome: AppliedOperation): void => {
    for (const index of indexes) outcomes[index] = { ...outcome, ...shortReason(outcome) };
  };
  const done = (): ApplyAnswer => ({
    ok: true,
    value: {
      operations: outcomes.map((outcome) => outcome ?? { status: 'skipped', reason: NOT_REACHED }),
    },
    diagnostics: [],
  });
  const at = (index: number): Decoded => decoded[index] as Decoded;

  const first = decoded.find((each) => each !== undefined);
  if (first === undefined) return done();
  for (const index of pending()) {
    const each = decoded[index];
    if (each !== undefined && (each.h !== first.h || each.s !== first.s)) {
      settle([index], failed('E_GOOGLE_PLAN', `this batch holds two plans; ${PLAN_AGAIN}`));
    }
  }
  const [spreadsheetId = '', sheetText = ''] = first.s.split('/');
  const sheetId = Number(sheetText);

  const budget = budgetedTransport(host, clock);
  const refusedOr = (indexes: readonly number[], outcome: AppliedOperation): ApplyAnswer => {
    if (!budget.refusedForTime()) settle(indexes, outcome);
    return done();
  };
  const connection = await connect(host, request.section, budget.transport);
  if (!connection.ok) return refusedOr(pending(), failedWith(connection.error));
  const { client } = connection.value;
  const tabs = await readGridTabs(client, spreadsheetId);
  if (!tabs.ok) return refusedOr(pending(), failedWith(tabs.error));
  const tab = tabs.value.find((each) => each.sheetId === sheetId);
  if (tab === undefined) {
    settle(
      pending(),
      failed(
        'E_GOOGLE_CHANGED',
        `the tab the plan syncs (sheet id ${sheetId}) is gone; ${PLAN_AGAIN}`,
      ),
    );
    return done();
  }

  // The tab, read once: where each key is now, its cells and its links.
  const isRow = (index: number): boolean => {
    const kind = decoded[index]?.kind;
    return kind !== 'add-tab' && kind !== 'format-tab';
  };
  const ownFormat = (index: number): boolean => {
    const each = decoded[index];
    return each?.kind === 'format-tab' && each.t === undefined;
  };
  const rowIndexes = pending().filter(isRow);
  const where = new Map<string, number[]>();
  const cellsAt = new Map<number, readonly RawCell[]>();
  let lastRow = 0;
  let width = 0;
  if (rowIndexes.length > 0 || pending().some(ownFormat)) {
    const reading = pending().filter((index) => isRow(index) || ownFormat(index));
    const values = await readValues(client, spreadsheetId, tab);
    if (!values.ok) return refusedOr(reading, failedWith(values.error));
    lastRow = values.value.length;
    const read = headerOf(values.value, tab.title);
    const names = typeof read === 'string' ? undefined : read;
    width = names?.length ?? 0;
    const headerChanged = failed(
      'E_GOOGLE_CHANGED',
      `the header of the tab '${tab.title}' changed since the plan; ${PLAN_AGAIN}`,
    );
    for (const index of pending().filter(ownFormat)) {
      const { want } = at(index) as FormatTab;
      if (names === undefined || headerDigest(names) !== headerDigest(want.c)) {
        settle([index], headerChanged);
      }
    }
    if (rowIndexes.length > 0) {
      const anchor = at(rowIndexes[0] ?? 0) as RowOperation;
      if (names === undefined || headerDigest(names) !== anchor.hd) {
        settle(rowIndexes, headerChanged);
      }
      values.value.forEach((cells, index) => {
        if (index === 0) return;
        const key = keyText(cells[anchor.kc]);
        if (key === '') return;
        where.set(key, [...(where.get(key) ?? []), index + 1]);
        cellsAt.set(index + 1, cells);
      });
    }
  }
  let links: Readonly<Record<string, Readonly<Record<string, string>>>> = {};
  const digested = pending().filter((index) => isRow(index) && at(index).kind !== 'add');
  if (digested.length > 0) {
    const extras = await readCellExtras(
      client,
      spreadsheetId,
      tab,
      { links: Array.from({ length: width }, (_, index) => index), notes: [] },
      lastRow,
    );
    if (!extras.ok) return refusedOr(digested, failedWith(extras.error));
    links = extras.value.links;
  }

  const rowOf = new Map<number, number>();
  for (const index of pending()) {
    const each = at(index);
    if (each.kind === 'add-tab' || each.kind === 'format-tab') continue;
    const found = where.get(each.k) ?? [];
    if (each.kind === 'add') {
      if (found.length > 0) {
        settle([index], failed('E_GOOGLE_CHANGED', `${each.k} is in the tab already: ${CHANGED}`));
      }
      continue;
    }
    const number = found[0];
    if (found.length !== 1 || number === undefined) {
      const why = found.length === 0 ? 'is no longer in the tab' : 'is in the tab twice now';
      settle([index], failed('E_GOOGLE_CHANGED', `${each.k} ${why}: ${CHANGED}`));
      continue;
    }
    if (rowDigest(cellsAt.get(number) ?? [], rowLinks(links, number)) !== each.d) {
      settle([index], failed('E_GOOGLE_CHANGED', `${each.k} (row ${number}): ${CHANGED}`));
      continue;
    }
    rowOf.set(index, number);
  }

  // New tabs: one already there was added by an earlier Apply, or by a person.
  const sheetIdOf = new Map(tabs.value.map((each) => [each.title, each.sheetId]));
  let nextId = Math.max(0, ...tabs.value.map((each) => each.sheetId)) + 1;
  const newTabs: AddTab[] = [];
  for (const index of pending()) {
    const each = at(index);
    if (each.kind !== 'add-tab') continue;
    if (sheetIdOf.has(each.t)) {
      settle([index], {
        status: 'skipped',
        reason: `the tab '${each.t}' is in the spreadsheet already`,
      });
      continue;
    }
    sheetIdOf.set(each.t, nextId);
    nextId += 1;
    newTabs.push(each);
  }

  // The tabs rows move to: where each copy lands, under the header the plan placed it by.
  const destinations = new Map<string, Destination>();
  const destinationOf = (index: number): string | undefined => {
    const each = at(index);
    return each.kind === 'move' || each.kind === 'format-tab' ? each.t : undefined;
  };
  for (const title of new Set(pending().flatMap((index) => destinationOf(index) ?? []))) {
    const into = pending().filter((index) => destinationOf(index) === title);
    const added = newTabs.find((each) => each.t === title);
    const found = tabs.value.find((each) => each.title === title);
    if (added !== undefined) {
      const id = sheetIdOf.get(title) ?? 0;
      destinations.set(title, {
        sheetId: id,
        last: 1,
        rowCount: 1000,
        header: added.c,
        added: true,
      });
    } else if (found !== undefined) {
      const values = await readValues(client, spreadsheetId, found);
      if (!values.ok) return refusedOr(into, failedWith(values.error));
      const header = values.value.length === 0 ? undefined : headerOf(values.value, title);
      destinations.set(title, {
        sheetId: found.sheetId,
        last: values.value.length,
        rowCount: found.rowCount,
        ...(Array.isArray(header) ? { header } : {}),
        added: false,
      });
    } else {
      settle(
        into,
        failed(
          'E_GOOGLE_CHANGED',
          `the tab '${title}' is no longer in the spreadsheet; ${PLAN_AGAIN}`,
        ),
      );
      continue;
    }
    const destination = destinations.get(title);
    for (const index of into) {
      const each = at(index);
      const planned = each.kind === 'move' ? each.dh : headerDigest((each as FormatTab).want.c);
      if (destination?.header === undefined || headerDigest(destination.header) !== planned) {
        settle(
          [index],
          failed(
            'E_GOOGLE_CHANGED',
            `the header of the tab '${title}' changed since the plan; ${PLAN_AGAIN}`,
          ),
        );
      }
    }
  }

  // Each format, read as the tab looks now.
  const looks = new Map<number, TabFormat>();
  for (const index of pending()) {
    const each = at(index);
    if (each.kind !== 'format-tab') continue;
    const destination = each.t === undefined ? undefined : destinations.get(each.t);
    if (destination?.added === true) {
      looks.set(index, NEW_TAB);
      continue;
    }
    const target =
      each.t === undefined ? tab : { sheetId: destination?.sheetId ?? 0, title: each.t };
    const read = await readTabFormat(client, spreadsheetId, target, each.want.c.length);
    if (!read.ok) {
      if (budget.refusedForTime()) return done();
      settle([index], failedWith(read.error));
      continue;
    }
    looks.set(index, read.value);
  }

  if (budget.expired()) return done();
  const rows = rowRequests(
    tab,
    pending().map((index) => [at(index), rowOf.get(index)] as const),
    newTabs,
    sheetIdOf,
    destinations,
  );
  const formats: unknown[] = [];
  for (const index of pending()) {
    const each = at(index);
    if (each.kind !== 'format-tab') continue;
    const destination = each.t === undefined ? undefined : destinations.get(each.t);
    const id = destination?.sheetId ?? tab.sheetId;
    const last =
      destination === undefined
        ? lastRow - rows.removed + rows.appended
        : destination.last + (rows.copied.get(id) ?? 0);
    const { requests } = formatRequests(id, each.want, looks.get(index) ?? NEW_TAB, last);
    if (requests.length === 0) {
      settle([index], { status: 'skipped', reason: 'the tab looks as its settings ask already' });
    }
    formats.push(...requests);
  }
  const writing = pending();
  if (writing.length === 0) return done();
  const requests = [...rows.requests, ...formats];
  if (requests.length > 0) {
    const sent = await client.post(`${SHEETS}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
      requests,
    });
    if (!sent.ok) return refusedOr(writing, batchFailed(sent.error));
  }
  settle(writing, { status: 'applied' });
  for (const index of writing) {
    const ck = decoded[index]?.ck;
    if (ck !== undefined) await forget(host, ck);
  }
  return done();
}

/** The batch's row requests, and how many rows each tab gains or loses by them. */
function rowRequests(
  tab: GridTab,
  operations: readonly (readonly [Decoded, number | undefined])[],
  newTabs: readonly AddTab[],
  sheetIdOf: ReadonlyMap<string, number>,
  destinations: ReadonlyMap<string, Destination>,
): {
  readonly requests: unknown[];
  readonly removed: number;
  readonly appended: number;
  /** Rows copied in, by the destination's sheet id. */
  readonly copied: Map<number, number>;
} {
  const { sheetId } = tab;
  const requests: unknown[] = [];
  for (const added of newTabs) {
    const id = sheetIdOf.get(added.t);
    requests.push(
      {
        addSheet: {
          properties: {
            sheetId: id,
            title: added.t,
            gridProperties: { rowCount: 1000, columnCount: Math.max(26, added.c.length) },
          },
        },
      },
      cellsRequest(id ?? 0, 1, 0, added.c),
    );
  }
  for (const [each, row] of operations) {
    if ((each.kind !== 'update' && each.kind !== 'move') || row === undefined) continue;
    for (const [at, cell] of each.u) requests.push(cellsRequest(sheetId, row, at, [cell]));
  }

  // Moves: each row copied whole, value, formula, format and link, under its destination's
  // last row, after the grid is grown to hold it.
  const copied = new Map<number, number>();
  const copies: unknown[] = [];
  for (const [each, row] of operations) {
    if (each.kind !== 'move' || row === undefined) continue;
    const destination = destinations.get(each.t);
    if (destination === undefined) continue;
    const count = (copied.get(destination.sheetId) ?? 0) + 1;
    copied.set(destination.sheetId, count);
    const target = destination.last + count;
    for (const [from, to, width] of runsOf(each.m)) {
      copies.push({
        copyPaste: {
          source: {
            sheetId,
            startRowIndex: row - 1,
            endRowIndex: row,
            startColumnIndex: from,
            endColumnIndex: from + width,
          },
          destination: {
            sheetId: destination.sheetId,
            startRowIndex: target - 1,
            endRowIndex: target,
            startColumnIndex: to,
            endColumnIndex: to + width,
          },
          pasteType: 'PASTE_NORMAL',
          pasteOrientation: 'NORMAL',
        },
      });
    }
  }
  // copyPaste does not grow the grid (Buraqueira, 2026-08): rows are added first.
  for (const destination of destinations.values()) {
    const short = destination.last + (copied.get(destination.sheetId) ?? 0) - destination.rowCount;
    if (short > 0) {
      requests.push({
        appendDimension: { sheetId: destination.sheetId, dimension: 'ROWS', length: short },
      });
    }
  }
  requests.push(...copies);

  // Bottom up, so each removal leaves the rows above it, still to remove, where they were.
  const removed = operations
    .filter(([each]) => each.kind === 'move' || each.kind === 'delete')
    .flatMap(([, row]) => (row === undefined ? [] : [row]))
    .sort((a, b) => b - a);
  // Sheets refuses to delete every row a tab has left that is not frozen.
  if (removed.length > 0 && tab.rowCount - removed.length < 2) {
    requests.push({
      appendDimension: { sheetId, dimension: 'ROWS', length: 2 - (tab.rowCount - removed.length) },
    });
  }
  for (const row of removed) {
    requests.push({
      deleteDimension: {
        range: { sheetId, dimension: 'ROWS', startIndex: row - 1, endIndex: row },
      },
    });
  }
  const added = operations.flatMap(([each]) => (each.kind === 'add' ? [each.c] : []));
  if (added.length > 0) {
    requests.push({
      appendCells: {
        sheetId,
        rows: added.map((cells) => ({ values: cells.map(cellData) })),
        fields: WRITTEN_FIELDS,
      },
    });
  }
  return { requests, removed: removed.length, appended: added.length, copied };
}

/** Column pairs as runs `[from, to, width]` that move together: one copyPaste each. */
function runsOf(pairs: readonly (readonly [number, number])[]): [number, number, number][] {
  const runs: [number, number, number][] = [];
  for (const [from, to] of [...pairs].sort((a, b) => a[0] - b[0])) {
    const last = runs.at(-1);
    if (last !== undefined && last[0] + last[2] === from && last[1] + last[2] === to) last[2] += 1;
    else runs.push([from, to, 1]);
  }
  return runs;
}

function cellsRequest(
  sheetId: number,
  row: number,
  column: number,
  cells: readonly WriteCell[],
): unknown {
  return {
    updateCells: {
      range: {
        sheetId,
        startRowIndex: row - 1,
        endRowIndex: row,
        startColumnIndex: column,
        endColumnIndex: column + cells.length,
      },
      rows: [{ values: cells.map(cellData) }],
      fields: WRITTEN_FIELDS,
    },
  };
}

/** A planned failure's reason, an operation this version writes, or why it reads none. */
async function decodeOperation(
  host: ApplyHost,
  write: string,
  payload: JsonValue | undefined,
): Promise<Decoded | string> {
  let object = recordOf(payload);
  if (object === undefined) return UNREADABLE;
  const planned = object['x'];
  if (typeof planned === 'string') return planned;
  let ck: string | undefined;
  if (typeof object['ck'] === 'string' && typeof object['cd'] === 'string') {
    const kept = await spilled(host, object['ck'], object['cd']);
    if (typeof kept === 'string') return kept;
    ck = object['ck'];
    object = kept;
  }
  const read = readOperation(write, object);
  if (read === undefined) return UNREADABLE;
  return ck === undefined ? read : { ...read, ck };
}

function readOperation(
  write: string,
  object: Readonly<Record<string, JsonValue>>,
): AddTab | FormatTab | RowOperation | undefined {
  const { h, s, kc, hd, k, d, t, c, u, dh, m } = object;
  if (!isDigest(h) || !isSheet(s)) return undefined;
  if (write === 'add-tab') {
    const names = Array.isArray(c) ? c : [];
    if (typeof t !== 'string' || t === '' || !names.every((name) => typeof name === 'string')) {
      return undefined;
    }
    return { kind: 'add-tab', h, s, t, c: names as string[] };
  }
  if (write === 'format-tab') {
    const want = readWant(object);
    if (want === undefined || (t !== undefined && (typeof t !== 'string' || t === ''))) {
      return undefined;
    }
    return { kind: 'format-tab', h, s, ...(t === undefined ? {} : { t }), want };
  }
  if (
    typeof kc !== 'number' ||
    !Number.isSafeInteger(kc) ||
    kc < 0 ||
    !isDigest(hd) ||
    typeof k !== 'string' ||
    k === ''
  ) {
    return undefined;
  }
  const anchor = { h, s, kc, hd, k };
  if (write === 'add') {
    const cells = cellsOf(c);
    return cells === undefined ? undefined : { ...anchor, kind: 'add', c: cells };
  }
  if (!isDigest(d)) return undefined;
  if (write === 'delete') return { ...anchor, kind: 'delete', d };
  const changes = u === undefined && write === 'move' ? [] : changesOf(u);
  if (changes === undefined) return undefined;
  if (write === 'move') {
    const pairs = pairsOf(m);
    if (pairs === undefined || typeof t !== 'string' || t === '' || !isDigest(dh)) {
      return undefined;
    }
    return { ...anchor, kind: 'move', d, t, dh, m: pairs, u: changes };
  }
  if (write !== 'update' || changes.length === 0) return undefined;
  return { ...anchor, kind: 'update', d, u: changes };
}

function changesOf(value: JsonValue | undefined): Change[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const changes: Change[] = [];
  for (const change of value) {
    if (!Array.isArray(change) || change.length !== 2) return undefined;
    const [at, written] = change as [JsonValue, JsonValue];
    const cell = readWriteCell(written);
    if (!isIndex(at) || cell === undefined) return undefined;
    changes.push([at, cell]);
  }
  return changes;
}

function pairsOf(value: JsonValue | undefined): [number, number][] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  const pairs: [number, number][] = [];
  for (const pair of value) {
    if (!Array.isArray(pair) || pair.length !== 2) return undefined;
    const [from, to] = pair as [JsonValue, JsonValue];
    if (!isIndex(from) || !isIndex(to)) return undefined;
    pairs.push([from, to]);
  }
  return pairs;
}

function isIndex(value: JsonValue | undefined): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function cellsOf(value: JsonValue | undefined): WriteCell[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const cells: WriteCell[] = [];
  for (const each of value) {
    const cell = readWriteCell(each);
    if (cell === undefined) return undefined;
    cells.push(cell);
  }
  return cells;
}
