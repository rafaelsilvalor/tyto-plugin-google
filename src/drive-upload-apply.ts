import { connectAsPerson } from './connect.js';
import { create, isCreatePayload, isPlannedFailure } from './drive-create.js';
import { childrenNamed, getFile } from './drive-files.js';
import {
  isUploadPayload,
  REPLACE_WRITE,
  sameFile,
  sessionKey,
  sizeText,
  UPLOAD_WRITE,
  type UploadHost,
  type UploadPayload,
} from './drive-upload.js';
import { describeGoogleError, messageOf, type GoogleError } from './errors.js';
import { headerOf, type Answer, type GoogleClient } from './http.js';
import {
  APPLY_BUDGET_MILLISECONDS,
  budgetedTransport,
  NOT_REACHED,
  systemClock,
  type WriteClock,
} from './sheet-write-apply.js';
import { shortened } from './sheet-write.js';
import type { AppliedOperation, ApplyAnswer, ApplyRequest } from './verb.js';

/** Drive's upload endpoint, on the host the manifest already names. */
export const DRIVE_UPLOADS = 'https://www.googleapis.com/upload/drive/v3/files';
/** One chunk is one workspace part (ADR 0212): 32 x the 256 KiB a resumable upload asks. */
export const CHUNK_BYTES = 8 * 1024 * 1024;
/** Answers a chunk may get that are worth asking the session where it stands and going on. */
const RESUMES_PER_FILE = 3;

/** How one file's upload ended in this call; `undefined` when time ran out first. */
type Ended = AppliedOperation | undefined;

/**
 * One batch of a `google.drive-upload` plan, in its order: each `create` makes its folder as
 * `google.drive-folder` does; each `upload` or `replace` sends the file in chunks through a
 * resumable session, kept in the plugin's cache so the next Apply goes on where this one
 * stopped. Past the call's 20 s budget, what was not finished is `skipped`, saying how far it
 * got: the person runs the cell and applies again until it finishes.
 */
export async function applyDriveUploads(
  host: UploadHost,
  request: ApplyRequest,
  clock: WriteClock = systemClock,
): Promise<ApplyAnswer> {
  const deadline = clock.now() + APPLY_BUDGET_MILLISECONDS;
  const outcomes: Ended[] = request.operations.map(() => undefined);
  const failed = (reason: string): AppliedOperation => ({
    status: 'failed',
    reason: shortened(reason),
  });
  const budget = budgetedTransport(host, clock);
  const client = connectAsPerson(host, budget.transport);
  /** The folders this batch failed to create: what goes in them fails with that reason. */
  const notCreated = new Map<string, string>();
  for (const [index, operation] of request.operations.entries()) {
    const payload = operation.payload;
    if (isPlannedFailure(payload)) {
      outcomes[index] = failed(payload.x);
      continue;
    }
    if (budget.expired()) break;
    if (operation.write === 'create' && isCreatePayload(payload)) {
      const made = await create(client, payload);
      if (made === undefined || budget.refusedForTime()) break;
      if (made.status === 'failed') notCreated.set(payload.c, made.reason ?? 'failed');
      outcomes[index] = made;
      continue;
    }
    if (
      (operation.write !== UPLOAD_WRITE && operation.write !== REPLACE_WRITE) ||
      !isUploadPayload(payload)
    ) {
      outcomes[index] = failed(
        'E_GOOGLE_PLAN: not a write this plugin planned; run the cell again',
      );
      continue;
    }
    const why = notCreated.get(payload.p);
    if (why !== undefined) {
      outcomes[index] = failed(`its folder was not created, so it is not uploaded: ${why}`);
      continue;
    }
    const ended = await uploadOne({ host, client, clock, deadline, budget }, payload);
    if (ended === undefined) break;
    outcomes[index] = ended;
  }
  return {
    ok: true,
    value: {
      operations: outcomes.map((outcome) => outcome ?? { status: 'skipped', reason: NOT_REACHED }),
    },
    diagnostics: [],
  };
}

interface Sending {
  readonly host: UploadHost;
  readonly client: GoogleClient;
  readonly clock: WriteClock;
  readonly deadline: number;
  readonly budget: ReturnType<typeof budgetedTransport>;
}

