import type { PluginHost, RecipeVerbContribution, WorkspaceEntry } from '@tyto/plugin-api';

import { fileIdOf, folderIdOf } from './config.js';
import { connect } from './connect.js';
import { columnOf, warning } from './drive-create.js';
import { applyDriveFetches } from './drive-fetch-apply.js';
import { getFile, listChildren, textArgument, type DriveFile } from './drive-files.js';
import { FOLDER_MIME_TYPE, NATIVE_PREFIX } from './drive-query.js';
import { sizeText } from './drive-upload.js';
import { googleOk, messageOf, type GoogleError, type GoogleResult } from './errors.js';
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

export const DRIVE_FETCH = 'google.drive-fetch';
export const FETCH_WRITE = 'fetch';
export const REPLACE_LOCAL_WRITE = 'replace';
/** The folder of a delivery the assets land in. */
export const ASSETS_FOLDER = 'assets';
/**
 * The largest file fetched: what `host.workspace.write` writes whole, the plugin API's
 * `PLUGIN_FILE_LIMIT_BYTES` (Tyto ADR 0138). Copied rather than imported, because a value
 * imported from the plugin API bundles all of it into `dist/index.js`; a test holds the two equal.
 */
export const MAX_FETCH_BYTES = 32 * 1024 * 1024;

const ARGUMENTS: readonly ArgumentSpec[] = [
  { name: 'from', type: 'text' },
  { name: 'into', type: 'text' },
];

export type FetchHost = Pick<PluginHost, 'fetch' | 'signin' | 'workspace'>;

/**
 * What a `fetch` or a `replace` payload holds: the Drive file's id, the workspace path it is
 * written to, Drive's size and modified time the plan saw, and the local file the plan saw at
 * that path (its size and time), absent when there was none. Apply refuses to write over a
 * local file that changed since, and finds a file it already wrote by the same rule the plan
 * skips by.
 */
export interface FetchPayload {
  readonly i: string;
  readonly w: string;
  readonly s: number;
  readonly m: string;
  readonly ls?: number;
  readonly lm?: string;
}

/**
 * `google.drive-fetch from=<column> into=<column>`: for each row, the Drive file its `from`
 * cell names, or the files directly in the folder it names, written into `<into>/assets/` of
 * the workspace under their Drive names, as a plan a person applies (Tyto ADR 0129). Files are
 * written only through the host's workspace files (Tyto ADR 0130, ADR 0138).
 */
export function driveFetchVerb(
  host: FetchHost,
  clock: WriteClock = systemClock,
): RecipeVerbContribution {
  return {
    id: DRIVE_FETCH,
    kind: 'action',
    arguments: ARGUMENTS,
    writes: [FETCH_WRITE, REPLACE_LOCAL_WRITE],
    plan: (request) => planDriveFetch(host, request, clock),
    apply: (request) => applyDriveFetches(host, request, clock),
  };
}

/**
 * Whether the local file already is Drive's: the same size, and written no earlier than Drive's
 * file last changed. `host.workspace.write` cannot set a file's time, so a fetched file carries
 * the time it was written, never Drive's; "the same date" is read as "not older than Drive's".
 */
export function alreadyFetched(local: WorkspaceEntry, size: number, modifiedTime: string): boolean {
  return (
    local.kind === 'file' &&
    local.size === size &&
    Date.parse(local.modifiedAt) >= Date.parse(modifiedTime)
  );
}

const problem = (text: string): Diagnostic => argumentsProblem(DRIVE_FETCH, text);
const refused = (diagnostic: Diagnostic): PlanAnswer => ({ ok: false, error: [diagnostic] });
const OUT_OF_TIME =
  "'google.drive-fetch' could not compare every file in one call's time; narrow the table " +
  'to fewer rows and run again.';

/** A row's problem, planned as an operation that fails, so the plan shows it beside the rest. */
export function fetchFailure(row: Row, reason: string): PlannedOperation {
  const text = shortened(`E_GOOGLE_PLAN: ${row.key}: ${reason}`);
  return {
    write: FETCH_WRITE,
    rowKey: row.key,
    description: shortened(`${row.key} (will fail: ${text})`),
    payload: { x: text },
  };
}

