import type { PluginHost } from '@tyto/plugin-api';

import { folderIdOf, readSection } from './config.js';
import { connectAsPerson } from './connect.js';
import {
  childrenNamed,
  childrenNamedOfType,
  DRIVE_FILES,
  getFile,
  textArgument,
  type DriveFile,
} from './drive-files.js';
import { FOLDER_MIME_TYPE } from './drive-query.js';
import { rootWalk, type RootWalk } from './drive-root.js';
import { describeGoogleError, googleOk, type GoogleError, type GoogleResult } from './errors.js';
import type { GoogleClient } from './http.js';
import {
  budgetedTransport,
  NOT_REACHED,
  systemClock,
  type WriteClock,
} from './sheet-write-apply.js';
import { listed, MAX_OPERATIONS, shortened } from './sheet-write.js';
import {
  argumentsProblem,
  verbFailed,
  type AppliedOperation,
  type ApplyAnswer,
  type ApplyRequest,
  type ArgumentSpec,
  type Diagnostic,
  type PlanAnswer,
  type PlannedOperation,
  type PlanRequest,
  type Row,
  type Table,
} from './verb.js';

/**
 * Planning and applying "create an item in Drive, as the person, and share it": shared by
 * `google.drive-folder` and `google.sheet-create`.
 *
 * Everything is created as the signed-in person, never as the service account, which owns no
 * storage in a person's Drive, and is shared only with the people a row lists: the service
 * account is never given access (the maintainer's decision of 2026-11-11, which retires it
 * once the sign-in works).
 */
export const CREATE_WRITE = 'create';
export const SHARE_WRITE = 'share';

export type CreateHost = Pick<PluginHost, 'fetch' | 'signin'>;

/** What differs between the verbs that create: the verb, the kind of item and its link. */
export interface CreateKind {
  readonly verb: string;
  /** `folder`, as a description says it: `create folder "<name>" in …`. */
  readonly noun: string;
  readonly mimeType: string;
  /** The item's page in Drive, known before it exists because its id is generated first. */
  link(id: string): string;
}

/** The arguments every creating verb takes. */
export const CREATE_ARGUMENTS: readonly ArgumentSpec[] = [
  { name: 'name', type: 'text' },
  { name: 'parent', type: 'text' },
  { name: 'share', type: 'text' },
  { name: 'notify', type: 'text', values: ['yes', 'no'] },
];

/** The column holding each item's name when `name=` names none. */
const DEFAULT_NAME_COLUMN = 'name';
/** A name longer than this is refused, so a payload stays far under the plugin contract's. */
export const MAX_NAME_LENGTH = 500;
/** Drive's ceiling on one `files.generateIds` call. */
const IDS_PER_CALL = 1000;

/** The roles `share=` may give, as Drive names them. */
export const SHARE_ROLES: readonly string[] = ['reader', 'commenter', 'writer'];

/**
 * Drive's roles from weakest to strongest: a person who holds a role at least as strong as the
 * one a row gives already has that access, and is not shared with again. Sharing again with a
 * weaker role could lower theirs, and this plugin never takes access away.
 */
const ROLE_STRENGTH: readonly string[] = [
  'reader',
  'commenter',
  'writer',
  'fileOrganizer',
  'organizer',
  'owner',
];
/** Drive's ceiling on one `permissions.list` page. */
const PERMISSIONS_PAGE_SIZE = 100;

/** What a `create` payload holds: the generated id, the name, the parent folder, the type. */
export interface CreatePayload {
  readonly c: string;
  readonly n: string;
  readonly p: string;
  readonly m: string;
}

/** What a `share` payload holds: the item's id and name, who, which role, whether to email. */
export interface SharePayload {
  readonly s: string;
  readonly n: string;
  readonly e: string;
  readonly r: string;
  readonly notify: boolean;
}

export interface Share {
  readonly email: string;
  readonly role: string;
}

const OUT_OF_TIME =
  "could not check every row in one call's time; narrow the table to fewer rows and run again";

