import type { PluginHost, RecipeVerbContribution } from '@tyto/plugin-api';

import { fileIdOf } from './config.js';
import { connect } from './connect.js';
import { decodeOpaque, encodeOpaque, fingerprint } from './cursor.js';
import {
  downloadFile,
  folderArgument,
  getFile,
  listChildren,
  textArgument,
  type DriveFile,
} from './drive-files.js';
import {
  ColumnUnion,
  jsonColumns,
  jsonRecords,
  jsonRows,
  type JsonColumns,
  type JsonRecords,
} from './drive-json.js';
import { FOLDER_MIME_TYPE, NATIVE_PREFIX, isJson } from './drive-query.js';
import type { GoogleClient } from './http.js';
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
  type Table,
} from './verb.js';

export const DRIVE_READ = 'google.drive-read';

/** The largest file read: the host's own ceiling on a page, which one file's rows must fit. */
export const MAX_FILE_BYTES = 8 * 1024 * 1024;
/** The most rows one page answers, as `google.sheet-rows`. */
export const PAGE_ROWS = 5000;
/** A page stops short of this many bytes of rows, well under the host's 8 MiB per page. */
export const PAGE_BYTES = 6 * 1024 * 1024;
/** The host reads at most 1,000 pages of a source, and a folder is read one file per page. */
export const MAX_FILES = 1000;
/** The cursor carries the first file's columns; a few hundred names fit well under this. */
const CURSOR_LIMIT = 16_000;

const ARGUMENTS: readonly ArgumentSpec[] = [
  { name: 'file', type: 'text' },
  { name: 'folder', type: 'text' },
  { name: 'type', type: 'text' },
  { name: 'rows', type: 'text' },
];

const TEXT_COLUMNS: readonly Column[] = [
  { name: 'file_id', type: 'text', origin: ORIGIN },
  { name: 'file_name', type: 'text', origin: ORIGIN },
  { name: 'line', type: 'number', origin: ORIGIN },
  { name: 'text', type: 'text', origin: ORIGIN },
];

export type DriveReadHost = Pick<PluginHost, 'fetch' | 'signin'>;

/**
 * `google.drive-read`: what a JSON or text file holds, as rows. `file=` reads one file;
 * `folder=` reads every JSON file directly in a folder, oldest first. The first page of a folder
 * reads every file once, to judge each alone and gather the columns of those it keeps; each
 * later page downloads one file. `rows=<key>` spreads the list under that key of a JSON object
 * into rows.
 */
export function driveReadVerb(host: DriveReadHost): RecipeVerbContribution {
  return {
    id: DRIVE_READ,
    kind: 'source',
    arguments: ARGUMENTS,
    page: (request) => driveReadPage(host, request),
  };
}

type Format = 'json' | 'text';

type Asked =
  | {
      readonly mode: 'file';
      readonly fileId: string;
      readonly type?: Format;
      readonly rows?: string;
    }
  | { readonly mode: 'folder'; readonly folderId: string; readonly rows?: string };

/**
 * Where a read left off. `i` is the file's place in the folder's JSON files (0 for `file=`)
 * and `id` its Drive id; `o` the offset of the next row in it; `d` fingerprints the file's
 * size and modified time, and `l` the folder's files with theirs, so a file or a folder changed
 * between two pages is refused rather than stitched; `c` holds the columns the first page
 * answered, which every later page is read into; `s` the places of the folder's files the first
 * page skipped; `f` fingerprints the step.
 */
interface ReadCursor {
  readonly v: 1;
  readonly i: number;
  readonly id: string;
  readonly o: number;
  readonly d: string;
  readonly l: string;
  readonly c?: JsonColumns;
  readonly s?: readonly number[];
  readonly f: string;
}

const problem = (text: string): Diagnostic => argumentsProblem(DRIVE_READ, text);
const readFailed = (text: string): PageAnswer =>
  failed({ severity: 'error', code: 'E_RECIPE_VERB', message: `'${DRIVE_READ}' failed: ${text}.` });
const changed = (what: string): PageAnswer =>
  readFailed(`${what} changed while its pages were read; run again`);