export async function planDriveFetch(
  host: FetchHost,
  request: PlanRequest,
  clock: WriteClock = systemClock,
): Promise<PlanAnswer> {
  const { table } = request;
  const fromWritten = textArgument(request.arguments, 'from');
  if (fromWritten === undefined) {
    return refused(problem('needs from=, the column holding each Drive file or folder link'));
  }
  const intoWritten = textArgument(request.arguments, 'into');
  if (intoWritten === undefined) {
    return refused(problem("needs into=, the column holding each delivery's workspace folder"));
  }
  const from = columnNamed(table, fromWritten, 'from');
  if (typeof from !== 'string') return refused(from);
  const into = columnNamed(table, intoWritten, 'into');
  if (typeof into !== 'string') return refused(into);

  const budget = budgetedTransport(host, clock);
  const connection = await connect(host, request.section, budget.transport);
  if (!connection.ok) return refused(verbFailed(DRIVE_FETCH, connection.error));
  const { client } = connection.value;
  const failedFor = (error: GoogleError): PlanAnswer =>
    budget.refusedForTime()
      ? refused({ severity: 'error', code: 'E_RECIPE_VERB', message: OUT_OF_TIME })
      : refused(verbFailed(DRIVE_FETCH, error));

  const operations: PlannedOperation[] = [];
  const unchanged: string[] = [];
  const native: string[] = [];
  let blank = 0;
  for (const row of table.rows) {
    const written = cellText(row.values[from]);
    const folder = cellText(row.values[into]);
    if (written === undefined || folder === undefined) {
      blank += 1;
      continue;
    }
    const id = fileIdOf(written) ?? folderIdOf(written);
    if (id === undefined) {
      operations.push(
        fetchFailure(row, `'${written}' in ${from} is neither a Drive file nor a folder link`),
      );
      continue;
    }
    const base = folderPath(folder);
    if (base === undefined) {
      operations.push(
        fetchFailure(row, `'${folder}' in ${into} is not a folder inside the workspace`),
      );
      continue;
    }
    const named = await filesNamed(client, id);
    if (!named.ok) {
      if (budget.refusedForTime() || named.error.status !== 404) return failedFor(named.error);
      operations.push(fetchFailure(row, `${written} is not in Drive, or not shared with you`));
      continue;
    }
    const problems: string[] = [];
    const planned: PlannedOperation[] = [];
    const targets = new Set<string>();
    for (const file of named.value) {
      if (file.mimeType.startsWith(NATIVE_PREFIX)) {
        // A Doc or a Sheet has no bytes; a folder's own Doc is no reason to fail the row.
        if (named.value.length === 1) problems.push(`'${file.name}' is a Google file, no bytes`);
        else native.push(file.name);
        continue;
      }
      const why = nameProblem(file.name);
      if (why !== undefined) {
        problems.push(why);
        continue;
      }
      const path = `${base}/${ASSETS_FOLDER}/${file.name}`;
      if (targets.has(path)) {
        problems.push(`two files named '${file.name}' are in that folder; keep one`);
        continue;
      }
      targets.add(path);
      if (file.size === undefined || file.modifiedTime === undefined) {
        problems.push(`Drive gave no size or time for '${file.name}'`);
        continue;
      }
      if (file.size > MAX_FETCH_BYTES) {
        problems.push(
          `'${file.name}' is ${sizeText(file.size)}, over the ${sizeText(MAX_FETCH_BYTES)} ` +
            'one workspace write holds; it is not fetched',
        );
        continue;
      }
      const local = await localEntry(host, path);
      if (typeof local === 'string') {
        problems.push(local);
        continue;
      }
      if (local !== undefined && alreadyFetched(local, file.size, file.modifiedTime)) {
        unchanged.push(path);
        continue;
      }
      if (local !== undefined && local.kind !== 'file') {
        problems.push(`'${path}' is a folder in the workspace`);
        continue;
      }
      planned.push(fetchOf(row, file, path, local));
    }
    operations.push(...planned);
    for (const each of problems) operations.push(fetchFailure(row, each));
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
        `'${DRIVE_FETCH}' plans nothing for ${counted(unchanged.length, 'file')} already in ` +
          `the workspace with the same size, written since Drive's last change: ${listed(unchanged)}.`,
      ),
    );
  }
  if (native.length > 0) {
    diagnostics.push(
      warning(
        `'${DRIVE_FETCH}' left out ${counted(native.length, 'Google file')} with no bytes to ` +
          `fetch: ${listed(native)}.`,
      ),
    );
  }
  if (blank > 0) {
    diagnostics.push(
      warning(`'${DRIVE_FETCH}' left out ${counted(blank, 'row')} with no link or no folder.`),
    );
  }
  return {
    ok: true,
    value: {
      target: `the assets folder of each row's ${into}`,
      operations,
      count: operations.length,
    },
    diagnostics,
  };
}

