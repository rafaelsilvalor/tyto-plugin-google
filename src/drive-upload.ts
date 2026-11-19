import type { PluginHost, RecipeVerbContribution, WorkspaceEntry } from '@tyto/plugin-api';

import { readSection } from './config.js';
import { connect } from './connect.js';
import { fingerprint } from './cursor.js';
import {
  columnOf,
  CREATE_WRITE,
  generateIds,
  MAX_NAME_LENGTH,
  plannedFailure,
  warning,
  type CreatePayload,
} from './drive-create.js';
import {
  childrenNamed,
  childrenNamedOfType,
  getFile,
  listChildren,
  textArgument,
  type DriveFile,
} from './drive-files.js';
import { destinationOf, type Destination } from './drive-move.js';
import { FOLDER_MIME_TYPE } from './drive-query.js';
import { rootWalk } from './drive-root.js';
import { applyDriveUploads } from './drive-upload-apply.js';
import { googleOk, messageOf, type GoogleError, type GoogleResult } from './errors.js';
import { plannedFolderId, rememberPlannedFolder } from './planned-folder.js';
import { budgetedTransport, systemClock, type WriteClock } from './sheet-write-apply.js';
import { listed, MAX_OPERATIONS, shortened } from './sheet-write.js';
import {
  argumentsProblem,
  verbFailed,
  type ArgumentSpec,
  type Diagnostic,
  type PlanAnswer,
  type PlannedOperation,
  type PlanRequest,
  type Row,
  type Table,
} from './verb.js';

export const DRIVE_UPLOAD = 'google.drive-upload';
export const UPLOAD_WRITE = 'upload';
export const REPLACE_WRITE = 'replace';
/** How many folders deep a local folder is walked, as far as the root walk looks up. */
export const MAX_DEPTH = 6;

const ARGUMENTS: readonly ArgumentSpec[] = [
  { name: 'from', type: 'text' },
  { name: 'to', type: 'text' },
  { name: 'to-column', type: 'text' },
];

export type UploadHost = Pick<PluginHost, 'fetch' | 'signin' | 'cache' | 'workspace'>;

/**
 * What an `upload` or a `replace` payload holds: the workspace path, the name in Drive, the
 * Drive folder, the size and the local modification time the plan saw, and, for a replace, the
 * Drive file whose content is replaced (its id stays).
 */
export interface UploadPayload {
  readonly u: string;
  readonly n: string;
  readonly p: string;
  readonly s: number;
  readonly m: string;
  readonly r?: string;
}

/**
 * `google.drive-upload from=<column> to=<folder>|to-column=<column>`: sends each row's
 * workspace file, or its folder with everything under it, into a Drive folder under the root,
 * as the signed-in person, as a plan a person applies (Tyto ADR 0129). Local files are read only
 * through the host's workspace files (Tyto ADR 0130, ADR 0212).
 */
export function driveUploadVerb(
  host: UploadHost,
  clock: WriteClock = systemClock,
): RecipeVerbContribution {
  return {
    id: DRIVE_UPLOAD,
    kind: 'action',
    arguments: ARGUMENTS,
    writes: [CREATE_WRITE, UPLOAD_WRITE, REPLACE_WRITE],
    plan: (request) => planDriveUpload(host, request, clock),
    apply: (request) => applyDriveUploads(host, request, clock),
  };
}

/** The cache key of a file's resumable session: the same file, folder and target, any plan. */
export function sessionKey(payload: UploadPayload): string {
  const { u, s, m, p, r } = payload;
  return `upload/${fingerprint(JSON.stringify([u, s, m, p, r ?? '']))}`;
}

/** Whether Drive's copy is the local file: the same size and the same modification time. */
export function sameFile(file: DriveFile, size: number, modifiedAt: string): boolean {
  return (
    file.size === size &&
    file.modifiedTime !== undefined &&
    Date.parse(file.modifiedTime) === Date.parse(modifiedAt)
  );
}