/** One file, from where its session stands; `undefined` when time ran out before anything. */
async function uploadOne(sending: Sending, payload: UploadPayload): Promise<Ended> {
  const { host, client, clock, deadline, budget } = sending;
  const failed = (reason: string): AppliedOperation => ({
    status: 'failed',
    reason: shortened(reason),
  });
  const googleFailed = (error: GoogleError): Ended =>
    budget.refusedForTime() ? undefined : failed(describeGoogleError(error));
  const changed = await localChange(host, payload);
  if (changed !== undefined) return failed(changed);

  const key = sessionKey(payload);
  const kept = await cached(host, key);
  let sessionUrl = kept === undefined ? undefined : new TextDecoder().decode(kept);
  let offset = 0;
  if (sessionUrl !== undefined) {
    const where = await sessionState(client, sessionUrl, payload.s);
    if (!where.ok) {
      if (!expired(where.error)) return googleFailed(where.error);
      // A session Drive dropped (a week old, or cancelled) starts over.
      await forget(host, key);
      sessionUrl = undefined;
    } else if (where.value === 'done') return finished(sending, payload, key);
    else offset = where.value;
  }
  if (sessionUrl === undefined) {
    const there = await alreadyThere(client, payload);
    if (there !== undefined) return there.ok ? there.value : googleFailed(there.error);
    const started = await startSession(client, payload);
    if (!started.ok) return googleFailed(started.error);
    sessionUrl = started.value;
    await host.cache.put(key, sessionUrl).catch(() => undefined);
  }

  let lastChunk: number | undefined;
  let resumes = 0;
  while (offset < payload.s) {
    // A chunk is started only when the last one's time still fits: one cut by the host's
    // deadline would lose the whole batch's answer.
    if (lastChunk !== undefined && clock.now() + lastChunk * 1.5 > deadline) {
      return progress(offset, payload.s);
    }
    const length = Math.min(CHUNK_BYTES, payload.s - offset);
    let bytes: Uint8Array;
    try {
      bytes = await host.workspace.read(payload.u, { offset, length });
    } catch (thrown) {
      return failed(`'${payload.u}' could not be read: ${messageOf(thrown)}`);
    }
    if (bytes.length !== length) {
      return failed(`E_GOOGLE_CHANGED: '${payload.u}' changed while it was read; run again`);
    }
    const before = clock.now();
    const sent = await client.upload('PUT', sessionUrl, {
      headers: { 'Content-Range': `bytes ${offset}-${offset + length - 1}/${payload.s}` },
      body: bytes,
    });
    lastChunk = clock.now() - before;
    if (sent.ok) {
      if (sent.value.status !== 308) return finished(sending, payload, key);
      offset = heldUpTo(sent.value);
      continue;
    }
    if (budget.refusedForTime()) return progress(offset, payload.s);
    if (expired(sent.error)) {
      await forget(host, key);
      return failed(`${describeGoogleError(sent.error)}; the upload starts over on the next run`);
    }
    // A chunk lost on the way (a 5xx, no answer) may have arrived in part: ask the session.
    const transient = sent.error.code === 'E_GOOGLE_NETWORK' || (sent.error.status ?? 0) >= 500;
    if (!transient || resumes >= RESUMES_PER_FILE) return failed(describeGoogleError(sent.error));
    resumes += 1;
    const where = await sessionState(client, sessionUrl, payload.s);
    if (!where.ok) return googleFailed(where.error);
    if (where.value === 'done') return finished(sending, payload, key);
    offset = where.value;
  }
  // An empty file has no chunk: asking the session with nothing to send completes it.
  const last = await sessionState(client, sessionUrl, payload.s);
  if (!last.ok) return googleFailed(last.error);
  if (last.value === 'done') return finished(sending, payload, key);
  return failed('E_GOOGLE_HTTP: Drive did not finish the upload after its last byte; run again');
}

/** The session done: forgotten, and the local file checked once more for a change mid-way. */
async function finished(sending: Sending, payload: UploadPayload, key: string): Promise<Ended> {
  await forget(sending.host, key);
  const changed = await localChange(sending.host, payload);
  if (changed === undefined) return { status: 'applied' };
  return {
    status: 'failed',
    reason: shortened(`${changed}; it changed while it was sent, and the next run sends it again`),
  };
}

/**
 * The session an earlier Apply kept. A host with no cache keeps none, so its uploads cannot go
 * on across Applies and start over each time: the same answer as a session Drive dropped.
 */
async function cached(host: UploadHost, key: string): Promise<Uint8Array | undefined> {
  try {
    return (await host.cache.get(key))?.bytes;
  } catch {
    return undefined;
  }
}