/**
 * Plans one item per row, each followed by its shares: the people of the row's `share=`
 * column, and nobody else.
 *
 * The parent is `parent=` or the section's `root`, and must be under the root. **A second run
 * creates nothing twice**: a row whose item already exists in the parent (same name, same
 * type, not in the trash) creates nothing, with a warning, and plans only the shares the item
 * lacks (Drive's `permissions.list`), so a share that failed before is tried again; two rows
 * of one name fail the second;
 * several existing items of the name stop the plan, as a move's ambiguous destination does.
 * Each new item's id is generated now (Drive's `files.generateIds`), so the plan shows the
 * link it will have and its shares name it.
 */
export async function planCreates(
  host: CreateHost,
  request: PlanRequest,
  kind: CreateKind,
  clock: WriteClock = systemClock,
): Promise<PlanAnswer> {
  const problem = (text: string): PlanAnswer => refused(argumentsProblem(kind.verb, text));
  const { table } = request;
  const nameColumn = columnOf(
    table,
    'name',
    textArgument(request.arguments, 'name') ?? DEFAULT_NAME_COLUMN,
  );
  if (nameColumn.problem !== undefined) return problem(nameColumn.problem);
  const shareWritten = textArgument(request.arguments, 'share');
  const shareColumn =
    shareWritten === undefined ? undefined : columnOf(table, 'share', shareWritten);
  if (shareColumn?.problem !== undefined) return problem(shareColumn.problem);
  const notify = textArgument(request.arguments, 'notify') === 'yes';

  const section = readSection(request.section);
  if (!section.ok) return refused(verbFailed(kind.verb, section.error));
  const rootId = section.value.root;
  if (rootId === undefined) {
    return problem(
      `needs root in the google section of .tyto/project.json: it creates only under it`,
    );
  }

  const budget = budgetedTransport(host, clock);
  const client = connectAsPerson(host, budget.transport);
  const walk = rootWalk(client, rootId);
  const failedFor = (error: GoogleError): PlanAnswer =>
    budget.refusedForTime()
      ? refused({
          severity: 'error',
          code: 'E_RECIPE_VERB',
          message: `'${kind.verb}' ${OUT_OF_TIME}.`,
        })
      : refused(verbFailed(kind.verb, error));

  const parent = await parentOf(walk, rootId, textArgument(request.arguments, 'parent'));
  if (!parent.ok) return 'error' in parent ? failedFor(parent.error) : problem(parent.problem);
  const parentFolder = parent.folder;

  /** Each row, before ids: a failure the plan already knows, or what to create. */
  const planned: (
    | { readonly row: Row; readonly failure: string }
    | {
        readonly row: Row;
        readonly name: string;
        readonly shares: readonly Share[];
        /** The item of the name already in the parent: only its missing shares are planned. */
        readonly existingId?: string;
      }
  )[] = [];
  const firstRowOf = new Map<string, string>();
  const alreadyThere: string[] = [];
  const sharingOnly: string[] = [];
  for (const row of table.rows) {
    const written = row.values[nameColumn.name];
    const name = typeof written === 'string' ? written.trim() : '';
    if (name === '') {
      planned.push({ row, failure: `${nameColumn.name} holds no name` });
      continue;
    }
    if (name.length > MAX_NAME_LENGTH) {
      planned.push({
        row,
        failure: `the name in ${nameColumn.name} is over ${MAX_NAME_LENGTH} characters`,
      });
      continue;
    }
    const first = firstRowOf.get(name);
    if (first !== undefined) {
      planned.push({ row, failure: `'${name}' is the name of row ${first} too` });
      continue;
    }
    firstRowOf.set(name, row.key);
    const shares =
      shareColumn === undefined ? [] : parseShares(row.values[shareColumn.name], shareColumn.name);
    if (typeof shares === 'string') {
      planned.push({ row, failure: shares });
      continue;
    }
    const existing = await childrenNamedOfType(client, parentFolder.id, name, kind.mimeType);
    if (!existing.ok) return failedFor(existing.error);
    if (existing.value.length > 1) {
      return problem(
        `finds ${existing.value.length} items named '${name}' in '${parentFolder.name}' ` +
          `(${parentFolder.id}): ${listed(existing.value.map((each) => each.id))}; ` +
          'keep one, or rename the others, and run again',
      );
    }
    const found = existing.value[0];
    if (found !== undefined) {
      // Already there: nothing is created, and only the shares it lacks are planned, so a share
      // that failed on an earlier run is tried again.
      const lacking =
        shares.length === 0 ? googleOk([]) : await missingSharesOf(client, found.id, shares);
      if (!lacking.ok) return failedFor(lacking.error);
      if (lacking.value.length === 0) alreadyThere.push(name);
      else {
        sharingOnly.push(name);
        planned.push({ row, name, shares: lacking.value, existingId: found.id });
      }
      continue;
    }
    planned.push({ row, name, shares });
  }

  const creating = planned.filter((each) => 'name' in each && each.existingId === undefined).length;
  const ids = await generateIds(client, creating);
  if (!ids.ok) return failedFor(ids.error);

  const operations: PlannedOperation[] = [];
  let next = 0;
  for (const each of planned) {
    if (!('name' in each)) {
      operations.push(plannedFailure(each.row, each.failure));
      continue;
    }
    const { row, name } = each;
    let id = each.existingId;
    if (id === undefined) {
      id = ids.value[next];
      next += 1;
      if (id === undefined) return failedFor(malformedIds());
      const create: CreatePayload = { c: id, n: name, p: parentFolder.id, m: kind.mimeType };
      operations.push({
        write: CREATE_WRITE,
        rowKey: row.key,
        description: shortened(
          `create ${kind.noun} "${name}" in '${parentFolder.name}' (${parentFolder.id}), ` +
            `at ${kind.link(id)}`,
        ),
        payload: { ...create },
      });
    }
    for (const share of each.shares) {
      const payload: SharePayload = { s: id, n: name, e: share.email, r: share.role, notify };
      operations.push({
        write: SHARE_WRITE,
        rowKey: row.key,
        description: shortened(
          `share "${name}" with ${share.email} as ${share.role}` +
            (notify ? ', emailing them' : ''),
        ),
        payload: { ...payload },
      });
    }
  }
  if (operations.length > MAX_OPERATIONS) {
    return problem(
      `would plan ${operations.length.toLocaleString('en-US')} operations, over the ` +
        `${MAX_OPERATIONS.toLocaleString('en-US')} one plan holds; split the table`,
    );
  }

  const where = `'${parentFolder.name}' (${parentFolder.id})`;
  const diagnostics: Diagnostic[] = [];
  if (alreadyThere.length > 0) {
    diagnostics.push(
      warning(`'${kind.verb}' plans nothing for ${listed(alreadyThere)}: already in ${where}.`),
    );
  }
  if (sharingOnly.length > 0) {
    diagnostics.push(
      warning(
        `'${kind.verb}' creates nothing for ${listed(sharingOnly)}: already in ${where}; ` +
          'it plans only the shares they lack.',
      ),
    );
  }
  return {
    ok: true,
    value: {
      target: `Drive folder '${parentFolder.name}' (${parentFolder.id})`,
      operations,
      count: operations.length,
    },
    diagnostics,
  };
}

