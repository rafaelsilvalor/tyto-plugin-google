import { readSection, folderIdOf } from './config.js';
import { googleError, googleOk, type GoogleResult } from './errors.js';
import type { GoogleClient } from './http.js';
import {
  FILE_FIELDS,
  LIST_FIELDS,
  childByNameAndTypeQuery,
  childByNameQuery,
  childrenQuery,
  type DriveType,
} from './drive-query.js';
import { argumentsProblem, verbFailed, type ArgumentValues, type Diagnostic } from './verb.js';

/** Drive v3's files endpoint, on the host the manifest names as `net:www.googleapis.com`. */
export const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files';

/** Drive's own ceiling on a `files.list` page. */
export const LIST_PAGE_SIZE = 1000;

/** What the Drive verbs keep of a file Drive describes. */
export interface DriveFile {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  /** Bytes; absent for a folder and for a native Google file, which have none. */
  readonly size?: number;
  readonly createdTime?: string;
  readonly modifiedTime?: string;
  readonly webViewLink?: string;
  readonly parents: readonly string[];
}

export interface ListPage {
  readonly files: readonly DriveFile[];
  readonly nextPageToken?: string;
}

/**
 * One page of a folder's children, of one type, oldest first. **Shared drives included**:
 * without `supportsAllDrives` and `includeItemsFromAllDrives`, a folder in a shared drive
 * answers as empty rather than as an error.
 */
export async function listChildren(
  client: GoogleClient,
  folderId: string,
  type: DriveType | undefined,
  pageToken: string | undefined,
): Promise<GoogleResult<ListPage>> {
  const answer = await client.get(DRIVE_FILES, {
    q: childrenQuery(folderId, type),
    fields: LIST_FIELDS,
    orderBy: 'createdTime,name',
    pageSize: LIST_PAGE_SIZE,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    ...(pageToken === undefined ? {} : { pageToken }),
  });
  if (!answer.ok) return answer;
  const record = recordOf(answer.value);
  const listed = record?.['files'];
  if (!Array.isArray(listed)) return malformed('the folder listing', 'no files');
  const files: DriveFile[] = [];
  for (const item of listed) {
    const file = fileOf(item);
    if (file === undefined) return malformed('the folder listing', 'a file without id or name');
    files.push(file);
  }
  const next = record?.['nextPageToken'];
  return googleOk({
    files,
    ...(typeof next === 'string' && next !== '' ? { nextPageToken: next } : {}),
  });
}

/**
 * The items directly in a folder that carry exactly this name, not in the trash, by the query
 * ported from Jacurutu ({@link childByNameQuery}). Drive allows two of one name, so a list.
 */
export async function childrenNamed(
  client: GoogleClient,
  parentId: string,
  name: string,
): Promise<GoogleResult<readonly DriveFile[]>> {
  return listAll(client, childByNameQuery(parentId, name));
}

/** The items of one type directly in a folder that carry exactly this name, not in the trash. */
export async function childrenNamedOfType(
  client: GoogleClient,
  parentId: string,
  name: string,
  mimeType: string,
): Promise<GoogleResult<readonly DriveFile[]>> {
  return listAll(client, childByNameAndTypeQuery(parentId, name, mimeType));
}

/** The first page of a listing, up to 1,000 items: enough to tell none, one and several. */
async function listAll(
  client: GoogleClient,
  query: string,
): Promise<GoogleResult<readonly DriveFile[]>> {
  const answer = await client.get(DRIVE_FILES, {
    q: query,
    fields: LIST_FIELDS,
    pageSize: LIST_PAGE_SIZE,
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
  });
  if (!answer.ok) return answer;
  const listed = recordOf(answer.value)?.['files'];
  if (!Array.isArray(listed)) return malformed('the folder listing', 'no files');
  const files: DriveFile[] = [];
  for (const item of listed) {
    const file = fileOf(item);
    if (file === undefined) return malformed('the folder listing', 'a file without id or name');
    files.push(file);
  }
  return googleOk(files);
}

/** One file's description. */
export async function getFile(
  client: GoogleClient,
  fileId: string,
): Promise<GoogleResult<DriveFile>> {
  const answer = await client.get(`${DRIVE_FILES}/${encodeURIComponent(fileId)}`, {
    fields: FILE_FIELDS,
    supportsAllDrives: true,
  });
  if (!answer.ok) return answer;
  const file = fileOf(answer.value);
  return file === undefined ? malformed('the file', 'no id or name') : googleOk(file);
}

/** One file's bytes, as text: Drive's `alt=media`. */
export async function downloadFile(
  client: GoogleClient,
  fileId: string,
): Promise<GoogleResult<string>> {
  return client.getText(`${DRIVE_FILES}/${encodeURIComponent(fileId)}`, {
    alt: 'media',
    supportsAllDrives: true,
  });
}

function fileOf(value: unknown): DriveFile | undefined {
  const record = recordOf(value);
  if (record === undefined) return undefined;
  const { id, name, mimeType } = record;
  if (typeof id !== 'string' || id === '' || typeof name !== 'string') return undefined;
  const text = (field: string): string | undefined => {
    const found = record[field];
    return typeof found === 'string' && found !== '' ? found : undefined;
  };
  // Drive answers an int64 as a string.
  const size = Number(record['size']);
  const createdTime = text('createdTime');
  const modifiedTime = text('modifiedTime');
  const webViewLink = text('webViewLink');
  const parents = Array.isArray(record['parents'])
    ? record['parents'].filter((parent): parent is string => typeof parent === 'string')
    : [];
  return {
    id,
    name,
    mimeType: typeof mimeType === 'string' ? mimeType : '',
    ...(record['size'] !== undefined && Number.isSafeInteger(size) ? { size } : {}),
    ...(createdTime === undefined ? {} : { createdTime }),
    ...(modifiedTime === undefined ? {} : { modifiedTime }),
    ...(webViewLink === undefined ? {} : { webViewLink }),
    parents,
  };
}

function malformed(what: string, why: string): GoogleResult<never> {
  return googleError('E_GOOGLE_RESPONSE', `Google answered ${what} with ${why}.`);
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}

/** An argument's text, trimmed; `undefined` when absent or blank. */
export function textArgument(values: ArgumentValues, name: string): string | undefined {
  const value = values[name];
  if (value === undefined) return undefined;
  const trimmed = String(value).trim();
  return trimmed === '' ? undefined : trimmed;
}

/** `folder=` as an id, or the section's `root` when the step names none. */
export function folderArgument(
  verb: string,
  values: ArgumentValues,
  section: unknown,
): string | Diagnostic {
  const written = textArgument(values, 'folder');
  if (written !== undefined) {
    const id = folderIdOf(written);
    if (id !== undefined) return id;
    return argumentsProblem(
      verb,
      `folder= holds '${written}', which is neither a Drive folder id nor its address, such ` +
        'as https://drive.google.com/drive/folders/<id>',
    );
  }
  const read = readSection(section);
  if (!read.ok) return verbFailed(verb, read.error);
  if (read.value.root === undefined) {
    return argumentsProblem(
      verb,
      'needs folder=, or root in the google section of .tyto/project.json, and was given neither',
    );
  }
  return read.value.root;
}