export async function driveReadPage(
  host: DriveReadHost,
  request: PageRequest,
): Promise<PageAnswer> {
  const asked = readReadArguments(request.arguments, request.section);
  if ('severity' in asked) return failed(asked);
  const print = fingerprint(JSON.stringify(asked));
  let cursor: ReadCursor | undefined;
  if (request.cursor !== undefined) {
    const decoded = decodeOpaque(request.cursor, CURSOR_LIMIT);
    if (typeof decoded === 'string') return readFailed(`${decoded}; run again`);
    if (!isReadCursor(decoded.value)) {
      return readFailed('the cursor is not one this plugin writes; run again');
    }
    cursor = decoded.value;
    if (cursor.f !== print) {
      return readFailed('the step changed between two pages of one run; run again');
    }
  }

  const connection = await connect(host, request.section);
  if (!connection.ok) return failed(verbFailed(DRIVE_READ, connection.error));
  const { client } = connection.value;

  let files: readonly DriveFile[];
  let listing = '';
  if (asked.mode === 'file') {
    const file = await getFile(client, asked.fileId);
    if (!file.ok) return failed(verbFailed(DRIVE_READ, file.error));
    files = [file.value];
  } else {
    const listed = await jsonFilesOf(client, asked.folderId);
    if ('severity' in listed) return failed(listed);
    files = listed;
    // The first page's columns hold only while no file changes, so each file's size and
    // modified time are part of the folder's fingerprint.
    listing = fingerprint(
      JSON.stringify(files.map((file) => [file.id, file.size ?? null, file.modifiedTime ?? null])),
    );
    if (cursor !== undefined && cursor.l !== listing) return changed('the folder');
  }

  let columns: JsonColumns | undefined = cursor?.c;
  let skipped: readonly number[] = cursor?.s ?? [];
  let warnings: readonly Diagnostic[] = [];
  let index = cursor?.i ?? 0;
  let surveyed: JsonRecords | undefined;
  if (asked.mode === 'folder' && cursor === undefined) {
    const survey = await surveyFolder(client, files, asked);
    if ('severity' in survey) return failed(survey);
    ({ columns, skipped, warnings } = survey);
    const first = nextKept(files, -1, skipped);
    if (first === undefined) {
      return {
        ok: true,
        value: { table: { columns: jsonColumns(columns), rows: [] } },
        diagnostics: warnings,
      };
    }
    index = first;
    surveyed = survey.first;
  }

  const file = files[index];
  if (file === undefined || (cursor !== undefined && cursor.id !== file.id)) {
    return changed('the folder');
  }
  const digest = fingerprint(
    JSON.stringify([file.id, file.size ?? null, file.modifiedTime ?? null]),
  );
  if (cursor !== undefined && cursor.o > 0 && cursor.d !== digest) {
    return changed(`the file '${file.name}'`);
  }
  const format = formatOf(file, asked);
  if (typeof format !== 'string') return failed(problem(format.problem));

  const fetchedAt = new Date().toISOString();
  let tableColumns: readonly Column[];
  let rows: readonly Row[];
  if (format === 'text') {
    const body = await download(client, file);
    if ('severity' in body) return failed(body);
    if ('problem' in body) return failed(problem(body.problem));
    tableColumns = TEXT_COLUMNS;
    rows = textRows(file, body.body, fetchedAt);
  } else {
    let read = surveyed;
    if (read === undefined) {
      const body = await download(client, file);
      if ('severity' in body) return failed(body);
      if ('problem' in body) return failed(problem(body.problem));
      const parsed = jsonRecords(file, body.body, asked.rows);
      if (typeof parsed === 'string') return readFailed(parsed);
      read = parsed;
    }
    if (columns === undefined) {
      const own = new ColumnUnion();
      own.add(file.name, read);
      columns = own.columns();
    }
    const built = jsonRows(file, read, columns, fetchedAt);
    if (typeof built === 'string') return readFailed(built);
    tableColumns = jsonColumns(columns);
    rows = built;
  }

  const start = cursor?.o ?? 0;
  const page = pageOf(rows, start);
  const table: Table = { columns: tableColumns, rows: page };
  const end = start + page.length;
  const carried = format === 'json' ? columns : undefined;
  const rest = (next: Omit<ReadCursor, 'v' | 'l' | 'f' | 'c' | 's'>): PageAnswer => {
    const written: ReadCursor = {
      v: 1,
      ...next,
      l: listing,
      ...(carried === undefined ? {} : { c: carried }),
      ...(skipped.length === 0 ? {} : { s: skipped }),
      f: print,
    };
    return { ok: true, value: { table, cursor: encodeOpaque(written) }, diagnostics: warnings };
  };
  if (end < rows.length) return rest({ i: index, id: file.id, o: end, d: digest });
  const following = nextKept(files, index, skipped);
  const followingFile = following === undefined ? undefined : files[following];
  if (following === undefined || followingFile === undefined) {
    return { ok: true, value: { table }, diagnostics: warnings };
  }
  return rest({ i: following, id: followingFile.id, o: 0, d: '' });
}

