import { connect } from './connect.js';
import { cellData, readWriteCell, WRITTEN_FIELDS, type WriteCell } from './sheet-cells.js';
import { readGridTabs, readValues, type GridTab } from './sheet-snapshot.js';
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
/** The row's cells as the plan read them, so Apply can tell the row changed since. */
export function rowDigest(cells: readonly RawCell[]): string {
  const values = [...cells];
  while (values.length > 0 && values.at(-1) === '') values.pop();
  return fingerprint(JSON.stringify(values));
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

interface Anchored {
  readonly h: string;
  readonly s: string;
  readonly kc: number;
  readonly hd: string;
  readonly k: string;
}

type RowOperation = Anchored &
  (
    | {
        readonly kind: 'update';
        readonly d: string;
        readonly u: readonly (readonly [number, WriteCell])[];
      }
    | {
        readonly kind: 'move';
        readonly d: string;
        readonly t: string;
        readonly c: readonly WriteCell[];
      }
    | { readonly kind: 'delete'; readonly d: string }
    | { readonly kind: 'add'; readonly c: readonly WriteCell[] }
  );

type Decoded = (AddTab | RowOperation) & { readonly ck?: string };

/**
 * One batch of a `google.sheet-sync` plan, written in **one `spreadsheets.batchUpdate`**, which
 * Google applies whole or not at all: a move's copy to its tab and the removal of its row
 * land together or not at all.
 *
 * The batch reads the tab once and finds each row by its key, never by the number it had when
 * planned: rows deleted or added since move the others. A row whose cells differ from what the
 * plan read fails alone, "the row changed since the plan". The requests go in the order that
 * keeps every row number right: new tabs, cell updates, moved rows copied, rows deleted from
 * the bottom up, then new rows appended under the last.
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
  const connection = await connect(host, request.section, budget.transport);
  if (!connection.ok) {
    if (!budget.refusedForTime()) settle(pending(), failedWith(connection.error));
    return done();
  }
  const { client } = connection.value;
  const tabs = await readGridTabs(client, spreadsheetId);
  if (!tabs.ok) {
    if (!budget.refusedForTime()) settle(pending(), failedWith(tabs.error));
    return done();
  }
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

  // The tab, read once: where each key is now.
  const rowIndexes = pending().filter((index) => decoded[index]?.kind !== 'add-tab');
  const where = new Map<string, number[]>();
  const cellsAt = new Map<number, readonly (string | number | boolean)[]>();
  if (rowIndexes.length > 0) {
    const values = await readValues(client, spreadsheetId, tab);
    if (!values.ok) {
      if (!budget.refusedForTime()) settle(rowIndexes, failedWith(values.error));
      return done();
    }
    const anchor = decoded[rowIndexes[0] ?? 0] as RowOperation;
    const names = headerOf(values.value, tab.title);
    if (typeof names === 'string' || headerDigest(names) !== anchor.hd) {
      settle(
        rowIndexes,
        failed(
          'E_GOOGLE_CHANGED',
          `the header of the tab '${tab.title}' changed since the plan; ${PLAN_AGAIN}`,
        ),
      );
    }
    values.value.forEach((cells, index) => {
      if (index === 0) return;
      const key = keyText(cells[anchor.kc]);
      if (key === '') return;
      where.set(key, [...(where.get(key) ?? []), index + 1]);
      cellsAt.set(index + 1, cells);
    });
  }

  const rowOf = new Map<number, number>();
  for (const index of pending()) {
    const each = decoded[index] as Decoded;
    if (each.kind === 'add-tab') continue;
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
    if (rowDigest(cellsAt.get(number) ?? []) !== each.d) {
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
    const each = decoded[index] as Decoded;
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
  for (const index of pending()) {
    const each = decoded[index] as Decoded;
    if (each.kind === 'move' && !sheetIdOf.has(each.t)) {
      settle(
        [index],
        failed(
          'E_GOOGLE_CHANGED',
          `the tab '${each.t}' is no longer in the spreadsheet; ${PLAN_AGAIN}`,
        ),
      );
    }
  }

  if (budget.expired()) return done();
  const writing = pending();
  if (writing.length === 0) return done();
  const requests = requestsOf(
    tab,
    writing.map((index) => [decoded[index] as Decoded, rowOf.get(index)] as const),
    newTabs,
    sheetIdOf,
  );
  if (requests.length > 0) {
    const sent = await client.post(`${SHEETS}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
      requests,
    });
    if (!sent.ok) {
      if (!budget.refusedForTime()) settle(writing, batchFailed(sent.error));
      return done();
    }
  }
  settle(writing, { status: 'applied' });
  for (const index of writing) {
    const ck = decoded[index]?.ck;
    if (ck !== undefined) await forget(host, ck);
  }
  return done();
}

function requestsOf(
  tab: GridTab,
  operations: readonly (readonly [Decoded, number | undefined])[],
  newTabs: readonly AddTab[],
  sheetIdOf: ReadonlyMap<string, number>,
): unknown[] {
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
    if (each.kind !== 'update' || row === undefined) continue;
    for (const [at, cell] of each.u) requests.push(cellsRequest(sheetId, row, at, [cell]));
  }
  for (const [each] of operations) {
    if (each.kind !== 'move') continue;
    requests.push({
      appendCells: {
        sheetId: sheetIdOf.get(each.t),
        rows: [{ values: each.c.map(cellData) }],
        fields: WRITTEN_FIELDS,
      },
    });
  }
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
  return requests;
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
): AddTab | RowOperation | undefined {
  const { h, s, kc, hd, k, d, t, c, u } = object;
  if (!isDigest(h) || !isSheet(s)) return undefined;
  if (write === 'add-tab') {
    const names = Array.isArray(c) ? c : [];
    if (typeof t !== 'string' || t === '' || !names.every((name) => typeof name === 'string')) {
      return undefined;
    }
    return { kind: 'add-tab', h, s, t, c: names as string[] };
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
  if (write === 'move') {
    const cells = cellsOf(c);
    if (cells === undefined || typeof t !== 'string' || t === '') return undefined;
    return { ...anchor, kind: 'move', d, t, c: cells };
  }
  if (write !== 'update' || !Array.isArray(u) || u.length === 0) return undefined;
  const changes: [number, WriteCell][] = [];
  for (const change of u) {
    if (!Array.isArray(change) || change.length !== 2) return undefined;
    const [at, value] = change as [JsonValue, JsonValue];
    const cell = readWriteCell(value);
    if (typeof at !== 'number' || !Number.isSafeInteger(at) || at < 0 || cell === undefined) {
      return undefined;
    }
    changes.push([at, cell]);
  }
  return { ...anchor, kind: 'update', d, u: changes };
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