type Parent =
  | { readonly ok: true; readonly folder: DriveFile }
  | { readonly ok: false; readonly error: GoogleError }
  | { readonly ok: false; readonly problem: string };

/**
 * `parent=` as a folder under the root: a folder of that name directly in the root, else the
 * folder of that id or address; the root itself when the step names none. A missing one, a
 * file, or a folder outside the root stops the plan: this version creates no parent.
 */
async function parentOf(
  walk: RootWalk,
  rootId: string,
  written: string | undefined,
): Promise<Parent> {
  let candidate: DriveFile | undefined;
  if (written === undefined) {
    const read = await walk.describe(rootId);
    if (!read.ok) return read;
    candidate = read.value;
  } else {
    if (!/^https:\/\//i.test(written)) {
      const named = await childrenNamed(walk.client, rootId, written);
      if (!named.ok) return named;
      const folders = named.value.filter((each) => each.mimeType === FOLDER_MIME_TYPE);
      if (folders.length > 1) {
        return {
          ok: false,
          problem:
            `parent= names '${written}', and ${folders.length} folders of that name are in ` +
            `the root folder: ${listed(folders.map((each) => each.id))}; name one by its id`,
        };
      }
      candidate = folders[0];
    }
    const id = folderIdOf(written);
    if (candidate === undefined && id !== undefined) {
      const read = await walk.describe(id);
      if (read.ok) candidate = read.value;
      else if (read.error.status !== 404) return read;
    }
    if (candidate === undefined) {
      return {
        ok: false,
        problem:
          `parent= names '${written}', which is neither a folder directly in the root folder ` +
          'nor a folder id or address the signed-in account can read; this version creates ' +
          'no parent folder',
      };
    }
  }
  if (candidate.mimeType !== FOLDER_MIME_TYPE) {
    return { ok: false, problem: `parent= names '${candidate.name}', which is not a folder` };
  }
  const verdict = await walk.verdict(candidate.id);
  if (!verdict.ok) return verdict;
  if (!verdict.value.under) {
    return {
      ok: false,
      problem:
        `parent= names '${candidate.name}', which is not under the root folder ${rootId}: ` +
        verdict.value.why,
    };
  }
  return { ok: true, folder: candidate };
}