interface Survey {
  readonly columns: JsonColumns;
  readonly skipped: readonly number[];
  readonly warnings: readonly Diagnostic[];
  /** The records of the first file kept, so the first page does not download it twice. */
  readonly first?: JsonRecords;
}

/**
 * Reads every file of the folder once and judges each alone: a file that is not JSON, that
 * lacks the `rows=` list, that is over 8 MiB, or whose keys cannot join the others' is named in
 * a warning and skipped, and the columns are the union of the kept files' keys. Only a failed
 * request fails the run, since it says nothing about the file.
 */
async function surveyFolder(
  client: GoogleClient,
  files: readonly DriveFile[],
  asked: Asked,
): Promise<Survey | Diagnostic> {
  const union = new ColumnUnion();
  const skipped: number[] = [];
  const warnings: Diagnostic[] = [];
  let first: JsonRecords | undefined;
  for (const [index, file] of files.entries()) {
    const judged = await judgeFile(client, file, asked, union);
    if ('severity' in judged) return judged;
    if ('problem' in judged) {
      skipped.push(index);
      warnings.push(skippedFile(file, judged.problem));
    } else first ??= judged.read;
  }
  return {
    columns: union.columns(),
    skipped,
    warnings,
    ...(first === undefined ? {} : { first }),
  };
}

/** The file's records once its keys joined the others', or why it is skipped. */
async function judgeFile(
  client: GoogleClient,
  file: DriveFile,
  asked: Asked,
  union: ColumnUnion,
): Promise<{ readonly read: JsonRecords } | { readonly problem: string } | Diagnostic> {
  const format = formatOf(file, asked);
  if (typeof format !== 'string') return format;
  const body = await download(client, file);
  if (!('body' in body)) return body;
  const read = jsonRecords(file, body.body, asked.rows);
  if (typeof read === 'string') return { problem: read };
  const refused = union.add(file.name, read);
  return refused === undefined ? { read } : { problem: refused };
}

function skippedFile(file: DriveFile, reason: string): Diagnostic {
  return {
    severity: 'warning',
    code: 'E_RECIPE_VERB',
    message: `'${DRIVE_READ}' skipped the file ${file.id} and read the others: ${reason}.`,
  };
}

/** The place of the first file after `after` that the first page did not skip. */
function nextKept(
  files: readonly DriveFile[],
  after: number,
  skipped: readonly number[],
): number | undefined {
  for (let index = after + 1; index < files.length; index += 1) {
    if (!skipped.includes(index)) return index;
  }
  return undefined;
}

/** Every JSON file directly in the folder, oldest first, through every page of the listing. */
async function jsonFilesOf(
  client: GoogleClient,
  folderId: string,
): Promise<readonly DriveFile[] | Diagnostic> {
  const found: DriveFile[] = [];
  let token: string | undefined;
  do {
    const page = await listChildren(client, folderId, 'json', token);
    if (!page.ok) return verbFailed(DRIVE_READ, page.error);
    found.push(...page.value.files.filter((file) => isJson(file.mimeType, file.name)));
    if (found.length > MAX_FILES) {
      return problem(
        `reads at most ${MAX_FILES} JSON files of a folder, one per page, and this folder ` +
          'holds more; move some of them to another folder',
      );
    }
    token = page.value.nextPageToken;
  } while (token !== undefined);
  return found;
}

/** How the file is read, or why it cannot be. */
function formatOf(file: DriveFile, asked: Asked): Format | { readonly problem: string } {
  if (file.mimeType === FOLDER_MIME_TYPE) {
    return { problem: `file= names '${file.name}', which is a folder; read a folder with folder=` };
  }
  if (file.mimeType.startsWith(NATIVE_PREFIX)) {
    return {
      problem:
        `cannot read '${file.name}', a native Google file (${file.mimeType}), which has no ` +
        'content to download; read a spreadsheet with google.sheet-rows, or save the file ' +
        'as JSON or text in Drive',
    };
  }
  if (file.size !== undefined && file.size > MAX_FILE_BYTES) {
    return { problem: tooLarge(file, file.size) };
  }
  if (asked.mode === 'folder') return 'json';
  if (asked.type !== undefined) return asked.type;
  if (isJson(file.mimeType, file.name)) return 'json';
  if (file.mimeType.startsWith('text/')) return 'text';
  return {
    problem:
      `cannot tell how to read '${file.name}' (${file.mimeType || 'no type'}), which is neither ` +
      'JSON nor text; type=text reads it as lines of text',
  };
}

