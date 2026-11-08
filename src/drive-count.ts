import type { PluginHost, RecipeVerbContribution } from '@tyto/plugin-api';

import { folderIdOf } from './config.js';
import { connect } from './connect.js';
import { DRIVE_FILES, LIST_PAGE_SIZE, textArgument } from './drive-files.js';
import { imageCountQuery } from './drive-query.js';
import { googleError, googleOk, type GoogleResult } from './errors.js';
import type { GoogleClient } from './http.js';
import { listed } from './sheet-write.js';
import {
  argumentsProblem,
  ORIGIN,
  verbFailed,
  type ArgumentSpec,
  type CellValue,
  type Diagnostic,
  type TransformAnswer,
  type TransformRequest,
} from './verb.js';

export const DRIVE_COUNT = 'google.drive-count';
/**
 * The most folders one call counts. Each costs at least one Drive listing, and a transform
 * answers the whole table in one call of the host's 30 s.
 */
export const MAX_FOLDERS = 100;

const ARGUMENTS: readonly ArgumentSpec[] = [
  { name: 'folder', type: 'text', required: true },
  { name: 'type', type: 'text', values: ['image'] },
];

export type DriveCountHost = Pick<PluginHost, 'credentials' | 'fetch'>;

/**
 * `google.drive-count folder=<column> [type=image]`: adds `<column>_images`, the number of PNG
 * and JPEG files directly in the folder each row names, as Buraqueira's `contar_imagens`.
 * Subfolders are not counted: they hold working files and discarded versions.
 */
export function driveCountVerb(host: DriveCountHost): RecipeVerbContribution {
  return {
    id: DRIVE_COUNT,
    kind: 'transform',
    arguments: ARGUMENTS,
    transform: (request) => countImages(host, request),
  };
}

const refused = (diagnostic: Diagnostic): TransformAnswer => ({ ok: false, error: [diagnostic] });
const problem = (text: string): Diagnostic => argumentsProblem(DRIVE_COUNT, text);

export async function countImages(
  host: DriveCountHost,
  request: TransformRequest,
): Promise<TransformAnswer> {
  const { table } = request;
  const asked = textArgument(request.arguments, 'folder');
  if (asked === undefined) return refused(problem('needs folder=, the column naming each folder'));
  const column =
    table.columns.find((each) => each.name === asked) ??
    table.columns.find((each) => each.name.toLowerCase() === asked.toLowerCase());
  if (column === undefined) {
    return refused(
      problem(
        `folder= names the column '${asked}', which the table does not have; its columns are ` +
          listed(table.columns.map((each) => each.name)),
      ),
    );
  }
  const added = `${column.name}_images`;
  if (table.columns.some((each) => each.name.toLowerCase() === added.toLowerCase())) {
    return refused(problem(`would add the column '${added}', which the table already has`));
  }

  const folderOfRow: (string | null)[] = [];
  for (const row of table.rows) {
    const value = row.values[column.name];
    if (value === null || value === undefined || value === '') {
      folderOfRow.push(null);
      continue;
    }
    const id = folderIdOf(value);
    if (id === undefined) {
      return refused(
        problem(
          `row ${row.key}: ${column.name} holds '${String(value)}', which is neither a Drive ` +
            'folder id nor its address',
        ),
      );
    }
    folderOfRow.push(id);
  }
  const folders = [...new Set(folderOfRow.filter((id): id is string => id !== null))];
  if (folders.length > MAX_FOLDERS) {
    return refused({
      severity: 'error',
      code: 'E_RECIPE_VERB',
      message:
        `'${DRIVE_COUNT}' would count ${folders.length.toLocaleString('en-US')} folders, over ` +
        `the ${MAX_FOLDERS} one call counts; narrow it to fewer rows first.`,
    });
  }

  const counts = new Map<string, number>();
  if (folders.length > 0) {
    const connection = await connect(host, request.section);
    if (!connection.ok) return refused(verbFailed(DRIVE_COUNT, connection.error));
    for (const folder of folders) {
      const counted = await countIn(connection.value.client, folder);
      if (!counted.ok) return refused(verbFailed(DRIVE_COUNT, counted.error));
      counts.set(folder, counted.value);
    }
  }

  return {
    ok: true,
    value: {
      columns: [...table.columns, { name: added, type: 'number', origin: ORIGIN }],
      rows: table.rows.map((row, index) => {
        const folder = folderOfRow[index];
        const count: CellValue =
          folder === null || folder === undefined ? null : (counts.get(folder) ?? null);
        return { ...row, values: { ...row.values, [added]: count } };
      }),
    },
    diagnostics: [],
  };
}

/** The PNG and JPEG files directly in one folder, every page of Drive's listing read. */
async function countIn(client: GoogleClient, folderId: string): Promise<GoogleResult<number>> {
  let total = 0;
  let pageToken: string | undefined;
  do {
    const answer = await client.get(DRIVE_FILES, {
      q: imageCountQuery(folderId),
      fields: 'nextPageToken, files(id)',
      pageSize: LIST_PAGE_SIZE,
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      ...(pageToken === undefined ? {} : { pageToken }),
    });
    if (!answer.ok) return answer;
    const record = answer.value as Readonly<Record<string, unknown>> | null;
    const files = record?.['files'];
    if (!Array.isArray(files)) {
      return googleError('E_GOOGLE_RESPONSE', 'Google answered the image count with no files.');
    }
    total += files.length;
    const next = record?.['nextPageToken'];
    pageToken = typeof next === 'string' && next !== '' ? next : undefined;
  } while (pageToken !== undefined);
  return googleOk(total);
}
