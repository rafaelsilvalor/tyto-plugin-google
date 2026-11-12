import type { PluginHost, RecipeVerbContribution } from '@tyto/plugin-api';

import { fileIdOf, folderIdOf, readSection } from './config.js';
import { connect } from './connect.js';
import {
  childrenNamed,
  DRIVE_FILES,
  getFile,
  textArgument,
  type DriveFile,
} from './drive-files.js';
import { FOLDER_MIME_TYPE } from './drive-query.js';
import { rootWalk, type RootWalk } from './drive-root.js';
import { describeGoogleError, type GoogleError } from './errors.js';
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

export const DRIVE_MOVE = 'google.drive-move';
export const MOVE_WRITE = 'move';
/** The column a `google.drive-list` table keys its rows by, and the folder it listed. */
const DEFAULT_FILE_COLUMN = 'id';
const PARENT_COLUMN = 'parent_id';
/** Creating the destination is a later version's (TYTO-390); a missing one stops the plan. */
const NO_CREATE = 'creating folders comes in a later version';

const ARGUMENTS: readonly ArgumentSpec[] = [
  { name: 'file', type: 'text' },
  { name: 'to', type: 'text', required: true },
];

export type DriveMoveHost = Pick<PluginHost, 'credentials' | 'fetch' | 'signin'>;

/**
 * `google.drive-move to=<folder> [file=<column>]`: moves each row's Drive file or folder into
 * one folder, as a plan a person applies. Both must be under the section's `root`: a recipe
 * moves things inside the folder it was given, never out of it, as Buraqueira's `mover`.
 */
export function driveMoveVerb(
  host: DriveMoveHost,
  clock: WriteClock = systemClock,
): RecipeVerbContribution {
  return {
    id: DRIVE_MOVE,
    kind: 'action',
    arguments: ARGUMENTS,
    writes: [MOVE_WRITE],
    plan: (request) => planDriveMove(host, request, clock),
    apply: (request) => applyDriveMoves(host, request, clock),
  };
}

/** What a `move` payload holds: the file, the folders it was in when planned, where it goes. */
export interface MovePayload {
  readonly f: string;
  readonly from: readonly string[];
  readonly to: string;
}

const problem = (text: string): Diagnostic => argumentsProblem(DRIVE_MOVE, text);
const refused = (diagnostic: Diagnostic): PlanAnswer => ({ ok: false, error: [diagnostic] });
const verbRefused = (text: string): PlanAnswer =>
  refused({ severity: 'error', code: 'E_RECIPE_VERB', message: `'${DRIVE_MOVE}' ${text}.` });
const OUT_OF_TIME =
  "could not check every file in one call's time; narrow the table to fewer rows and run again";