/** Bytes as a person reads them: `2.1 MB`, `640 KB`, `12 B`. */
export function sizeText(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${Math.round(bytes / 1_000)} KB`;
  return `${bytes} B`;
}

const problem = (text: string): Diagnostic => argumentsProblem(DRIVE_UPLOAD, text);
const refused = (diagnostic: Diagnostic): PlanAnswer => ({ ok: false, error: [diagnostic] });
const OUT_OF_TIME =
  "'google.drive-upload' could not compare every file in one call's time; narrow the table " +
  'to fewer rows and run again.';

/** A step of the walk: done, a Google failure that stops the plan, or this row's problem. */
type Step =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: GoogleError }
  | { readonly ok: false; readonly problem: string };
const DONE: Step = { ok: true };

interface Walk {
  readonly host: UploadHost;
  readonly client: Parameters<typeof rootWalk>[0];
  readonly row: Row;
  readonly operations: PlannedOperation[];
  readonly unchanged: string[];
}

export async function planDriveUpload(
  host: UploadHost,
  request: PlanRequest,
  clock: WriteClock = systemClock,
): Promise<PlanAnswer> {
  const { table } = request;
  const fromWritten = textArgument(request.arguments, 'from');
  if (fromWritten === undefined) {
    return refused(problem('needs from=, the column naming each workspace file or folder'));
  }
  const from = columnNamed(table, fromWritten, 'from');
  if (typeof from !== 'string') return refused(from);
  const to = textArgument(request.arguments, 'to');
  const toColumnWritten = textArgument(request.arguments, 'to-column');
  if ((to === undefined) === (toColumnWritten === undefined)) {
    return refused(
      problem('takes to=, one Drive folder for every row, or to-column=, a folder per row'),
    );
  }
  const toColumn =
    toColumnWritten === undefined ? undefined : columnNamed(table, toColumnWritten, 'to-column');
  if (toColumn !== undefined && typeof toColumn !== 'string') return refused(toColumn);
  const section = readSection(request.section);
  if (!section.ok) return refused(verbFailed(DRIVE_UPLOAD, section.error));
  const rootId = section.value.root;
  if (rootId === undefined) {
    return refused(
      problem('needs root in the google section of .tyto/project.json: it uploads under it'),
    );
  }

  const budget = budgetedTransport(host, clock);
  const connection = await connect(host, request.section, budget.transport);
  if (!connection.ok) return refused(verbFailed(DRIVE_UPLOAD, connection.error));
  const { client } = connection.value;
  const walk = rootWalk(client, rootId);
  const failedFor = (error: GoogleError): PlanAnswer =>
    budget.refusedForTime()
      ? refused({ severity: 'error', code: 'E_RECIPE_VERB', message: OUT_OF_TIME })
      : refused(verbFailed(DRIVE_UPLOAD, error));

  const destinations = new Map<string, Destination>();
  const operations: PlannedOperation[] = [];
  const unchanged: string[] = [];
  let blank = 0;
  for (const row of table.rows) {
    const path = cellText(row.values[from]);
    const wanted = toColumn === undefined ? to : cellText(row.values[toColumn]);
    if (path === undefined || wanted === undefined) {
      blank += 1;
      continue;
    }
    let found = destinations.get(wanted);
    if (found === undefined) {
      found = await destinationOf(walk, rootId, rootId, wanted, toColumn ?? 'to=');
      destinations.set(wanted, found);
    }
    if (!found.ok && 'error' in found) return failedFor(found.error);
    if (!found.ok) {
      if (toColumn === undefined) return refused(problem(found.problem));
      operations.push(plannedFailure(row, found.problem));
      continue;
    }
    const context: Walk = { host, client, row, operations: [], unchanged: [] };
    const entry = await statOf(host, path);
    let step: Step;
    if (typeof entry === 'string') step = { ok: false, problem: entry };
    else if (entry.kind === 'file') {
      const named = await childrenNamed(client, found.folder.id, entry.name);
      step = named.ok
        ? planFile(context, path, entry, found.folder, named.value)
        : { ok: false, error: named.error };
    } else step = await planFolder(context, path, entry.name, found.folder, true, 0);
    if (!step.ok && 'error' in step) return failedFor(step.error);
    if (!step.ok) {
      // A row that cannot be walked whole plans nothing: half a delivery is worse than none.
      operations.push(plannedFailure(row, step.problem));
      continue;
    }
    operations.push(...context.operations);
    unchanged.push(...context.unchanged);
    if (operations.length > MAX_OPERATIONS) {
      return refused(
        problem(
          `would plan over the ${MAX_OPERATIONS.toLocaleString('en-US')} writes one plan ` +
            'holds; split the table',
        ),
      );
    }
  }

  const diagnostics: Diagnostic[] = [];
  if (unchanged.length > 0) {
    diagnostics.push(
      warning(
        `'${DRIVE_UPLOAD}' plans nothing for ${unchanged.length.toLocaleString('en-US')} ` +
          `${unchanged.length === 1 ? 'file' : 'files'} already in Drive with the same name, ` +
          `size and time: ${listed(unchanged)}.`,
      ),
    );
  }
  if (blank > 0) {
    diagnostics.push(
      warning(
        `'${DRIVE_UPLOAD}' left out ${blank.toLocaleString('en-US')} ` +
          `${blank === 1 ? 'row' : 'rows'} with no file or no destination.`,
      ),
    );
  }
  const named = [...destinations.values()].flatMap((each) =>
    each.ok ? [`'${each.folder.name}' (${each.folder.id})`] : [],
  );
  return {
    ok: true,
    value: {
      target: `Drive folder ${[...new Set(named)].join(', ') || to || `per row in ${toColumn}`}`,
      operations,
      count: operations.length,
    },
    diagnostics,
  };
}

/** One local file against what its Drive folder holds of that name. */
function planFile(
  walk: Walk,
  path: string,
  entry: WorkspaceEntry,
  folder: Pick<DriveFile, 'id' | 'name'>,
  inFolder: readonly DriveFile[],
): Step {
  if (entry.name.length > MAX_NAME_LENGTH) {
    return { ok: false, problem: `'${path}' has a name over ${MAX_NAME_LENGTH} characters` };
  }
  const same = inFolder.filter(
    (each) => each.name === entry.name && each.mimeType !== FOLDER_MIME_TYPE,
  );
  if (same.length > 1) {
    return {
      ok: false,
      problem:
        `${same.length} files named '${entry.name}' are in '${folder.name}' ` +
        `(${listed(same.map((each) => each.id))}); keep one`,
    };
  }
  const existing = same[0];
  if (existing !== undefined && sameFile(existing, entry.size, entry.modifiedAt)) {
    walk.unchanged.push(path);
    return DONE;
  }
  const payload: UploadPayload = {
    u: path,
    n: entry.name,
    p: folder.id,
    s: entry.size,
    m: entry.modifiedAt,
    ...(existing === undefined ? {} : { r: existing.id }),
  };
  const where = `'${folder.name}' (${folder.id})`;
  walk.operations.push({
    write: existing === undefined ? UPLOAD_WRITE : REPLACE_WRITE,
    rowKey: walk.row.key,
    description: shortened(
      existing === undefined
        ? `upload '${path}' (${sizeText(entry.size)}) into ${where}`
        : `replace '${path}' (${sizeText(entry.size)}, was ` +
            `${existing.size === undefined ? 'no size' : sizeText(existing.size)}) in ${where}, ` +
            `keeping its id ${existing.id}`,
    ),
    payload: { ...payload },
  });
  return DONE;
}

/**
 * A local folder as a Drive folder of its name in `parent`: found, or planned as a `create`
 * with an id generated now, so the files under it can name it. Then each file and folder in it.
 */
async function planFolder(
  walk: Walk,
  path: string,
  name: string,
  parent: Pick<DriveFile, 'id' | 'name'>,
  parentExists: boolean,
  depth: number,
): Promise<Step> {
  if (depth > MAX_DEPTH) {
    return { ok: false, problem: `'${path}' is over ${MAX_DEPTH} folders deep` };
  }
  let folder: Pick<DriveFile, 'id' | 'name'> | undefined;
  if (parentExists) {
    const named = await childrenNamedOfType(walk.client, parent.id, name, FOLDER_MIME_TYPE);
    if (!named.ok) return named;
    if (named.value.length > 1) {
      return {
        ok: false,
        problem:
          `${named.value.length} folders named '${name}' are in '${parent.name}' ` +
          `(${listed(named.value.map((each) => each.id))}); keep one`,
      };
    }
    folder = named.value[0];
  }
  const exists = folder !== undefined;
  if (folder === undefined) {
    const planned = await idFor(walk, parent.id, name);
    if (!planned.ok) return planned;
    const id = planned.value;
    folder = { id, name };
    const payload: CreatePayload = { c: id, n: name, p: parent.id, m: FOLDER_MIME_TYPE };
    walk.operations.push({
      write: CREATE_WRITE,
      rowKey: walk.row.key,
      description: shortened(
        `create folder '${name}' in '${parent.name}' (${parent.id}): ` +
          `https://drive.google.com/drive/folders/${id}`,
      ),
      payload: { ...payload },
    });
  }

  let entries: readonly WorkspaceEntry[];
  try {
    entries = await walk.host.workspace.list(path);
  } catch (thrown) {
    return { ok: false, problem: `'${path}' could not be listed: ${messageOf(thrown)}` };
  }
  let inDrive: readonly DriveFile[] = [];
  if (exists) {
    const children = await allChildren(walk.client, folder.id);
    if (!children.ok) return children;
    inDrive = children.value;
  }
  for (const entry of entries) {
    const child = path === '' ? entry.name : `${path}/${entry.name}`;
    const step =
      entry.kind === 'file'
        ? planFile(walk, child, entry, folder, inDrive)
        : await planFolder(walk, child, entry.name, folder, exists, depth + 1);
    if (!step.ok) return step;
  }
  return DONE;
}

