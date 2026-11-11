import { ORIGIN, type CellValue, type Column, type ColumnType, type Row } from './verb.js';

/** A cell as `values.get` answers it with `UNFORMATTED_VALUE` and dates as formatted text. */
export type RawCell = string | number | boolean;

/**
 * One tab as it was read: its values from row 1, and the links and notes of the columns that
 * were asked for. Everything a page is cut from, and what the cache keeps.
 */
export interface Snapshot {
  readonly spreadsheetId: string;
  readonly sheetId: number;
  readonly title: string;
  /** `values.get`'s rows, from the header; Google drops each row's trailing blanks. */
  readonly values: readonly (readonly RawCell[])[];
  /**
   * By column index (from 0), the link of every sheet row (from 1) that has one. A column is
   * present when its links were read, even with none, so a cache entry says what it covers.
   */
  readonly links: Readonly<Record<string, Readonly<Record<string, string>>>>;
  /** The same, for notes. */
  readonly notes: Readonly<Record<string, Readonly<Record<string, string>>>>;
}

/** The columns a step asked for, by index into the header. */
export interface ReadPlan {
  readonly key?: number;
  readonly links: readonly number[];
  readonly notes: readonly number[];
}

export interface Grid {
  readonly columns: readonly Column[];
  readonly rows: readonly Row[];
}

/** The column letter of an index from 0: `A`, `Z`, `AA`. */
export function columnLetter(index: number): string {
  let letters = '';
  for (let rest = index + 1; rest > 0; rest = Math.floor((rest - 1) / 26)) {
    letters = String.fromCharCode(65 + ((rest - 1) % 26)) + letters;
  }
  return letters;
}

/**
 * The header's names, one per column that holds anything, or why the tab has no usable header.
 *
 * **A blank or repeated name is refused**, never invented or numbered: a recipe reads a column
 * by its name, so a header renamed to collide with another, or a column with data and no name,
 * would silently feed the wrong cells to every step after this one. Repeated is without case,
 * as Tyto compares column names.
 */
export function headerOf(values: Snapshot['values'], title: string): string[] | string {
  const first = values[0] ?? [];
  const width = values.reduce((widest, row) => Math.max(widest, row.length), 0);
  if (width === 0) return `the tab '${title}' is empty; row 1 must hold the column names`;
  const names: string[] = [];
  const seen = new Map<string, string>();
  for (let index = 0; index < width; index += 1) {
    const cell = first[index];
    const name = cell === undefined ? '' : String(cell).trim();
    const letter = columnLetter(index);
    if (name === '') {
      return (
        `the tab '${title}' has no column name in ${letter}1, and column ${letter} holds ` +
        'values; name it, or clear the column'
      );
    }
    const before = seen.get(name.toLowerCase());
    if (before !== undefined) {
      return (
        `the tab '${title}' names two columns '${name}' (${before}1 and ${letter}1); every ` +
        'column name in row 1 must differ, ignoring case'
      );
    }
    seen.set(name.toLowerCase(), letter);
    names.push(name);
  }
  return names;
}

/** The index of the header written, ignoring case, or `undefined`. */
export function columnIndexOf(names: readonly string[], written: string): number | undefined {
  const wanted = written.trim().toLowerCase();
  const index = names.findIndex((name) => name.toLowerCase() === wanted);
  return index < 0 ? undefined : index;
}

/** The column's type: number or boolean only when every cell that holds a value agrees. */
export function inferType(values: Snapshot['values'], column: number): ColumnType {
  let numbers = 0;
  let booleans = 0;
  let filled = 0;
  for (const row of values.slice(1)) {
    const cell = row[column];
    if (cell === undefined || cell === '') continue;
    filled += 1;
    if (typeof cell === 'number') numbers += 1;
    else if (typeof cell === 'boolean') booleans += 1;
  }
  if (filled > 0 && numbers === filled) return 'number';
  if (filled > 0 && booleans === filled) return 'boolean';
  return 'text';
}

/** A cell under its column's type: a number or boolean in a text column becomes its text. */
export function cellOf(cell: RawCell | undefined, type: ColumnType): CellValue {
  if (cell === undefined || cell === '') return null;
  if (type !== 'text') return cell;
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE';
  return String(cell);
}

/**
 * Every data row of the snapshot as a table row, or why the tab cannot be one table.
 *
 * Columns are the header's names in order, then `<name>_url` (a link) for each column of
 * `links=` and `<name>_note` (text) for each of `notes=`. A row whose cells, links and notes
 * are all empty is skipped. The key is the `key=` column's text, refused when blank or
 * repeated; without `key=` it is `row-<n>`, the row's number in the sheet. The provenance id
 * is `<spreadsheetId>/<sheetId>/<row number>`, which a write verb finds the row by.
 */
export function gridOf(
  snapshot: Snapshot,
  names: readonly string[],
  plan: ReadPlan,
  fetchedAt: string,
): Grid | string {
  const types = names.map((_, index) => inferType(snapshot.values, index));
  const columns: Column[] = names.map((name, index) => ({
    name,
    type: types[index] ?? 'text',
    origin: ORIGIN,
  }));
  for (const index of plan.links) {
    columns.push({ name: `${names[index] ?? ''}_url`, type: 'link', origin: ORIGIN });
  }
  for (const index of plan.notes) {
    columns.push({ name: `${names[index] ?? ''}_note`, type: 'text', origin: ORIGIN });
  }
  const taken = new Map<string, string>();
  for (const column of columns) {
    const lowered = column.name.toLowerCase();
    const before = taken.get(lowered);
    if (before !== undefined) {
      return (
        `the column '${column.name}' this step adds is the tab '${snapshot.title}''s column ` +
        `'${before}' already; rename that header`
      );
    }
    taken.set(lowered, column.name);
  }

  const rows: Row[] = [];
  const keys = new Map<string, number>();
  const keyName = plan.key === undefined ? undefined : names[plan.key];
  for (let index = 1; index < snapshot.values.length; index += 1) {
    const sheetRow = index + 1;
    const cells = snapshot.values[index] ?? [];
    const values: Record<string, CellValue> = {};
    let empty = true;
    names.forEach((name, column) => {
      const value = cellOf(cells[column], types[column] ?? 'text');
      if (value !== null) empty = false;
      values[name] = value;
    });
    for (const column of plan.links) {
      const link = snapshot.links[String(column)]?.[String(sheetRow)] ?? null;
      if (link !== null) empty = false;
      values[`${names[column] ?? ''}_url`] = link;
    }
    for (const column of plan.notes) {
      const note = snapshot.notes[String(column)]?.[String(sheetRow)] ?? null;
      if (note !== null) empty = false;
      values[`${names[column] ?? ''}_note`] = note;
    }
    if (empty) continue;

    let key = `row-${sheetRow}`;
    if (plan.key !== undefined && keyName !== undefined) {
      const cell = cells[plan.key];
      const written = cell === undefined ? '' : String(cell).trim();
      if (written === '') {
        return `row ${sheetRow} of the tab '${snapshot.title}' has no ${keyName}, which key= names`;
      }
      const before = keys.get(written);
      if (before !== undefined) {
        return (
          `rows ${before} and ${sheetRow} of the tab '${snapshot.title}' both hold ` +
          `'${written}' in ${keyName}, which key= names; a key must be unique`
        );
      }
      keys.set(written, sheetRow);
      key = written;
    }
    rows.push({
      key,
      values,
      provenance: {
        source: ORIGIN,
        id: `${snapshot.spreadsheetId}/${snapshot.sheetId}/${sheetRow}`,
        fetchedAt,
      },
    });
  }
  return { columns, rows };
}
