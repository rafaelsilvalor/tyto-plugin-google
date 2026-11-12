import type { PluginHost } from '@tyto/plugin-api';

import { connect } from './connect.js';
import { fingerprint } from './cursor.js';
import { describeGoogleError, messageOf, type GoogleError } from './errors.js';
import type { Transport } from './http.js';
import { cellData, readWriteCell, WRITTEN_FIELDS, type WriteCell } from './sheet-cells.js';
import { filledRows, readGridTabs, type GridTab } from './sheet-snapshot.js';
import type { AppliedOperation, ApplyAnswer, ApplyRequest, JsonValue } from './verb.js';

/** The parts of the host an Apply uses. */
export type ApplyHost = Pick<PluginHost, 'credentials' | 'fetch' | 'signin' | 'cache' | 'log'>;

/** The time an Apply measures its budget by; a test passes one it moves. */
export interface WriteClock {
  now(): number;
  sleep?(milliseconds: number): Promise<void>;
}

export const systemClock: WriteClock = { now: () => Date.now() };

/**
 * How long one `apply` call spends, under the host's 30 s deadline for the call (the
 * coordinator's decision of 2026-11-07): past it no request is sent, and what was not written
 * is `skipped` so the person can apply again.
 */
export const APPLY_BUDGET_MILLISECONDS = 20_000;
/** The reason of every operation the budget left unreached. */
export const NOT_REACHED = "not reached in this call's time; run the cell and Apply again";

const SHEETS = 'https://sheets.googleapis.com/v4/spreadsheets';

/** A way out that sends nothing past an Apply's budget, and says when it refused for time. */
export interface BudgetedTransport {
  readonly transport: Transport;
  /** Whether the budget is spent; once it is, every later request is refused. */
  expired(): boolean;
  /** Whether a request was refused for time: what it would have sent was never written. */
  refusedForTime(): boolean;
}

export function budgetedTransport(
  host: Pick<PluginHost, 'fetch'>,
  clock: WriteClock,
): BudgetedTransport {
  const deadline = clock.now() + APPLY_BUDGET_MILLISECONDS;
  let outOfTime = false;
  let refused = false;
  const expired = (): boolean => {
    if (clock.now() > deadline) outOfTime = true;
    return outOfTime;
  };
  return {
    expired,
    refusedForTime: () => refused,
    transport: {
      fetch: (url, init) => {
        if (expired()) {
          refused = true;
          return Promise.reject(new Error(NOT_REACHED));
        }
        return host.fetch(url, init);
      },
      now: () => clock.now(),
      sleep: async (milliseconds) => {
        if (clock.now() + milliseconds > deadline) outOfTime = true;
        else await (clock.sleep ?? wait)(milliseconds);
      },
    },
  };
}

/** `plan/<digest>/<row>`: where a row too big for its payload waits for Apply. */
export function spillKey(digest: string, row: number): string {
  return `plan/${digest}/${row}`;
}

/** `plan/<digest>/cleared`: set once a replace plan's clear is applied. */
export function clearedKey(digest: string): string {
  return `plan/${digest}/cleared`;
}
export const PLAN_AGAIN = 'run the cell again for a new plan';

interface Clear {
  readonly kind: 'clear';
  readonly h: string;
  readonly s: string;
}

interface WriteRow {
  readonly kind: 'row';
  readonly k: number;
  readonly h: string;
  readonly s: string;
  readonly m: 'r' | 'a';
  readonly c: readonly WriteCell[];
  /** The cache entry the row's cells came from, forgotten once they are written. */
  readonly ck?: string;
}

type Decoded = Clear | WriteRow;

/**
 * One batch of a `google.sheet-write` plan, written in **one `spreadsheets.batchUpdate`**:
 * the clear first when the batch holds it, then the rows and columns the grid lacks
 * (`appendDimension`), then each row's cells (`updateCells`). Google applies a batchUpdate whole
 * or not at all, so the batch's operations share one outcome:
 *
 * - a refusal (a 400, a 403, a 429 past the retries) wrote **none** of them;
 * - a 5xx or a lost answer **may** have written them, and is not retried, because writing the
 *   rows again could land them twice; the person reads the tab before applying again.
 *
 * Before the write, a row lands only where the tab is still empty, unless the batch clears the
 * tab first; and a row of a replace plan's later batch lands only once that plan's clear was
 * applied, so a refused clear never leaves new rows over old ones.
 */
