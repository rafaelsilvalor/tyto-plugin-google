import type { PluginHost, RecipeVerbContribution } from '@tyto/plugin-api';

import { connect } from './connect.js';
import { textArgument } from './drive-files.js';
import { cellOf, columnIndexOf, inferType, type RawCell } from './sheet-grid.js';
import { firstSnapshot, notInTab } from './sheet-read.js';
import { keyText } from './sheet-sync-apply.js';
import { listed, spreadsheetOf } from './sheet-write.js';
import {
  argumentsProblem,
  ORIGIN,
  verbFailed,
  type ArgumentSpec,
  type CellValue,
  type Column,
  type Diagnostic,
  type TransformAnswer,
  type TransformRequest,
} from './verb.js';

export const SHEET_LOOKUP = 'google.sheet-lookup';
export const DEFAULT_PREFIX = 'sheet_';

const ARGUMENTS: readonly ArgumentSpec[] = [
  { name: 'spreadsheet', type: 'text' },
  { name: 'tab', type: 'text', required: true },
  { name: 'key', type: 'text', required: true },
  { name: 'columns', type: 'text', required: true },
  { name: 'prefix', type: 'text' },
  { name: 'links', type: 'text' },
  { name: 'notes', type: 'text' },
];

export type SheetLookupHost = Pick<
  PluginHost,
  'credentials' | 'fetch' | 'signin' | 'cache' | 'log'
>;

/**
 * `google.sheet-lookup tab=<tab> key=<column> columns=<a,b>`: adds the named columns of one tab
 * to each row of the table, found by the row's `key=` value in the tab's column of that same
 * name. It is how a recipe that starts elsewhere sees what a person typed in a synced sheet:
 * a recipe carries one table, and `google.sheet-rows` is only a source.
 *
 * The tab is read as `google.sheet-rows` reads it (one read, its cache at the Drive version). Keys are
 * compared as `google.sheet-sync` compares them: as text, trimmed, case kept. A key the tab
 * holds twice is refused, never guessed; a row the tab has no key for gets nulls.
 */
export function sheetLookupVerb(host: SheetLookupHost): RecipeVerbContribution {
  return {
    id: SHEET_LOOKUP,
    kind: 'transform',
    arguments: ARGUMENTS,
    transform: (request) => lookUp(host, request),
  };
}

const refused = (diagnostic: Diagnostic): TransformAnswer => ({ ok: false, error: [diagnostic] });
const problem = (text: string): Diagnostic => argumentsProblem(SHEET_LOOKUP, text);
const listOf = (written: string | undefined): string[] =>
  [...new Set((written ?? '').split(',').map((item) => item.trim()))].filter((item) => item !== '');

/** An added column: where its cells come from in the tab, and its name in the table. */
interface Added {
  readonly column: Column;
  readonly cell: (cells: readonly RawCell[], sheetRow: number) => CellValue;
}