async function forget(host: UploadHost, key: string): Promise<void> {
  await host.cache.delete(key).catch(() => false);
}

/** Why the local file is not the one the plan saw, or `undefined` when it is. */
async function localChange(host: UploadHost, payload: UploadPayload): Promise<string | undefined> {
  try {
    const now = await host.workspace.stat(payload.u);
    if (
      now.kind === 'file' &&
      now.size === payload.s &&
      Date.parse(now.modifiedAt) === Date.parse(payload.m)
    ) {
      return undefined;
    }
    return `E_GOOGLE_CHANGED: '${payload.u}' changed since the plan; run the cell again`;
  } catch (thrown) {
    return `'${payload.u}' could not be read: ${messageOf(thrown)}`;
  }
}

/**
 * Before a new session: a file this plan already sent (an Apply run twice) is `applied` with
 * nothing sent; a file of the name put in the folder since the plan stops this one.
 */
async function alreadyThere(
  client: GoogleClient,
  payload: UploadPayload,
): Promise<{ ok: true; value: AppliedOperation } | { ok: false; error: GoogleError } | undefined> {
  if (payload.r !== undefined) {
    const now = await getFile(client, payload.r);
    if (!now.ok) return now;
    return sameFile(now.value, payload.s, payload.m)
      ? { ok: true, value: { status: 'applied' } }
      : undefined;
  }
  const named = await childrenNamed(client, payload.p, payload.n);
  if (!named.ok) return named;
  if (named.value.length === 0) return undefined;
  if (named.value.some((each) => sameFile(each, payload.s, payload.m))) {
    return { ok: true, value: { status: 'applied' } };
  }
  return {
    ok: true,
    value: {
      status: 'failed',
      reason: shortened(
        `E_GOOGLE_CHANGED: a file named '${payload.n}' was put in ${payload.p} since the plan; ` +
          'run the cell again for a new plan',
      ),
    },
  };
}

/**
 * Opens a resumable session: a new file in its folder, or new content for the planned file,
 * whose id stays. The local modification time goes with it, so the next plan sees the same.
 */
async function startSession(
  client: GoogleClient,
  payload: UploadPayload,
): Promise<{ ok: true; value: string } | { ok: false; error: GoogleError }> {
  const started = await client.upload(
    payload.r === undefined ? 'POST' : 'PATCH',
    payload.r === undefined ? DRIVE_UPLOADS : `${DRIVE_UPLOADS}/${encodeURIComponent(payload.r)}`,
    {
      query: { uploadType: 'resumable', supportsAllDrives: true, fields: 'id' },
      headers: { 'X-Upload-Content-Length': String(payload.s) },
      body:
        payload.r === undefined
          ? { name: payload.n, parents: [payload.p], modifiedTime: payload.m }
          : { modifiedTime: payload.m },
    },
  );
  if (!started.ok) return started;
  const location = headerOf(started.value.headers, 'location');
  if (location === undefined || !location.startsWith(`${DRIVE_UPLOADS}?`)) {
    return {
      ok: false,
      error: {
        code: 'E_GOOGLE_RESPONSE',
        message: `Drive opened no upload session for '${payload.n}' at its own address.`,
      },
    };
  }
  return { ok: true, value: location };
}

/** Where a session stands: `done`, or the first byte Drive does not hold yet. */
async function sessionState(
  client: GoogleClient,
  url: string,
  size: number,
): Promise<{ ok: true; value: number | 'done' } | { ok: false; error: GoogleError }> {
  const asked = await client.upload('PUT', url, {
    headers: { 'Content-Range': `bytes */${size}` },
    body: new Uint8Array(0),
  });
  if (!asked.ok) return asked;
  return { ok: true, value: asked.value.status === 308 ? heldUpTo(asked.value) : 'done' };
}

/** A 308's `Range: bytes=0-<last>` as the next byte to send; no `Range` is none held. */
function heldUpTo(answer: Answer): number {
  const range = /^bytes=0-(\d+)$/.exec(headerOf(answer.headers, 'range')?.trim() ?? '');
  return range?.[1] === undefined ? 0 : Number(range[1]) + 1;
}

/** Drive's answer for a session it no longer has. */
function expired(error: GoogleError): boolean {
  return error.status === 404 || error.status === 410;
}

function progress(offset: number, size: number): AppliedOperation {
  return {
    status: 'skipped',
    reason:
      `sent ${sizeText(offset)} of ${sizeText(size)} in this call's time; run the cell and ` +
      'Apply again to go on from there',
  };
}
