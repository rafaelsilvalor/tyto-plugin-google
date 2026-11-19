import { connectAsPerson } from './connect.js';
import { isPlannedFailure } from './drive-create.js';
import {
  alreadyFetched,
  FETCH_WRITE,
  isFetchPayload,
  localEntry,
  REPLACE_LOCAL_WRITE,
  type FetchHost,
  type FetchPayload,
} from './drive-fetch.js';
import { downloadBytes } from './drive-files.js';
import { describeGoogleError, messageOf } from './errors.js';
import type { GoogleClient } from './http.js';
import {
  APPLY_BUDGET_MILLISECONDS,
  budgetedTransport,
  systemClock,
  type WriteClock,
} from './sheet-write-apply.js';
import { shortened } from './sheet-write.js';
import type { AppliedOperation, ApplyAnswer, ApplyRequest } from './verb.js';

/** How one file ended in this call; `undefined` when time ran out before it was written. */
type Ended = AppliedOperation | undefined;

/**
 * One batch of a `google.drive-fetch` plan, in its order: each file is downloaded whole and
 * written whole through `host.workspace.write`. A download is not started when the last one's
 * time would not fit the call's 20 s budget; what this call did not reach answers `continue`,
 * saying how many it fetched, and the host asks again within the same Apply (Tyto ADR 0216).
 * A file has no part to resume: one cut short is downloaded again from its start.
 */
export async function applyDriveFetches(
  host: FetchHost,
  request: ApplyRequest,
  clock: WriteClock = systemClock,
): Promise<ApplyAnswer> {
  const deadline = clock.now() + APPLY_BUDGET_MILLISECONDS;
  const outcomes: Ended[] = request.operations.map(() => undefined);
  const budget = budgetedTransport(host, clock);
  const client = connectAsPerson(host, budget.transport);
  const fetches = request.operations.filter((each) => !isPlannedFailure(each.payload)).length;
  let fetched = 0;
  let lastDownload: number | undefined;
  for (const [index, operation] of request.operations.entries()) {
    const payload = operation.payload;
    if (isPlannedFailure(payload)) {
      outcomes[index] = failed(payload.x);
      continue;
    }
    if (
      (operation.write !== FETCH_WRITE && operation.write !== REPLACE_LOCAL_WRITE) ||
      !isFetchPayload(payload)
    ) {
      outcomes[index] = failed(
        'E_GOOGLE_PLAN: not a write this plugin planned; run the cell again',
      );
      continue;
    }
    if (budget.expired()) break;
    // A download cut by the host's deadline would lose the whole batch's answer.
    if (lastDownload !== undefined && clock.now() + lastDownload * 1.5 > deadline) break;
    const before = clock.now();
    const ended = await fetchOne(host, client, payload, () => budget.refusedForTime());
    if (ended === undefined) break;
    lastDownload = clock.now() - before;
    outcomes[index] = ended;
    if (ended.status === 'applied') fetched += 1;
  }
  const progress = `fetched ${fetched} of ${fetches} ${fetches === 1 ? 'file' : 'files'}`;
  return {
    ok: true,
    value: {
      operations: outcomes.map((outcome) => outcome ?? { status: 'continue', progress }),
    },
    diagnostics: [],
  };
}

async function fetchOne(
  host: FetchHost,
  client: GoogleClient,
  payload: FetchPayload,
  refusedForTime: () => boolean,
): Promise<Ended> {
  const local = await localState(host, payload);
  if (local === 'fetched') return { status: 'applied' };
  if (local !== 'as-planned') return failed(local);
  const downloaded = await downloadBytes(client, payload.i);
  if (!downloaded.ok) {
    return refusedForTime() ? undefined : failed(describeGoogleError(downloaded.error));
  }
  if (downloaded.value.length !== payload.s) {
    return failed(
      `E_GOOGLE_CHANGED: Drive's file for '${payload.w}' is ${downloaded.value.length} bytes, ` +
        `not the ${payload.s} the plan saw; run the cell again`,
    );
  }
  try {
    await host.workspace.write(payload.w, downloaded.value);
  } catch (thrown) {
    return failed(`'${payload.w}' could not be written: ${messageOf(thrown)}`);
  }
  return { status: 'applied' };
}

/**
 * The local file against the plan: `fetched` when it already is Drive's (an Apply run twice),
 * `as-planned` when it is what the plan saw, or why it is neither. A file a person put or
 * changed there since the plan is never written over.
 */
async function localState(
  host: FetchHost,
  payload: FetchPayload,
): Promise<'fetched' | 'as-planned' | string> {
  const now = await localEntry(host, payload.w);
  if (typeof now === 'string') return now;
  if (now !== undefined && alreadyFetched(now, payload.s, payload.m)) return 'fetched';
  const same =
    now === undefined
      ? payload.ls === undefined
      : payload.ls === now.size && Date.parse(payload.lm ?? '') === Date.parse(now.modifiedAt);
  if (same) return 'as-planned';
  return `E_GOOGLE_CHANGED: '${payload.w}' changed in the workspace since the plan; run the cell again`;
}

function failed(reason: string): AppliedOperation {
  return { status: 'failed', reason: shortened(reason) };
}