/** `count` new ids for the person's Drive, at most 1,000 a call. */
async function generateIds(
  client: GoogleClient,
  count: number,
): Promise<GoogleResult<readonly string[]>> {
  const ids: string[] = [];
  while (ids.length < count) {
    const asked = Math.min(IDS_PER_CALL, count - ids.length);
    const answer = await client.get(`${DRIVE_FILES}/generateIds`, {
      count: asked,
      space: 'drive',
      type: 'files',
    });
    if (!answer.ok) return answer;
    const record = answer.value;
    const got =
      typeof record === 'object' && record !== null && !Array.isArray(record)
        ? (record as Readonly<Record<string, unknown>>)['ids']
        : undefined;
    if (
      !Array.isArray(got) ||
      got.length !== asked ||
      !got.every((id) => typeof id === 'string' && /^[A-Za-z0-9_-]+$/.test(id))
    ) {
      return { ok: false, error: malformedIds() };
    }
    ids.push(...(got as string[]));
  }
  return { ok: true, value: ids };
}

function malformedIds(): GoogleError {
  return {
    code: 'E_GOOGLE_RESPONSE',
    message: 'Google answered files.generateIds without the ids asked for.',
  };
}

const warning = (message: string): Diagnostic => ({
  severity: 'warning',
  code: 'E_RECIPE_VERB',
  message: shortened(message),
});

/**
 * The people an item is shared with directly, by email, and their roles: every page of
 * Drive's `permissions.list`. A permission with no email (anyone with the link, a domain) is
 * left out; access a person has through a group is not seen, so they are shared with directly.
 */
export async function heldShares(
  client: GoogleClient,
  fileId: string,
): Promise<GoogleResult<readonly Share[]>> {
  const held: Share[] = [];
  let pageToken: string | undefined;
  do {
    const answer = await client.get(`${DRIVE_FILES}/${encodeURIComponent(fileId)}/permissions`, {
      fields: 'nextPageToken, permissions(emailAddress, role)',
      pageSize: PERMISSIONS_PAGE_SIZE,
      supportsAllDrives: true,
      ...(pageToken === undefined ? {} : { pageToken }),
    });
    if (!answer.ok) return answer;
    const record = recordOf(answer.value);
    const permissions = record?.['permissions'] ?? [];
    if (!Array.isArray(permissions)) {
      return {
        ok: false,
        error: {
          code: 'E_GOOGLE_RESPONSE',
          message: 'Google answered permissions.list without a list of permissions.',
        },
      };
    }
    for (const permission of permissions) {
      const each = recordOf(permission);
      const email = each?.['emailAddress'];
      const role = each?.['role'];
      if (typeof email === 'string' && typeof role === 'string') held.push({ email, role });
    }
    const next = record?.['nextPageToken'];
    pageToken = typeof next === 'string' && next !== '' ? next : undefined;
  } while (pageToken !== undefined);
  return googleOk(held);
}

/** The wanted shares nobody already holds at that role or a stronger one. */
export function missingShares(held: readonly Share[], wanted: readonly Share[]): readonly Share[] {
  const strength = (role: string): number => ROLE_STRENGTH.indexOf(role);
  return wanted.filter(
    (share) =>
      !held.some(
        (holder) =>
          holder.email.toLowerCase() === share.email.toLowerCase() &&
          strength(holder.role) >= strength(share.role),
      ),
  );
}

/** The shares an existing item lacks, or why Drive could not say. */
async function missingSharesOf(
  client: GoogleClient,
  fileId: string,
  wanted: readonly Share[],
): Promise<GoogleResult<readonly Share[]>> {
  const held = await heldShares(client, fileId);
  return held.ok ? googleOk(missingShares(held.value, wanted)) : held;
}

