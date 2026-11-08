/**
 * Drive's query strings and field masks: pure string work, no request.
 *
 * `escapeDriveQueryValue`, `childByNameQuery`, `FOLDER_MIME_TYPE`, `ITEM_FIELDS` and
 * `CHILD_LIST_FIELDS` are ported verbatim from Jacurutu's Drive adapter
 * (`packages/adapter-drive/src/query.ts` and `constants.ts`), where a live probe proved them;
 * only the quotes follow this repository's Prettier.
 */

/** Drive's folder MIME type — the marker that distinguishes a folder from a file. */
export const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

/** Field mask for a single-item read (`files.get`), per the 046 probe. */
export const ITEM_FIELDS = 'id, name, mimeType';
/** Field mask for a child listing (`files.list`), per the 046 probe. */
export const CHILD_LIST_FIELDS = 'files(id, name, mimeType)';

/**
 * Escape a value for a single-quoted Drive query term. Backslash first — escaping it
 * after the apostrophe would double-escape the backslash the apostrophe just added.
 */
export function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

/**
 * The direct-child-by-name query, in the form proven live by the 046 probe:
 * `'<parent>' in parents and name = '<name>' and trashed = false`. Trashed items are
 * excluded because a name freed by a deletion must read as absent.
 */
export function childByNameQuery(parentId: string, name: string): string {
  const parent = escapeDriveQueryValue(parentId);
  const child = escapeDriveQueryValue(name);
  return `'${parent}' in parents and name = '${child}' and trashed = false`;
}

// The rest is this plugin's own, built on the ported pieces above.

/** What `google.drive-list type=` and `google.drive-read` select. */
export type DriveType = 'folder' | 'file' | 'image' | 'json';
export const DRIVE_TYPES: readonly DriveType[] = ['folder', 'file', 'image', 'json'];

/** `ITEM_FIELDS` and what a listed row shows: size, times, its page in Drive, its parents. */
export const FILE_FIELDS = `${ITEM_FIELDS}, size, createdTime, modifiedTime, webViewLink, parents`;
/** `CHILD_LIST_FIELDS` widened the same way, with the next page's token. */
export const LIST_FIELDS = `nextPageToken, files(${FILE_FIELDS})`;

/** A native Google file (Docs, Sheets, Slides…), which has no bytes to download. */
export const NATIVE_PREFIX = 'application/vnd.google-apps.';

/**
 * The children of a folder, not in the trash, of one type. A JSON file is told by its name as
 * well as its type (Buraqueira's inbox reads names ending in `.json`), and Drive has no "ends
 * with", so `json` asks for every file and {@link kindOf} picks.
 */
export function childrenQuery(folderId: string, type: DriveType | undefined): string {
  const base = `'${escapeDriveQueryValue(folderId)}' in parents and trashed = false`;
  switch (type) {
    case 'folder':
      return `${base} and mimeType = '${FOLDER_MIME_TYPE}'`;
    case 'image':
      return `${base} and mimeType contains 'image/'`;
    case 'file':
    case 'json':
      return `${base} and mimeType != '${FOLDER_MIME_TYPE}'`;
    case undefined:
      return base;
  }
}

/** The most specific type a listed item answers to: what its `kind` column shows. */
export function kindOf(mimeType: string, name: string): DriveType {
  if (mimeType === FOLDER_MIME_TYPE) return 'folder';
  if (mimeType.startsWith('image/')) return 'image';
  if (isJson(mimeType, name)) return 'json';
  return 'file';
}

export function isJson(mimeType: string, name: string): boolean {
  return mimeType === 'application/json' || name.toLowerCase().endsWith('.json');
}

/** Whether an item of this kind is one `type=` asks for. */
export function matchesType(kind: DriveType, type: DriveType | undefined): boolean {
  if (type === undefined) return true;
  if (type === 'file') return kind !== 'folder';
  return kind === type;
}