export async function applySheetWrites(
  host: ApplyHost,
  request: ApplyRequest,
  clock: WriteClock = systemClock,
): Promise<ApplyAnswer> {
  const outcomes: (AppliedOperation | undefined)[] = [];
  const decoded: (Decoded | undefined)[] = [];
  for (const operation of request.operations) {
    const each = await decodeOperation(host, operation.write, operation.payload);
    if (typeof each === 'string') {
      outcomes.push({ status: 'failed', reason: each });
      decoded.push(undefined);
    } else {
      outcomes.push(undefined);
      decoded.push(each);
    }
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
  const { transport } = budget;
  const refusedForTime = (): boolean => budget.refusedForTime();
  const expired = (): boolean => budget.expired();

  const connection = await connect(host, request.section, transport);
  if (!connection.ok) {
    if (refusedForTime()) return done();
    settle(pending(), failedWith(connection.error));
    return done();
  }
  const { client } = connection.value;
  const tabs = await readGridTabs(client, spreadsheetId);
  if (!tabs.ok) {
    if (refusedForTime()) return done();
    settle(pending(), failedWith(tabs.error));
    return done();
  }
  const tab = tabs.value.find((each) => each.sheetId === sheetId);
  if (tab === undefined) {
    settle(
      pending(),
      failed(
        'E_GOOGLE_CHANGED',
        `the tab the plan writes to (sheet id ${sheetId}) is no longer in the spreadsheet; ` +
          PLAN_AGAIN,
      ),
    );
    return done();
  }

  const clears = pending().filter((index) => decoded[index]?.kind === 'clear');
  const clearsHere = clears.length > 0;
  const rowIndexes = (): number[] => pending().filter((index) => decoded[index]?.kind === 'row');

  if (!clearsHere) {
    // A replace plan's later batch: its rows wait on the clear of the first batch.
    const replacing = rowIndexes().filter((index) => (decoded[index] as WriteRow).m === 'r');
    if (replacing.length > 0 && !(await wasCleared(host, first.h))) {
      settle(
        replacing,
        failed(
          'E_GOOGLE_PLAN',
          'the clear this plan starts with was not applied, so these rows would land among the ' +
            `tab's old ones; ${PLAN_AGAIN}`,
        ),
      );
    }
    const rows = rowIndexes();
    const numbers = rows.map((index) => (decoded[index] as WriteRow).k);
    if (numbers.length > 0) {
      const filled = await filledRows(
        client,
        spreadsheetId,
        tab,
        Math.min(...numbers),
        Math.max(...numbers),
      );
      if (!filled.ok) {
        if (refusedForTime()) return done();
        settle(rows, failedWith(filled.error));
        return done();
      }
      for (const index of rows) {
        const row = decoded[index] as WriteRow;
        if (filled.value.has(row.k)) {
          settle(
            [index],
            failed(
              'E_GOOGLE_CHANGED',
              `row ${row.k} of the tab '${tab.title}' holds values the plan did not see, so ` +
                `writing it would overwrite them; ${PLAN_AGAIN}`,
            ),
          );
        }
      }
    }
  }

  if (expired()) return done();
  const writing = pending();
  if (writing.length === 0) return done();
  const requests = requestsOf(
    tab,
    writing.map((index) => decoded[index] as Decoded),
  );
  if (requests.length > 0) {
    const sent = await client.post(`${SHEETS}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, {
      requests,
    });
    if (!sent.ok) {
      if (refusedForTime()) return done();
      settle(writing, batchFailed(sent.error));
      return done();
    }
  }
  settle(writing, { status: 'applied' });
  if (clearsHere) await markCleared(host, first.h);
  for (const index of writing) {
    const ck = (decoded[index] as Partial<WriteRow>).ck;
    if (ck !== undefined) await forget(host, ck);
  }
  return done();
}

/**
 * The batchUpdate's requests: the clear, then the grid grown to hold every row and column
 * written, then one `updateCells` per row. A blank row needs no request: the tab is empty
 * there, checked or cleared.
 */
function requestsOf(tab: GridTab, operations: readonly Decoded[]): unknown[] {
  const requests: unknown[] = [];
  const { sheetId } = tab;
  if (operations.some((each) => each.kind === 'clear')) {
    requests.push({ updateCells: { range: { sheetId }, fields: WRITTEN_FIELDS } });
  }
  const rows = operations.filter((each): each is WriteRow => each.kind === 'row');
  const lastRow = Math.max(0, ...rows.map((row) => row.k));
  const width = Math.max(0, ...rows.map((row) => row.c.length));
  if (lastRow > tab.rowCount) {
    requests.push({
      appendDimension: { sheetId, dimension: 'ROWS', length: lastRow - tab.rowCount },
    });
  }
  if (width > tab.columnCount) {
    requests.push({
      appendDimension: { sheetId, dimension: 'COLUMNS', length: width - tab.columnCount },
    });
  }
  for (const row of rows) {
    if (row.c.length === 0) continue;
    requests.push({
      updateCells: {
        range: {
          sheetId,
          startRowIndex: row.k - 1,
          endRowIndex: row.k,
          startColumnIndex: 0,
          endColumnIndex: row.c.length,
        },
        rows: [{ values: row.c.map(cellData) }],
        fields: WRITTEN_FIELDS,
      },
    });
  }
  return requests;
}

/** A planned failure's reason, an operation this version writes, or why it reads none. */
async function decodeOperation(
  host: ApplyHost,
  write: string,
  payload: JsonValue | undefined,
): Promise<Decoded | string> {
  const object = recordOf(payload);
  if (object === undefined) return UNREADABLE;
  const planned = object['x'];
  if (typeof planned === 'string') return planned;
  if (write === 'clear') {
    const { h, s } = object;
    return isDigest(h) && isSheet(s) ? { kind: 'clear', h, s } : UNREADABLE;
  }
  if (write !== 'write-row') return UNREADABLE;
  const ck = object['ck'];
  const cd = object['cd'];
  if (typeof ck === 'string' && typeof cd === 'string') {
    const kept = await spilled(host, ck, cd);
    if (typeof kept === 'string') return kept;
    const row = rowOf(kept);
    return row === undefined ? UNREADABLE : { ...row, ck };
  }
  return rowOf(object) ?? UNREADABLE;
}

function rowOf(object: Readonly<Record<string, JsonValue>>): WriteRow | undefined {
  const { k, h, s, m, c } = object;
  if (
    typeof k !== 'number' ||
    !Number.isSafeInteger(k) ||
    k < 1 ||
    !isDigest(h) ||
    !isSheet(s) ||
    (m !== 'r' && m !== 'a') ||
    !Array.isArray(c)
  ) {
    return undefined;
  }
  const cells: WriteCell[] = [];
  for (const cell of c as readonly JsonValue[]) {
    const read = readWriteCell(cell);
    if (read === undefined) return undefined;
    cells.push(read);
  }
  return { kind: 'row', k, h, s, m, c: cells };
}

/** A row's payload kept in the cache at plan time, or why it cannot be had. */
export async function spilled(
  host: ApplyHost,
  key: string,
  digest: string,
): Promise<Readonly<Record<string, JsonValue>> | string> {
  let stored;
  try {
    stored = await host.cache.get(key);
  } catch (thrown) {
    return `E_GOOGLE_PLAN: the row's cells, kept in the plugin's cache, could not be read (${messageOf(thrown)}); ${PLAN_AGAIN}`;
  }
  if (stored === undefined) {
    return `E_GOOGLE_PLAN: the row's cells were kept in the plugin's cache, which no longer holds them; ${PLAN_AGAIN}`;
  }
  const text = new TextDecoder().decode(stored.bytes);
  if (fingerprint(text) !== digest) {
    return `E_GOOGLE_PLAN: the plugin's cache holds other cells for this row than the plan kept; ${PLAN_AGAIN}`;
  }
  try {
    return recordOf(JSON.parse(text) as JsonValue) ?? UNREADABLE;
  } catch {
    return UNREADABLE;
  }
}

export const UNREADABLE = `E_GOOGLE_PLAN: this operation carries no payload this version of the plugin reads; ${PLAN_AGAIN}`;

async function wasCleared(host: ApplyHost, digest: string): Promise<boolean> {
  try {
    return (await host.cache.get(clearedKey(digest))) !== undefined;
  } catch {
    return false;
  }
}

async function markCleared(host: ApplyHost, digest: string): Promise<void> {
  try {
    await host.cache.put(clearedKey(digest), new Date().toISOString());
  } catch (thrown) {
    host.log.warn(
      `google.sheet-write could not remember that the tab was cleared (${messageOf(thrown)}); ` +
        "the plan's later batches will fail and ask for a new plan",
    );
  }
}

export async function forget(host: ApplyHost, key: string): Promise<void> {
  try {
    await host.cache.delete(key);
  } catch {
    // An entry left behind is forgotten with its plan's age.
  }
}

/** How a refused or lost batchUpdate went for each of its operations. */
export function batchFailed(error: GoogleError): AppliedOperation {
  const lost =
    (error.status !== undefined && error.status >= 500) ||
    (error.code === 'E_GOOGLE_NETWORK' && error.hostCode === undefined);
  return {
    status: 'failed',
    reason: lost
      ? `${describeGoogleError(error)} This batch may have been written: Google did not say. ` +
        'Read the tab before you apply again.'
      : `${describeGoogleError(error)} None of this batch was written: Google writes a batch ` +
        'whole or not at all.',
  };
}

export function failed(code: GoogleError['code'], reason: string): AppliedOperation {
  return { status: 'failed', reason: `${code}: ${reason}` };
}

export function failedWith(error: GoogleError): AppliedOperation {
  return { status: 'failed', reason: describeGoogleError(error) };
}

/** A reason within the host's 500 characters, the code kept first. */
export function shortReason(outcome: AppliedOperation): Partial<AppliedOperation> {
  const { reason } = outcome;
  if (reason === undefined || reason.length <= 500) return {};
  return { reason: `${reason.slice(0, 499)}…` };
}

export function isDigest(value: JsonValue | undefined): value is string {
  return typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);
}

export function isSheet(value: JsonValue | undefined): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]+\/\d+$/.test(value);
}

export function recordOf(
  value: JsonValue | undefined,
): Readonly<Record<string, JsonValue>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, JsonValue>>)
    : undefined;
}

const wait = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));