export async function planDriveMove(
  host: DriveMoveHost,
  request: PlanRequest,
  clock: WriteClock = systemClock,
): Promise<PlanAnswer> {
  const { table } = request;
  const column = columnOf(table, textArgument(request.arguments, 'file') ?? DEFAULT_FILE_COLUMN);
  if (typeof column !== 'string') return refused(column);
  const to = textArgument(request.arguments, 'to');
  if (to === undefined) return refused(problem('needs to=, the folder the files move into'));
  const section = readSection(request.section);
  if (!section.ok) return refused(verbFailed(DRIVE_MOVE, section.error));
  const rootId = section.value.root;
  if (rootId === undefined) {
    return refused(
      problem(
        'needs root in the google section of .tyto/project.json: it moves only files under it',
      ),
    );
  }
  if (table.rows.length > MAX_OPERATIONS) {
    return refused(
      problem(
        `would move ${table.rows.length.toLocaleString('en-US')} files, over the ` +
          `${MAX_OPERATIONS.toLocaleString('en-US')} one plan holds; split the table`,
      ),
    );
  }

  const budget = budgetedTransport(host, clock);
  const connection = await connect(host, request.section, budget.transport);
  if (!connection.ok) return refused(verbFailed(DRIVE_MOVE, connection.error));
  const walk = rootWalk(connection.value.client, rootId);
  const failedFor = (error: GoogleError): PlanAnswer =>
    budget.refusedForTime() ? verbRefused(OUT_OF_TIME) : refused(verbFailed(DRIVE_MOVE, error));

  const hasParentColumn = table.columns.some((each) => each.name === PARENT_COLUMN);
  const destinations = new Map<string, DriveFile>();
  const operations: PlannedOperation[] = [];
  const alreadyThere: string[] = [];
  for (const row of table.rows) {
    const parent = hasParentColumn ? (folderIdOf(row.values[PARENT_COLUMN]) ?? rootId) : rootId;
    let destination = destinations.get(parent);
    if (destination === undefined) {
      const found = await destinationOf(walk, rootId, parent, to);
      if (!found.ok) {
        return 'error' in found ? failedFor(found.error) : refused(problem(found.problem));
      }
      destination = found.folder;
      destinations.set(parent, destination);
    }

    const written = row.values[column];
    const fileId =
      typeof written === 'string' ? (fileIdOf(written) ?? folderIdOf(written)) : undefined;
    if (fileId === undefined) {
      operations.push(
        plannedFailure(row, `${column} holds ${shown(written)}, not a Drive id or address`),
      );
      continue;
    }
    const verdict = await walk.verdict(fileId);
    if (!verdict.ok) {
      if (budget.refusedForTime()) return verbRefused(OUT_OF_TIME);
      operations.push(plannedFailure(row, describeGoogleError(verdict.error)));
      continue;
    }
    const { file } = verdict.value;
    if (!verdict.value.under) {
      operations.push(
        plannedFailure(row, `'${file.name}' is not under the root folder: ${verdict.value.why}`),
      );
      continue;
    }
    if (fileId === rootId || fileId === destination.id) {
      operations.push(
        plannedFailure(
          row,
          `'${file.name}' is the ${fileId === rootId ? 'root folder' : 'destination'} itself`,
        ),
      );
      continue;
    }
    if (file.parents.includes(destination.id)) {
      alreadyThere.push(file.name);
      continue;
    }
    const payload: MovePayload = { f: fileId, from: file.parents, to: destination.id };
    operations.push({
      write: MOVE_WRITE,
      rowKey: row.key,
      description: shortened(
        `move '${file.name}' from ${file.parents.join(', ') || 'no folder'} into ` +
          `'${destination.name}' (${destination.id})`,
      ),
      payload: { ...payload, from: [...payload.from] },
    });
  }

  const diagnostics: Diagnostic[] =
    alreadyThere.length === 0
      ? []
      : [
          {
            severity: 'warning',
            code: 'E_RECIPE_VERB',
            message: shortened(
              `'${DRIVE_MOVE}' plans nothing for ${listed(alreadyThere)}: already in the ` +
                'destination.',
            ),
          },
        ];
  return {
    ok: true,
    value: {
      target: `Drive folder ${[...new Set([...destinations.values()].map((each) => `'${each.name}' (${each.id})`))].join(', ') || to}`,
      operations,
      count: operations.length,
    },
    diagnostics,
  };
}

type Destination =
  | { readonly ok: true; readonly folder: DriveFile }
  | { readonly ok: false; readonly error: GoogleError }
  | { readonly ok: false; readonly problem: string };

/**
 * `to=` as a folder: an address names it; otherwise a folder of that name directly under
 * `parent`, and, when none is and the text looks like an id, the folder of that id. A missing
 * or ambiguous destination, one that is not a folder, or one outside the root stops the plan.
 */
async function destinationOf(
  walk: RootWalk,
  rootId: string,
  parent: string,
  to: string,
): Promise<Destination> {
  let candidate: DriveFile | undefined;
  if (/^https:\/\//i.test(to)) {
    const id = folderIdOf(to);
    if (id === undefined) {
      return { ok: false, problem: `to= holds '${to}', which is not a Drive folder's address` };
    }
    const read = await walk.describe(id);
    if (!read.ok) return read;
    candidate = read.value;
  } else {
    const named = await childrenNamed(walk.client, parent, to);
    if (!named.ok) return named;
    const folders = named.value.filter((each) => each.mimeType === FOLDER_MIME_TYPE);
    if (folders.length > 1) {
      return {
        ok: false,
        problem:
          `to= names '${to}', and ${folders.length} folders of that name are in ${parent}: ` +
          `${listed(folders.map((each) => each.id))}; name one by its id`,
      };
    }
    candidate = folders[0];
    if (candidate === undefined && folderIdOf(to) !== undefined) {
      const read = await walk.describe(to);
      if (read.ok) candidate = read.value;
    }
    if (candidate === undefined) {
      return {
        ok: false,
        problem: `to= names '${to}', and no folder of that name is in ${parent}; ${NO_CREATE}`,
      };
    }
  }
  if (candidate.mimeType !== FOLDER_MIME_TYPE) {
    return { ok: false, problem: `to= names '${candidate.name}', which is a file, not a folder` };
  }
  const verdict = await walk.verdict(candidate.id);
  if (!verdict.ok) return verdict;
  if (!verdict.value.under) {
    return {
      ok: false,
      problem:
        `to= names '${candidate.name}', which is not under the root folder ${rootId}: ` +
        verdict.value.why,
    };
  }
  return { ok: true, folder: candidate };
}