/** The file's text; or, when it is over {@link MAX_FILE_BYTES}, why it is not read. */
async function download(
  client: GoogleClient,
  file: DriveFile,
): Promise<{ readonly body: string } | { readonly problem: string } | Diagnostic> {
  const body = await downloadFile(client, file.id);
  if (!body.ok) return verbFailed(DRIVE_READ, body.error);
  const bytes = new TextEncoder().encode(body.value).byteLength;
  if (bytes > MAX_FILE_BYTES) return { problem: tooLarge(file, bytes) };
  return { body: body.value };
}

function tooLarge(file: DriveFile, bytes: number): string {
  return `reads files of at most ${MAX_FILE_BYTES} bytes (8 MiB), and '${file.name}' has ${bytes}`;
}

/** One row per line, numbered from 1; the empty line after a final line break is no line. */
function textRows(file: DriveFile, text: string, fetchedAt: string): Row[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines.map((line, at) => {
    const key = `${file.id}:${at + 1}`;
    return {
      key,
      values: { file_id: file.id, file_name: file.name, line: at + 1, text: line },
      provenance: { source: ORIGIN, id: key, fetchedAt },
    };
  });
}

/** At most {@link PAGE_ROWS} rows from `start`, stopping before {@link PAGE_BYTES}. */
function pageOf(rows: readonly Row[], start: number): Row[] {
  const encoder = new TextEncoder();
  const page: Row[] = [];
  let bytes = 0;
  for (let index = start; index < rows.length && page.length < PAGE_ROWS; index += 1) {
    const row = rows[index];
    if (row === undefined) break;
    bytes += encoder.encode(JSON.stringify(row)).byteLength;
    if (page.length > 0 && bytes > PAGE_BYTES) break;
    page.push(row);
  }
  return page;
}

function isReadCursor(value: unknown): value is ReadCursor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  const columns = record['c'];
  const skipped = record['s'];
  return (
    record['v'] === 1 &&
    Number.isSafeInteger(record['i']) &&
    (record['i'] as number) >= 0 &&
    typeof record['id'] === 'string' &&
    Number.isSafeInteger(record['o']) &&
    (record['o'] as number) >= 0 &&
    typeof record['d'] === 'string' &&
    typeof record['l'] === 'string' &&
    typeof record['f'] === 'string' &&
    (skipped === undefined ||
      (Array.isArray(skipped) &&
        skipped.every((place) => Number.isSafeInteger(place) && (place as number) >= 0))) &&
    (columns === undefined ||
      (Array.isArray(columns) &&
        columns.every(
          (column) =>
            Array.isArray(column) &&
            column.length === 2 &&
            typeof column[0] === 'string' &&
            typeof column[1] === 'string',
        )))
  );
}

/** The step's arguments, checked: one file, or a folder's JSON files. */
export function readReadArguments(values: ArgumentValues, section: unknown): Asked | Diagnostic {
  const fileWritten = textArgument(values, 'file');
  const type = textArgument(values, 'type')?.toLowerCase();
  if (type !== undefined && type !== 'json' && type !== 'text') {
    return problem(`type= must be json or text, not '${type}'`);
  }
  const rows = textArgument(values, 'rows');
  if (rows !== undefined && type === 'text') {
    return problem('rows= spreads a list of a JSON object into rows; type=text reads lines');
  }
  if (fileWritten !== undefined) {
    if (textArgument(values, 'folder') !== undefined) {
      return problem('takes file= or folder=, not both');
    }
    const fileId = fileIdOf(fileWritten);
    if (fileId === undefined) {
      return problem(
        `file= holds '${fileWritten}', which is neither a Drive file id nor its address, such ` +
          'as https://drive.google.com/file/d/<id>/view',
      );
    }
    return {
      mode: 'file',
      fileId,
      ...(type === undefined ? {} : { type: type as Format }),
      ...(rows === undefined ? {} : { rows }),
    };
  }
  if (type === 'text') {
    return problem('reads a folder as its JSON files only; type=text needs file=');
  }
  const folderId = folderArgument(DRIVE_READ, values, section);
  if (typeof folderId !== 'string') return folderId;
  return { mode: 'folder', folderId, ...(rows === undefined ? {} : { rows }) };
}