/**
 * A `share=` cell: `email:role; email:role`, each role `reader`, `commenter` or `writer`. A
 * blank cell shares with nobody. Anything else fails the row in the plan: an item half shared
 * is worse than one not created.
 */
export function parseShares(written: unknown, column: string): readonly Share[] | string {
  if (written === null || written === undefined) return [];
  if (typeof written !== 'string') return `${column} holds ${String(written)}, not email:role`;
  const shares: Share[] = [];
  for (const part of written.split(';')) {
    const entry = part.trim();
    if (entry === '') continue;
    const colon = entry.lastIndexOf(':');
    const email = (colon < 0 ? entry : entry.slice(0, colon)).trim();
    const role = colon < 0 ? '' : entry.slice(colon + 1).trim();
    if (!/^[^\s@:;,]+@[^\s@:;,]+$/.test(email)) {
      return `${column} holds '${entry}', which does not start with an email`;
    }
    if (!SHARE_ROLES.includes(role)) {
      return `${column} gives ${email} the role '${role}'; a role is ${SHARE_ROLES.join(', ')}`;
    }
    if (shares.some((each) => each.email.toLowerCase() === email.toLowerCase())) {
      return `${column} names ${email} twice`;
    }
    shares.push({ email, role });
  }
  return shares;
}

/**
 * One batch of a creating plan, as the person. Each `create` first looks for its name in the
 * parent: the item it already made (a retried Apply) is `applied`, another of the name since
 * the plan fails with `E_GOOGLE_CHANGED`. A create Drive refused, or whose answer was lost, is
 * checked by reading its generated id: if the item is there, it was made. A `share` whose
 * create failed in this batch fails with that reason and makes no request; a share the person
 * already holds at that role or a stronger one is `applied` with no request, so no role is
 * lowered; a share Drive refuses (a domain that forbids sharing outside it) fails alone.
 */
export async function applyCreates(
  host: CreateHost,
  request: ApplyRequest,
  clock: WriteClock = systemClock,
): Promise<ApplyAnswer> {
  const outcomes: (AppliedOperation | undefined)[] = request.operations.map(() => undefined);
  const done = (): ApplyAnswer => ({
    ok: true,
    value: {
      operations: outcomes.map((outcome) => outcome ?? { status: 'skipped', reason: NOT_REACHED }),
    },
    diagnostics: [],
  });
  const failed = (reason: string): AppliedOperation => ({
    status: 'failed',
    reason: shortened(reason),
  });

  const work: [number, CreatePayload | SharePayload][] = [];
  for (const [index, operation] of request.operations.entries()) {
    const payload = operation.payload;
    if (isPlannedFailure(payload)) outcomes[index] = failed(payload.x);
    else if (operation.write === CREATE_WRITE && isCreatePayload(payload)) {
      work.push([index, payload]);
    } else if (operation.write === SHARE_WRITE && isSharePayload(payload)) {
      work.push([index, payload]);
    } else {
      outcomes[index] = failed(
        'E_GOOGLE_PLAN: not a write this plugin planned; run the cell again',
      );
    }
  }
  if (work.length === 0) return done();

  const budget = budgetedTransport(host, clock);
  const client = connectAsPerson(host, budget.transport);
  /** The creates of this batch that failed, by the id they were to have, and why. */
  const createFailed = new Map<string, string>();
  /** Who holds each item this batch shares, read once per item and kept up to date. */
  const heldBy = new Map<string, Share[]>();
  for (const [index, payload] of work) {
    if (budget.expired()) break;
    if ('c' in payload) {
      const outcome = await create(client, payload);
      if (outcome === undefined || budget.refusedForTime()) break;
      if (outcome.status === 'failed') createFailed.set(payload.c, outcome.reason ?? 'failed');
      outcomes[index] = outcome;
      continue;
    }
    const why = createFailed.get(payload.s);
    if (why !== undefined) {
      outcomes[index] = failed(`creating '${payload.n}' failed, so it is not shared: ${why}`);
      continue;
    }
    let held = heldBy.get(payload.s);
    if (held === undefined) {
      const read = await heldShares(client, payload.s);
      if (!read.ok) {
        if (budget.refusedForTime()) break;
        outcomes[index] = failed(describeGoogleError(read.error));
        continue;
      }
      held = [...read.value];
      heldBy.set(payload.s, held);
    }
    const share: Share = { email: payload.e, role: payload.r };
    // Held already, at this role or a stronger one (an Apply run twice, or access given since
    // the plan): nothing is sent, so no role is ever lowered.
    if (missingShares(held, [share]).length === 0) {
      outcomes[index] = { status: 'applied' };
      continue;
    }
    const shared = await client.post(
      `${DRIVE_FILES}/${encodeURIComponent(payload.s)}/permissions`,
      { type: 'user', role: payload.r, emailAddress: payload.e },
      { sendNotificationEmail: payload.notify, supportsAllDrives: true, fields: 'id' },
    );
    if (!shared.ok) {
      if (budget.refusedForTime()) break;
      outcomes[index] = failed(describeGoogleError(shared.error));
      continue;
    }
    held.push(share);
    outcomes[index] = { status: 'applied' };
  }
  return done();
}

