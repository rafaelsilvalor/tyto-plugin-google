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
  { name: 'shapes', type: 'text', values: ['yes', 'no'] },
];

/**
 * The aspect ratios an image snaps to, as `[width, height]`: the usual post and story shapes.
 * A ratio within {@link SNAP_TOLERANCE} of one of them reads as it, so `1081x1350` reads `4:5`.
 */
export const SNAPPED_RATIOS: readonly (readonly [number, number])[] = [
  [1, 1],
  [4, 5],
  [9, 16],
  [16, 9],
  [3, 2],
  [2, 3],
];
/** How far, relative to a usual ratio, an image's ratio may stray and still read as it. */
export const SNAP_TOLERANCE = 0.02;
/** Wider than this reads `wide`: a banner, whose exact ratio varies with every placement. */
const WIDE_ABOVE = 2;

export type DriveCountHost = Pick<PluginHost, 'fetch' | 'signin'>;

/**
 * `google.drive-count folder=<column> [type=image] [shapes=yes]`: adds `<column>_images`, the
 * number of PNG and JPEG files directly in the folder each row names, as Buraqueira's
 * `contar_imagens`. Subfolders are not counted: they hold working files and discarded versions.
 * With `shapes=yes` it also adds `<column>_shapes`, each aspect ratio and its count, such as
 * `4:5:3,9:16:1`, read from the same listing.
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
  const withShapes = textArgument(request.arguments, 'shapes')?.toLowerCase() === 'yes';
  const shapesAdded = `${column.name}_shapes`;
  for (const name of withShapes ? [added, shapesAdded] : [added]) {
    if (table.columns.some((each) => each.name.toLowerCase() === name.toLowerCase())) {
      return refused(problem(`would add the column '${name}', which the table already has`));
    }
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

  const counts = new Map<string, Counted>();
  if (folders.length > 0) {
    const connection = await connect(host, request.section);
    if (!connection.ok) return refused(verbFailed(DRIVE_COUNT, connection.error));
    for (const folder of folders) {
      const counted = await countIn(connection.value.client, folder, withShapes);
      if (!counted.ok) return refused(verbFailed(DRIVE_COUNT, counted.error));
      counts.set(folder, counted.value);
    }
  }

  return {
    ok: true,
    value: {
      columns: [
        ...table.columns,
        { name: added, type: 'number', origin: ORIGIN },
        ...(withShapes ? [{ name: shapesAdded, type: 'text' as const, origin: ORIGIN }] : []),
      ],
      rows: table.rows.map((row, index) => {
        const folder = folderOfRow[index];
        const counted = folder === null || folder === undefined ? undefined : counts.get(folder);
        const count: CellValue = counted?.total ?? null;
        if (!withShapes) return { ...row, values: { ...row.values, [added]: count } };
        const shapes: CellValue = counted === undefined ? null : shapesText(counted.shapes);
        return { ...row, values: { ...row.values, [added]: count, [shapesAdded]: shapes } };
      }),
    },
    diagnostics: [],
  };
}

/** One folder's images: how many, and how many of each shape when shapes were asked. */
interface Counted {
  readonly total: number;
  readonly shapes: ReadonlyMap<string, number>;
}

/**
 * An image's shape: a usual ratio it snaps to, `wide` past 2:1, its own ratio reduced
 * otherwise, and `?` when Drive reported no dimensions.
 */
export function shapeOf(width: number | undefined, height: number | undefined): string {
  if (width === undefined || height === undefined) return '?';
  const ratio = width / height;
  for (const [across, down] of SNAPPED_RATIOS) {
    const usual = across / down;
    if (Math.abs(ratio - usual) <= SNAP_TOLERANCE * usual) return `${across}:${down}`;
  }
  if (ratio > WIDE_ABOVE) return 'wide';
  const divisor = greatestCommonDivisor(width, height);
  return `${width / divisor}:${height / divisor}`;
}

/** `ratio:count` pairs joined by `,`, the most frequent first, ties by ratio. */
export function shapesText(shapes: ReadonlyMap<string, number>): string {
  return [...shapes]
    .sort(([ratioA, countA], [ratioB, countB]) =>
      countA !== countB ? countB - countA : ratioA < ratioB ? -1 : ratioA > ratioB ? 1 : 0,
    )
    .map(([ratio, count]) => `${ratio}:${count}`)
    .join(',');
}

function greatestCommonDivisor(a: number, b: number): number {
  return b === 0 ? a : greatestCommonDivisor(b, a % b);
}

/**
 * The PNG and JPEG files directly in one folder, every page of Drive's listing read. Shapes come
 * from the same listing's `imageMediaMetadata`: no call per file.
 */
async function countIn(
  client: GoogleClient,
  folderId: string,
  withShapes: boolean,
): Promise<GoogleResult<Counted>> {
  let total = 0;
  const shapes = new Map<string, number>();
  let pageToken: string | undefined;
  do {
    const answer = await client.get(DRIVE_FILES, {
      q: imageCountQuery(folderId),
      fields: withShapes
        ? 'nextPageToken, files(id, imageMediaMetadata(width, height))'
        : 'nextPageToken, files(id)',
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
    if (withShapes) {
      for (const file of files) {
        const shape = shapeOf(...dimensionsOf(file));
        shapes.set(shape, (shapes.get(shape) ?? 0) + 1);
      }
    }
    const next = record?.['nextPageToken'];
    pageToken = typeof next === 'string' && next !== '' ? next : undefined;
  } while (pageToken !== undefined);
  return googleOk({ total, shapes });
}

/** Width and height from a listed file's `imageMediaMetadata`, each a positive whole number. */
function dimensionsOf(file: unknown): [number | undefined, number | undefined] {
  const record = file as Readonly<Record<string, unknown>> | null;
  const image = record?.['imageMediaMetadata'] as Readonly<Record<string, unknown>> | undefined;
  const pixels = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
  return [pixels(image?.['width']), pixels(image?.['height'])];
}