/**
 * One batch of a `google.drive-move` plan. Each file's folders are read again first: a file
 * moved since the plan fails alone rather than being pulled out of a folder the person never
 * saw it in. Then one `files.update` (PATCH) adds the destination and removes the folders the
 * plan saw. Past the call's 20 s budget, what was not reached is `skipped`.
 */
export async function applyDriveMoves(
  host: DriveMoveHost,
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

  // What the plan already knew cannot move fails with no request, whatever the time does.
  const moves: [number, MovePayload][] = [];
  for (const [index, operation] of request.operations.entries()) {
    const payload = operation.payload;
    if (isPlannedFailure(payload)) outcomes[index] = failed(payload.x);
    else if (operation.write !== MOVE_WRITE || !isMovePayload(payload)) {
      outcomes[index] = failed('E_GOOGLE_PLAN: not a move this plugin planned; run the cell again');
    } else moves.push([index, payload]);
  }
  if (moves.length === 0) return done();

  const budget = budgetedTransport(host, clock);
  const connection = await connect(host, request.section, budget.transport);
  if (!connection.ok) {
    if (budget.refusedForTime()) return done();
    for (const [index] of moves) outcomes[index] = failed(describeGoogleError(connection.error));
    return done();
  }
  const { client } = connection.value;
  for (const [index, payload] of moves) {
    if (budget.expired()) break;
    const now = await getFile(client, payload.f);
    if (!now.ok) {
      if (budget.refusedForTime()) break;
      outcomes[index] = failed(describeGoogleError(now.error));
      continue;
    }
    if (!sameFolders(now.value.parents, payload.from)) {
      outcomes[index] = failed(
        `E_GOOGLE_CHANGED: '${now.value.name}' is in ${now.value.parents.join(', ') || 'no folder'} ` +
          `now, not in ${payload.from.join(', ')} as planned; run the cell again for a new plan`,
      );
      continue;
    }
    const moved = await client.patch(
      `${DRIVE_FILES}/${encodeURIComponent(payload.f)}`,
      {},
      {
        addParents: payload.to,
        removeParents: payload.from.join(','),
        supportsAllDrives: true,
        fields: 'id, parents',
      },
    );
    if (!moved.ok) {
      if (budget.refusedForTime()) break;
      outcomes[index] = failed(describeGoogleError(moved.error));
      continue;
    }
    outcomes[index] = { status: 'applied' };
  }
  return done();
}

function sameFolders(now: readonly string[], planned: readonly string[]): boolean {
  if (now.length !== planned.length) return false;
  const sorted = [...planned].sort();
  return [...now].sort().every((each, index) => each === sorted[index]);
}

function isPlannedFailure(value: unknown): value is { readonly x: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>)['x'] === 'string'
  );
}

function isMovePayload(value: unknown): value is MovePayload {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  const from = record['from'];
  return (
    typeof record['f'] === 'string' &&
    record['f'] !== '' &&
    typeof record['to'] === 'string' &&
    record['to'] !== '' &&
    Array.isArray(from) &&
    from.every((each) => typeof each === 'string')
  );
}

/** A row the plan knows cannot move: shown with the others, `failed` on Apply with no request. */
function plannedFailure(row: Row, reason: string): PlannedOperation {
  const text = shortened(`E_GOOGLE_PLAN: ${row.key}: ${reason}`);
  return {
    write: MOVE_WRITE,
    rowKey: row.key,
    description: shortened(`${row.key} (will fail: ${text})`),
    payload: { x: text },
  };
}

/** The column holding the files, by its name; case is ignored when only one column matches. */
function columnOf(table: Table, name: string): string | Diagnostic {
  if (table.columns.some((each) => each.name === name)) return name;
  const matches = table.columns.filter((each) => each.name.toLowerCase() === name.toLowerCase());
  if (matches.length === 1 && matches[0] !== undefined) return matches[0].name;
  return problem(
    `file= names the column '${name}', which the table does not have; its columns are ` +
      listed(table.columns.map((each) => each.name)),
  );
}

function shown(value: unknown): string {
  if (value === null || value === undefined || value === '') return 'nothing';
  return `'${String(value)}'`;
}