/** One file to write, or to write over a local one of another size or an older time. */
function fetchOf(
  row: Row,
  file: DriveFile,
  path: string,
  local: WorkspaceEntry | undefined,
): PlannedOperation {
  const size = file.size ?? 0;
  const payload: FetchPayload = {
    i: file.id,
    w: path,
    s: size,
    m: file.modifiedTime ?? '',
    ...(local === undefined ? {} : { ls: local.size, lm: local.modifiedAt }),
  };
  return {
    write: local === undefined ? FETCH_WRITE : REPLACE_LOCAL_WRITE,
    rowKey: row.key,
    description: shortened(
      local === undefined
        ? `fetch '${file.name}' (${sizeText(size)}) from Drive into '${path}'`
        : `replace '${path}' (${sizeText(local.size)}, ${local.modifiedAt}) with Drive's ` +
            `'${file.name}' (${sizeText(size)}, ${file.modifiedTime ?? ''})`,
    ),
    payload: { ...payload },
  };
}

/** A link's files: the file itself, or a folder's direct files, page after page. */
async function filesNamed(
  client: Parameters<typeof getFile>[0],
  id: string,
): Promise<GoogleResult<readonly DriveFile[]>> {
  const item = await getFile(client, id);
  if (!item.ok) return item;
  if (item.value.mimeType !== FOLDER_MIME_TYPE) return googleOk([item.value]);
  const files: DriveFile[] = [];
  let pageToken: string | undefined;
  do {
    const page = await listChildren(client, id, 'file', pageToken);
    if (!page.ok) return page;
    files.push(...page.value.files);
    pageToken = page.value.nextPageToken;
  } while (pageToken !== undefined);
  return googleOk(files);
}

/** What the workspace holds at the path: an entry, nothing, or why it could not be read. */
export async function localEntry(
  host: FetchHost,
  path: string,
): Promise<WorkspaceEntry | undefined | string> {
  try {
    return await host.workspace.stat(path);
  } catch (thrown) {
    const message = messageOf(thrown);
    if (/ENOENT|not found|no such|does not exist/i.test(message)) return undefined;
    return `'${path}' could not be read in the workspace: ${message}`;
  }
}

/** A Drive name that cannot be one file in `assets/`: a path, or a name no folder holds. */
function nameProblem(name: string): string | undefined {
  // eslint-disable-next-line no-control-regex
  if (name === '' || name === '.' || name === '..' || /[/\\\u0000-\u001f]/.test(name)) {
    return `'${name}' cannot be a file name in ${ASSETS_FOLDER}/`;
  }
  return undefined;
}

/** The folder cell as a workspace path with no trailing slash; `undefined` when it leaves it. */
function folderPath(written: string): string | undefined {
  const path = written.replace(/\\/g, '/').replace(/\/+$/, '');
  if (path === '' || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return undefined;
  if (path.split('/').some((part) => part === '..' || part === '.' || part === '')) {
    return undefined;
  }
  return path;
}

function counted(count: number, noun: string): string {
  return `${count.toLocaleString('en-US')} ${count === 1 ? noun : `${noun}s`}`;
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

export function isFetchPayload(value: unknown): value is FetchPayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  const text = (key: string): boolean => typeof record[key] === 'string' && record[key] !== '';
  const bytes = (key: string): boolean =>
    typeof record[key] === 'number' && Number.isSafeInteger(record[key]) && record[key] >= 0;
  const local = record['ls'] === undefined ? record['lm'] === undefined : bytes('ls') && text('lm');
  return text('i') && text('w') && text('m') && bytes('s') && local;
}