export async function lookUp(
  host: SheetLookupHost,
  request: TransformRequest,
): Promise<TransformAnswer> {
  const { table } = request;
  const tabName = textArgument(request.arguments, 'tab');
  if (tabName === undefined) return refused(problem('needs tab=, the tab to look rows up in'));
  const keyName = textArgument(request.arguments, 'key');
  if (keyName === undefined) return refused(problem('needs key=, the column to match rows by'));
  const wanted = listOf(textArgument(request.arguments, 'columns'));
  if (wanted.length === 0) return refused(problem('needs columns=, the tab columns to add'));
  const links = listOf(textArgument(request.arguments, 'links'));
  const notes = listOf(textArgument(request.arguments, 'notes'));
  const prefix =
    request.arguments['prefix'] === undefined
      ? DEFAULT_PREFIX
      : String(request.arguments['prefix']).trim();

  const keyColumn =
    table.columns.find((each) => each.name === keyName) ??
    table.columns.find((each) => each.name.toLowerCase() === keyName.toLowerCase());
  if (keyColumn === undefined) {
    return refused(
      problem(
        `key= names the column '${keyName}', which the table does not have; its columns are ` +
          listed(table.columns.map((each) => each.name)),
      ),
    );
  }
  const spreadsheetId = spreadsheetOf(
    SHEET_LOOKUP,
    request.arguments['spreadsheet'],
    request.section,
  );
  if (typeof spreadsheetId !== 'string') return refused(spreadsheetId);

  const connection = await connect(host, request.section);
  if (!connection.ok) return refused(verbFailed(SHEET_LOOKUP, connection.error));
  const read = await firstSnapshot(
    host,
    SHEET_LOOKUP,
    connection.value.client,
    { spreadsheetId, tab: tabName, key: keyColumn.name, links, notes },
    // The contract (0.15) hands `refresh` to a source's `page` only, never to a transform, so
    // a run without cache cannot reach here; the cache is still served only at the file's
    // current Drive version, which any edit to the spreadsheet raises.
    false,
  );
  if ('severity' in read) return refused(read);
  const { snapshot, names, plan } = read;
  const kc = plan.key ?? 0;

  // The added columns, in the order asked: values, then links, then notes.
  const added: Added[] = [];
  for (const written of wanted) {
    const at = columnIndexOf(names, written);
    if (at === undefined)
      return refused(notInTab(SHEET_LOOKUP, 'columns', written, names, snapshot.title));
    const type = inferType(snapshot.values, at);
    added.push({
      column: { name: `${prefix}${names[at] ?? ''}`, type, origin: ORIGIN },
      cell: (cells) => cellOf(cells[at], type),
    });
  }
  for (const at of plan.links) {
    added.push({
      column: { name: `${prefix}${names[at] ?? ''}_url`, type: 'link', origin: ORIGIN },
      cell: (_, sheetRow) => snapshot.links[String(at)]?.[String(sheetRow)] ?? null,
    });
  }
  for (const at of plan.notes) {
    added.push({
      column: { name: `${prefix}${names[at] ?? ''}_note`, type: 'text', origin: ORIGIN },
      cell: (_, sheetRow) => snapshot.notes[String(at)]?.[String(sheetRow)] ?? null,
    });
  }
  const taken = new Set(table.columns.map((each) => each.name.toLowerCase()));
  for (const { column } of added) {
    const lowered = column.name.toLowerCase();
    if (taken.has(lowered)) {
      return refused(
        problem(
          `would add the column '${column.name}', which the table already has; name another ` +
            'prefix=',
        ),
      );
    }
    taken.add(lowered);
  }

  // The tab's rows by key, as google.sheet-sync reads them: a blank key is no row to match.
  const rowOfKey = new Map<string, number>();
  for (let index = 1; index < snapshot.values.length; index += 1) {
    const key = keyText(snapshot.values[index]?.[kc]);
    if (key === '') continue;
    const sheetRow = index + 1;
    const before = rowOfKey.get(key);
    if (before !== undefined) {
      return refused(
        problem(
          `rows ${before} and ${sheetRow} of the tab '${snapshot.title}' both hold '${key}' in ` +
            `${names[kc] ?? ''}; a key must be unique, and the lookup does not guess which row is it`,
        ),
      );
    }
    rowOfKey.set(key, sheetRow);
  }

  return {
    ok: true,
    value: {
      columns: [...table.columns, ...added.map(({ column }) => column)],
      rows: table.rows.map((row) => {
        const key = keyText(row.values[keyColumn.name]);
        const sheetRow = key === '' ? undefined : rowOfKey.get(key);
        const cells = sheetRow === undefined ? undefined : (snapshot.values[sheetRow - 1] ?? []);
        const values = { ...row.values };
        for (const { column, cell } of added) {
          values[column.name] =
            cells === undefined || sheetRow === undefined ? null : cell(cells, sheetRow);
        }
        return { ...row, values };
      }),
    },
    diagnostics: [],
  };
}
