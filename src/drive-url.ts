import type { PluginHost, RecipeVerbContribution } from '@tyto/plugin-api';

import { connect } from './connect.js';
import { MAX_FOLDERS } from './drive-count.js';
import { childrenNamedOfType, textArgument } from './drive-files.js';
import { destinationOf } from './drive-move.js';
import { FOLDER_MIME_TYPE } from './drive-query.js';
import { rootWalk } from './drive-root.js';
import { plannedFolderId } from './planned-folder.js';
import { listed, shortened } from './sheet-write.js';
import {
  argumentsProblem,
  ORIGIN,
  verbFailed,
  type CellValue,
  type Diagnostic,
  type TransformAnswer,
  type TransformRequest,
} from './verb.js';

export const DRIVE_URL = 'google.drive-url';

export type DriveUrlHost = Pick<PluginHost, 'fetch' | 'signin' | 'cache'>;

/**
 * `google.drive-url path=<column> [in=<folder>]`: adds `<column>_url`, the address of the Drive
 * folder `google.drive-upload` sends each row's workspace folder to: the folder named as the
 * path's last segment, directly in `in=` (the section's `root` by default). While no such
 * folder is there, the address the upload above planned for it (TYTO-758), with a warning, or
 * empty when no upload planned one, so a recipe can run it before the first upload is applied.
 */
export function driveUrlVerb(host: DriveUrlHost): RecipeVerbContribution {
  return {
    id: DRIVE_URL,
    kind: 'transform',
    arguments: [
      { name: 'path', type: 'text', required: true },
      { name: 'in', type: 'text' },
    ],
    transform: (request) => folderUrls(host, request),
  };
}

const refused = (diagnostic: Diagnostic): TransformAnswer => ({ ok: false, error: [diagnostic] });
const problem = (text: string): Diagnostic => argumentsProblem(DRIVE_URL, text);

/** The last segment of a workspace path, `/` or `\` separated; `undefined` when blank. */
export function lastSegment(value: CellValue | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  const name = String(value)
    .trim()
    .replace(/[\\/]+$/u, '')
    .split(/[\\/]/u)
    .at(-1);
  return name === undefined || name === '' ? undefined : name;
}

export async function folderUrls(
  host: DriveUrlHost,
  request: TransformRequest,
): Promise<TransformAnswer> {
  const { table } = request;
  const asked = textArgument(request.arguments, 'path');
  if (asked === undefined) return refused(problem('needs path=, the column naming each folder'));
  const column =
    table.columns.find((each) => each.name === asked) ??
    table.columns.find((each) => each.name.toLowerCase() === asked.toLowerCase());
  if (column === undefined) {
    return refused(
      problem(
        `path= names the column '${asked}', which the table does not have; its columns are ` +
          listed(table.columns.map((each) => each.name)),
      ),
    );
  }
  const added = `${column.name}_url`;
  if (table.columns.some((each) => each.name.toLowerCase() === added.toLowerCase())) {
    return refused(problem(`would add the column '${added}', which the table already has`));
  }
  const names = table.rows.map((row) => lastSegment(row.values[column.name]));
  const distinct = [...new Set(names.filter((name): name is string => name !== undefined))];
  if (distinct.length > MAX_FOLDERS) {
    return refused(
      problem(
        `would look up ${distinct.length.toLocaleString('en-US')} folders, over the ` +
          `${MAX_FOLDERS} one call looks up; narrow it to fewer rows first`,
      ),
    );
  }

  const urls = new Map<string, string | null>();
  const ambiguous: string[] = [];
  const planned: string[] = [];
  if (distinct.length > 0) {
    const connection = await connect(host, request.section);
    if (!connection.ok) return refused(verbFailed(DRIVE_URL, connection.error));
    const { client, section } = connection.value;
    const rootId = section.root;
    if (rootId === undefined) {
      return refused(
        problem('needs root in the google section of .tyto/project.json: it looks only under it'),
      );
    }
    let parent = rootId;
    const within = textArgument(request.arguments, 'in');
    if (within !== undefined) {
      const found = await destinationOf(rootWalk(client, rootId), rootId, rootId, within, 'in=');
      if (!found.ok) {
        return refused(
          'error' in found ? verbFailed(DRIVE_URL, found.error) : problem(found.problem),
        );
      }
      parent = found.folder.id;
    }
    for (const name of distinct) {
      const named = await childrenNamedOfType(client, parent, name, FOLDER_MIME_TYPE);
      if (!named.ok) return refused(verbFailed(DRIVE_URL, named.error));
      const [only, ...more] = named.value;
      if (more.length > 0) ambiguous.push(name);
      let id = more.length > 0 ? undefined : only?.id;
      if (only === undefined) {
        id = await plannedFolderId(host, parent, name);
        if (id !== undefined) planned.push(name);
      }
      urls.set(name, id === undefined ? null : `https://drive.google.com/drive/folders/${id}`);
    }
  }

  return {
    ok: true,
    value: {
      columns: [...table.columns, { name: added, type: 'link', origin: ORIGIN }],
      rows: table.rows.map((row, index) => {
        const name = names[index];
        return {
          ...row,
          values: { ...row.values, [added]: name === undefined ? null : (urls.get(name) ?? null) },
        };
      }),
    },
    diagnostics: [
      ...(ambiguous.length === 0
        ? []
        : [
            warned(
              `'${DRIVE_URL}' left ${added} empty for ${listed(ambiguous)}: more than one ` +
                'folder of that name is there; keep one.',
            ),
          ]),
      ...(planned.length === 0
        ? []
        : [
            warned(
              `'${DRIVE_URL}' gave ${added} for ${listed(planned)} as the address the upload ` +
                'above planned: the folder will be created by the upload above when its plan ' +
                'is applied.',
            ),
          ]),
    ],
  };
}

function warned(message: string): Diagnostic {
  return { severity: 'warning', code: 'E_RECIPE_VERB', message: shortened(message) };
}
