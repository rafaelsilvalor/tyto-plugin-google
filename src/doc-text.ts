import type { PluginHost, RecipeVerbContribution } from '@tyto/plugin-api';

import { connectAsPerson } from './connect.js';
import { textArgument } from './drive-files.js';
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

export const DOC_TEXT = 'google.doc-text';

/** The most distinct Docs one call exports, as `google.drive-url` looks up at most 100 folders. */
export const MAX_DOCS = 100;

/**
 * What a Doc is exported as. Markdown keeps a copy's headings, lists and emphasis, which Tyto's
 * `to-delivery copy-text=` writes into `editaveis/copy.md` (Tyto ADR 0217); the maintainer chose
 * it over plain text on 2026-11-19.
 */
export const EXPORT_MIME_TYPE = 'text/markdown';

const FILES = 'https://www.googleapis.com/drive/v3/files';

export type DocTextHost = Pick<PluginHost, 'fetch' | 'signin'>;

const ARGUMENTS: RecipeVerbContribution['arguments'] = [
  { name: 'doc', type: 'text', required: true },
  { name: 'as', type: 'text' },
];

/**
 * `google.doc-text doc=<column> [as=<column>]`: adds `<column>_text`, the text of the Google Doc
 * each row links to, exported by Drive as Markdown. A cell that is no Doc's link, a Doc too
 * large to export, or one the person cannot open leaves the cell empty, with a warning naming
 * the rows: one bad link does not stop the others.
 */
export function docTextVerb(host: DocTextHost): RecipeVerbContribution {
  return {
    id: DOC_TEXT,
    kind: 'transform',
    arguments: ARGUMENTS,
    transform: (request) => docTexts(host, request),
  };
}

const refused = (diagnostic: Diagnostic): TransformAnswer => ({ ok: false, error: [diagnostic] });
const problem = (text: string): Diagnostic => argumentsProblem(DOC_TEXT, text);

/** A cell read as a link: a Doc's id, another Google editor file, or neither. */
export type LinkRead =
  | { readonly kind: 'doc'; readonly id: string }
  | { readonly kind: 'other-editor'; readonly type: string }
  | { readonly kind: 'not-a-link' };

/** A Drive id: as `config.ts` reads one, long enough not to be a word typed by mistake. */
const DRIVE_ID = /^[A-Za-z0-9_-]{10,}$/;
/** `/document/d/<id>`, also with the account segment (`/document/u/0/d/<id>`) a link may carry. */
const EDITOR_PATH = /^\/([a-z]+)(?:\/u\/\d+)?\/d\/([A-Za-z0-9_-]+)/;
const EDITOR_TYPES: Readonly<Record<string, string>> = {
  spreadsheets: 'Sheet',
  presentation: 'Slides',
  forms: 'Form',
  drawings: 'Drawing',
};

/**
 * What a cell links to. Only an address on `docs.google.com` counts: a bare id, or a Drive
 * `file/d/` link, could be any file, and telling would cost a request per row.
 */
export function readLink(value: CellValue | undefined): LinkRead {
  if (value === null || value === undefined) return { kind: 'not-a-link' };
  let url: URL;
  try {
    url = new URL(String(value).trim());
  } catch {
    return { kind: 'not-a-link' };
  }
  if (url.protocol !== 'https:' || url.hostname !== 'docs.google.com')
    return { kind: 'not-a-link' };
  const [, type = '', id = ''] = EDITOR_PATH.exec(url.pathname) ?? [];
  if (!DRIVE_ID.test(id)) return { kind: 'not-a-link' };
  if (type === 'document') return { kind: 'doc', id };
  const named = EDITOR_TYPES[type];
  return named === undefined ? { kind: 'not-a-link' } : { kind: 'other-editor', type: named };
}

/** Why a row's cell stayed empty; each reason is one warning naming its rows. */
type Left = 'not-a-link' | 'other-editor' | 'too-large' | 'not-exportable' | 'missing';

const WHY: Readonly<Record<Left, string>> = {
  'not-a-link': 'the cell is not a Google Doc link (https://docs.google.com/document/d/<id>/…)',
  'other-editor':
    'the link is to a Sheet, Slides or another Google file, not a Doc; only a ' +
    "Doc's text is read",
  'too-large': "Drive exports at most 10 MB of a Doc's text, and the Doc is larger; split it",
  'not-exportable':
    'the file opens in Docs but is not a Google Doc (an uploaded Word file); convert it with ' +
    'File > Save as Google Docs',
  missing:
    'the Doc does not exist, or is not shared with the Google account signed in on the ' +
    'plugins screen',
};

