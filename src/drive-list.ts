import type { PluginHost, RecipeVerbContribution } from '@tyto/plugin-api';

import { connect } from './connect.js';
import { decodeOpaque, encodeOpaque, fingerprint } from './cursor.js';
import { folderArgument, listChildren, textArgument, type DriveFile } from './drive-files.js';
import { DRIVE_TYPES, kindOf, matchesType, type DriveType } from './drive-query.js';
import {
  argumentsProblem,
  failed,
  ORIGIN,
  verbFailed,
  type ArgumentSpec,
  type ArgumentValues,
  type Column,
  type Diagnostic,
  type PageAnswer,
  type PageRequest,
  type Row,
} from './verb.js';

export const DRIVE_LIST = 'google.drive-list';

export const DEFAULT_MAX = 100_000;
export const MAX_MAX = 100_000;
/** Drive's page tokens run to a few hundred characters; anything far longer is not ours. */
const CURSOR_LIMIT = 4000;

const ARGUMENTS: readonly ArgumentSpec[] = [
  { name: 'folder', type: 'text' },
  { name: 'type', type: 'text' },
  { name: 'max', type: 'number' },
];

/** The columns of every page, in order. */
export const LIST_COLUMNS: readonly Column[] = [
  { name: 'id', type: 'text', origin: ORIGIN },
  { name: 'name', type: 'text', origin: ORIGIN },
  { name: 'mime_type', type: 'text', origin: ORIGIN },
  { name: 'kind', type: 'text', origin: ORIGIN },
  { name: 'size', type: 'number', origin: ORIGIN },
  { name: 'created', type: 'datetime', origin: ORIGIN },
  { name: 'modified', type: 'datetime', origin: ORIGIN },
  { name: 'url', type: 'link', origin: ORIGIN },
  { name: 'parent_id', type: 'text', origin: ORIGIN },
];

export type DriveListHost = Pick<PluginHost, 'credentials' | 'fetch' | 'signin'>;

/**
 * `google.drive-list`: a folder's children, one row per file or folder, keyed by Drive id,
 * oldest first. Each page is one `files.list` call of up to 1,000 items; the cursor carries
 * Drive's own page token, so the host's loop walks Drive's pages.
 */
export function driveListVerb(host: DriveListHost): RecipeVerbContribution {
  return {
    id: DRIVE_LIST,
    kind: 'source',
    arguments: ARGUMENTS,
    page: (request) => driveListPage(host, request),
  };
}

interface Asked {
  readonly folderId: string;
  readonly type?: DriveType;
  readonly max: number;
}

/** Where a listing left off: Drive's token, the rows answered so far, the step's fingerprint. */
interface ListCursor {
  readonly v: 1;
  readonly t: string;
  readonly n: number;
  readonly f: string;
}

const listFailed = (text: string): PageAnswer =>
  failed({ severity: 'error', code: 'E_RECIPE_VERB', message: `'${DRIVE_LIST}' failed: ${text}.` });

export async function driveListPage(
  host: DriveListHost,
  request: PageRequest,
): Promise<PageAnswer> {
  const asked = readListArguments(request.arguments, request.section);
  if ('severity' in asked) return failed(asked);
  const print = fingerprint(JSON.stringify([asked.folderId, asked.type ?? null, asked.max]));
  let cursor: ListCursor | undefined;
  if (request.cursor !== undefined) {
    const decoded = decodeOpaque(request.cursor, CURSOR_LIMIT);
    if (typeof decoded === 'string') return listFailed(`${decoded}; run again`);
    if (!isListCursor(decoded.value)) {
      return listFailed('the cursor is not one this plugin writes; run again');
    }
    cursor = decoded.value;
    if (cursor.f !== print) {
      return listFailed('the step changed between two pages of one run; run again');
    }
  }

  const connection = await connect(host, request.section);
  if (!connection.ok) return failed(verbFailed(DRIVE_LIST, connection.error));
  const page = await listChildren(connection.value.client, asked.folderId, asked.type, cursor?.t);
  if (!page.ok) return failed(verbFailed(DRIVE_LIST, page.error));

  const fetchedAt = new Date().toISOString();
  const rows = page.value.files
    .filter((file) => matchesType(kindOf(file.mimeType, file.name), asked.type))
    .map((file) => rowOf(file, asked.folderId, fetchedAt));
  const table = { columns: LIST_COLUMNS, rows };
  const answered = (cursor?.n ?? 0) + rows.length;
  // Never a partial table: more items than `max=` allows is a source cut short.
  if (answered > asked.max) return { ok: true, value: { table, truncated: true }, diagnostics: [] };
  const token = page.value.nextPageToken;
  if (token === undefined) return { ok: true, value: { table }, diagnostics: [] };
  const next: ListCursor = { v: 1, t: token, n: answered, f: print };
  return { ok: true, value: { table, cursor: encodeOpaque(next) }, diagnostics: [] };
}

function rowOf(file: DriveFile, folderId: string, fetchedAt: string): Row {
  return {
    key: file.id,
    values: {
      id: file.id,
      name: file.name,
      mime_type: file.mimeType,
      kind: kindOf(file.mimeType, file.name),
      size: file.size ?? null,
      created: file.createdTime ?? null,
      modified: file.modifiedTime ?? null,
      url: file.webViewLink ?? null,
      // The folder asked for: a file Drive lists under it is its child, whatever else holds it.
      parent_id: folderId,
    },
    provenance: { source: ORIGIN, id: file.id, fetchedAt },
  };
}

function isListCursor(value: unknown): value is ListCursor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return (
    record['v'] === 1 &&
    typeof record['t'] === 'string' &&
    record['t'] !== '' &&
    Number.isSafeInteger(record['n']) &&
    (record['n'] as number) >= 0 &&
    typeof record['f'] === 'string' &&
    /^[0-9a-f]{16}$/.test(record['f'])
  );
}

/** The step's arguments, checked, with the folder from the section when none is named. */
export function readListArguments(values: ArgumentValues, section: unknown): Asked | Diagnostic {
  const folderId = folderArgument(DRIVE_LIST, values, section);
  if (typeof folderId !== 'string') return folderId;
  const type = textArgument(values, 'type')?.toLowerCase();
  if (type !== undefined && !(DRIVE_TYPES as readonly string[]).includes(type)) {
    return argumentsProblem(
      DRIVE_LIST,
      `type= must be one of ${DRIVE_TYPES.join(', ')}, not '${type}'`,
    );
  }
  const max = values['max'] ?? DEFAULT_MAX;
  if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 1 || max > MAX_MAX) {
    return argumentsProblem(
      DRIVE_LIST,
      `max= must be a whole number from 1 to ${MAX_MAX}, not ${String(max)}`,
    );
  }
  return {
    folderId,
    ...(type === undefined ? {} : { type: type as DriveType }),
    max,
  };
}
