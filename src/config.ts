import { googleError, googleOk, type GoogleResult } from './errors.js';

/** The `google` section of `.tyto/project.json`: what a team's folder works with. */
export interface GoogleSection {
  /** The spreadsheet's id, from an id or its address. */
  readonly spreadsheet?: string;
  /** The Drive folder the Drive verbs stay under, from an id or its address. */
  readonly root?: string;
  /** Per-tab settings, read by the verb that formats a tab. */
  readonly tabs?: Readonly<Record<string, unknown>>;
}

/** The `google` section, checked. Absent, it is an empty one: every value is optional. */
export function readSection(value: unknown): GoogleResult<GoogleSection> {
  if (value === undefined || value === null) return googleOk({});
  if (typeof value !== 'object' || Array.isArray(value)) {
    return googleError(
      'E_GOOGLE_CONFIG',
      'The google section of .tyto/project.json is not an object.',
    );
  }
  const record = value as Readonly<Record<string, unknown>>;

  let spreadsheet: string | undefined;
  if (record['spreadsheet'] !== undefined && record['spreadsheet'] !== null) {
    spreadsheet = spreadsheetIdOf(record['spreadsheet']);
    if (spreadsheet === undefined) {
      return googleError(
        'E_GOOGLE_CONFIG',
        'spreadsheet in the google section of .tyto/project.json is neither a spreadsheet id ' +
          'nor its address, such as https://docs.google.com/spreadsheets/d/<id>/edit.',
      );
    }
  }

  let root: string | undefined;
  if (record['root'] !== undefined && record['root'] !== null) {
    root = folderIdOf(record['root']);
    if (root === undefined) {
      return googleError(
        'E_GOOGLE_CONFIG',
        'root in the google section of .tyto/project.json is neither a Drive folder id nor ' +
          'its address, such as https://drive.google.com/drive/folders/<id>.',
      );
    }
  }

  const tabs = record['tabs'];
  if (tabs !== undefined && (typeof tabs !== 'object' || tabs === null || Array.isArray(tabs))) {
    return googleError(
      'E_GOOGLE_CONFIG',
      'tabs in the google section of .tyto/project.json is not an object of tab names.',
    );
  }

  return googleOk({
    ...(spreadsheet === undefined ? {} : { spreadsheet }),
    ...(root === undefined ? {} : { root }),
    ...(tabs === undefined ? {} : { tabs: tabs as Readonly<Record<string, unknown>> }),
  });
}

/** A Drive id: letters, digits, `-` and `_`, long enough not to be a word typed by mistake. */
const DRIVE_ID = /^[A-Za-z0-9_-]{10,}$/;

/** The id of a spreadsheet written as its id or as its address. */
export function spreadsheetIdOf(written: unknown): string | undefined {
  return idOf(written, /^\/spreadsheets\/d\/([A-Za-z0-9_-]+)/, 'docs.google.com');
}

/** The id of a Drive folder written as its id or as its address. */
export function folderIdOf(written: unknown): string | undefined {
  return idOf(written, /\/folders\/([A-Za-z0-9_-]+)/, 'drive.google.com');
}

/** The id of a Drive file written as its id or as its address (`/file/d/<id>/view`). */
export function fileIdOf(written: unknown): string | undefined {
  return idOf(written, /^\/file\/d\/([A-Za-z0-9_-]+)/, 'drive.google.com');
}

function idOf(written: unknown, path: RegExp, hostname: string): string | undefined {
  if (typeof written !== 'string') return undefined;
  const trimmed = written.trim();
  if (DRIVE_ID.test(trimmed)) return trimmed;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' || url.hostname !== hostname) return undefined;
  const id = path.exec(url.pathname)?.[1];
  return id !== undefined && DRIVE_ID.test(id) ? id : undefined;
}