export async function docTexts(
  host: DocTextHost,
  request: TransformRequest,
): Promise<TransformAnswer> {
  const { table } = request;
  const asked = textArgument(request.arguments, 'doc');
  if (asked === undefined) return refused(problem('needs doc=, the column of Google Doc links'));
  const column =
    table.columns.find((each) => each.name === asked) ??
    table.columns.find((each) => each.name.toLowerCase() === asked.toLowerCase());
  if (column === undefined) {
    return refused(
      problem(
        `doc= names the column '${asked}', which the table does not have; its columns are ` +
          listed(table.columns.map((each) => each.name)),
      ),
    );
  }
  const added = textArgument(request.arguments, 'as') ?? `${column.name}_text`;
  if (table.columns.some((each) => each.name.toLowerCase() === added.toLowerCase())) {
    return refused(problem(`would add the column '${added}', which the table already has`));
  }

  const leftRows = new Map<Left, string[]>();
  const leave = (why: Left, rowKey: string): void => {
    leftRows.set(why, [...(leftRows.get(why) ?? []), rowKey]);
  };
  const docOfRow: (string | null)[] = table.rows.map((row) => {
    const value = row.values[column.name];
    if (value === null || value === undefined || String(value).trim() === '') return null;
    const read = readLink(value);
    if (read.kind === 'doc') return read.id;
    leave(read.kind, row.key);
    return null;
  });
  const docs = [...new Set(docOfRow.filter((id): id is string => id !== null))];
  if (docs.length > MAX_DOCS) {
    return refused({
      severity: 'error',
      code: 'E_RECIPE_VERB',
      message:
        `'${DOC_TEXT}' would export ${docs.length.toLocaleString('en-US')} Docs, over the ` +
        `${MAX_DOCS} one call exports; narrow it to fewer rows first.`,
    });
  }

  // One export per distinct Doc, never per row: a copy linked from ten rows is read once.
  const texts = new Map<string, { readonly text: string } | { readonly left: Left }>();
  if (docs.length > 0) {
    const client = connectAsPerson(host);
    for (const id of docs) {
      const exported = await client.getText(`${FILES}/${encodeURIComponent(id)}/export`, {
        mimeType: EXPORT_MIME_TYPE,
      });
      if (exported.ok) {
        texts.set(id, { text: exported.value });
        continue;
      }
      const { status, reasons = [] } = exported.error;
      if (reasons.includes('exportSizeLimitExceeded')) texts.set(id, { left: 'too-large' });
      else if (reasons.includes('fileNotExportable')) texts.set(id, { left: 'not-exportable' });
      else if (status === 404) texts.set(id, { left: 'missing' });
      else return refused(verbFailed(DOC_TEXT, exported.error));
    }
  }

  const rows = table.rows.map((row, index) => {
    const id = docOfRow[index];
    const exported = id === null || id === undefined ? undefined : texts.get(id);
    if (exported !== undefined && 'left' in exported) leave(exported.left, row.key);
    const text = exported !== undefined && 'text' in exported ? exported.text : null;
    return { ...row, values: { ...row.values, [added]: text } };
  });

  const order: readonly Left[] = [
    'not-a-link',
    'other-editor',
    'missing',
    'not-exportable',
    'too-large',
  ];
  return {
    ok: true,
    value: { columns: [...table.columns, { name: added, type: 'text', origin: ORIGIN }], rows },
    diagnostics: order.flatMap((why) => {
      const keys = leftRows.get(why);
      if (keys === undefined) return [];
      return [
        {
          severity: 'warning',
          code: 'E_RECIPE_VERB',
          message: shortened(
            `'${DOC_TEXT}' left ${added} empty for ${keys.length === 1 ? 'row' : 'rows'} ` +
              `${rowList(keys)}: ${WHY[why]}.`,
          ),
        } satisfies Diagnostic,
      ];
    }),
  };
}

function rowList(keys: readonly string[]): string {
  return `${keys.slice(0, 20).join(', ')}${keys.length > 20 ? ', …' : ''}`;
}