/** One create, or `undefined` when the call's time ran out before it was answered. */
async function create(
  client: GoogleClient,
  payload: CreatePayload,
): Promise<AppliedOperation | undefined> {
  const failed = (reason: string): AppliedOperation => ({
    status: 'failed',
    reason: shortened(reason),
  });
  const named = await childrenNamedOfType(client, payload.p, payload.n, payload.m);
  if (!named.ok) return failed(describeGoogleError(named.error));
  if (named.value.some((each) => each.id === payload.c)) return { status: 'applied' };
  if (named.value.length > 0) {
    return failed(
      `E_GOOGLE_CHANGED: '${payload.n}' was created in ${payload.p} since the plan, as ` +
        `${listed(named.value.map((each) => each.id))}; run the cell again for a new plan`,
    );
  }
  const made = await client.post(
    DRIVE_FILES,
    { id: payload.c, name: payload.n, mimeType: payload.m, parents: [payload.p] },
    { supportsAllDrives: true, fields: 'id' },
  );
  if (made.ok) return { status: 'applied' };
  // A refused create may be a retry of one that was made (Drive answers 409 for an id in use),
  // and a lost answer may hide one that was: the generated id tells.
  const there = await getFile(client, payload.c);
  if (there.ok && there.value.parents.includes(payload.p)) return { status: 'applied' };
  return failed(describeGoogleError(made.error));
}

function isPlannedFailure(value: unknown): value is { readonly x: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['x'] === 'string'
  );
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';

function isCreatePayload(value: unknown): value is CreatePayload {
  const record = recordOf(value);
  return (
    record !== undefined &&
    filled(record['c']) &&
    filled(record['n']) &&
    filled(record['p']) &&
    filled(record['m'])
  );
}

function isSharePayload(value: unknown): value is SharePayload {
  const record = recordOf(value);
  return (
    record !== undefined &&
    filled(record['s']) &&
    filled(record['n']) &&
    filled(record['e']) &&
    typeof record['r'] === 'string' &&
    SHARE_ROLES.includes(record['r']) &&
    typeof record['notify'] === 'boolean'
  );
}

/** A row the plan knows cannot be created: shown with the others, `failed` with no request. */
function plannedFailure(row: Row, reason: string): PlannedOperation {
  const text = shortened(`E_GOOGLE_PLAN: ${row.key}: ${reason}`);
  return {
    write: CREATE_WRITE,
    rowKey: row.key,
    description: shortened(`${row.key} (will fail: ${text})`),
    payload: { x: text },
  };
}

const refused = (diagnostic: Diagnostic): PlanAnswer => ({ ok: false, error: [diagnostic] });

/** A column by its name; case is ignored when only one column matches. */
function columnOf(
  table: Table,
  argument: string,
  name: string,
): { readonly name: string; readonly problem?: undefined } | { readonly problem: string } {
  if (table.columns.some((each) => each.name === name)) return { name };
  const matches = table.columns.filter((each) => each.name.toLowerCase() === name.toLowerCase());
  if (matches.length === 1 && matches[0] !== undefined) return { name: matches[0].name };
  return {
    problem:
      `${argument}= names the column '${name}', which the table does not have; its columns ` +
      `are ${listed(table.columns.map((each) => each.name))}`,
  };
}