/**
 * The id of a folder this plan creates: the one an earlier plan kept for the same folder and
 * name, while Drive has nothing under it, or a new one, kept for the next plan and for
 * `google.drive-url` below (see `planned-folder.ts`).
 */
async function idFor(walk: Walk, parentId: string, name: string): Promise<GoogleResult<string>> {
  const kept = await plannedFolderId(walk.host, parentId, name);
  if (kept !== undefined) {
    const there = await getFile(walk.client, kept);
    if (!there.ok && there.error.status === 404) return googleOk(kept);
    if (!there.ok) return there;
    // Something holds the id already (a folder made from it, then trashed or moved): a new one.
  }
  const ids = await generateIds(walk.client, 1);
  if (!ids.ok) return ids;
  const id = ids.value[0] ?? '';
  await rememberPlannedFolder(walk.host, parentId, name, id);
  return googleOk(id);
}

/** Every child of a folder, page after page. */
async function allChildren(
  client: Walk['client'],
  folderId: string,
): Promise<{ ok: true; value: readonly DriveFile[] } | { ok: false; error: GoogleError }> {
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const page = await listChildren(client, folderId, undefined, pageToken);
    if (!page.ok) return page;
    files.push(...page.value.files);
    pageToken = page.value.nextPageToken;
  } while (pageToken !== undefined);
  return { ok: true, value: files };
}

async function statOf(host: UploadHost, path: string): Promise<WorkspaceEntry | string> {
  try {
    return await host.workspace.stat(path);
  } catch (thrown) {
    return `'${path}' could not be read in the workspace: ${messageOf(thrown)}`;
  }
}

export function isUploadPayload(value: unknown): value is UploadPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  const text = (key: string): boolean => typeof record[key] === 'string' && record[key] !== '';
  return (
    text('u') &&
    text('n') &&
    text('p') &&
    text('m') &&
    typeof record['s'] === 'number' &&
    Number.isSafeInteger(record['s']) &&
    record['s'] >= 0 &&
    (record['r'] === undefined || text('r'))
  );
}

function cellText(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = String(value).trim();
  return text === '' ? undefined : text;
}

/** A column by its name, or the step's problem with it. */
function columnNamed(table: Table, name: string, argument: string): string | Diagnostic {
  const found = columnOf(table, argument, name);
  return found.problem === undefined ? found.name : problem(found.problem);
}
