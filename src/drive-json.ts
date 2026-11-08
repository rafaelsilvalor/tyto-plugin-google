import type { DriveFile } from './drive-files.js';
import { ORIGIN, type CellValue, type Column, type ColumnType, type Row } from './verb.js';

/** A JSON file's own columns, as `[name, type]`, in the order their keys first appear. */
export type JsonColumns = readonly (readonly [string, string])[];

/** The most keys a JSON file's elements may hold between them. */
export const MAX_JSON_COLUMNS = 200;

/** Every row of a JSON file says which file it came from. */
const FILE_COLUMNS = ['file_id', 'file_name'] as const;
/** The column an element that is not an object is read into. */
const VALUE_COLUMN = 'value';

/** The table's columns: the file's two, then the JSON's. */
export function jsonColumns(columns: JsonColumns): Column[] {
  return [
    ...FILE_COLUMNS.map((name): Column => ({ name, type: 'text', origin: ORIGIN })),
    ...columns.map(([name, type]): Column => ({ name, type: type as ColumnType, origin: ORIGIN })),
  ];
}

/**
 * A JSON file as rows: an array gives one row per element, keyed `<fileId>:<index>` from 0, and
 * an object gives one row, `<fileId>:0`. An element's keys are its columns; an element that is
 * not an object goes into `value`. A nested object, or a list holding one, is kept as its JSON
 * text, since a cell holds only text, numbers, booleans and lists of them.
 *
 * `carried` is the columns of the first file of a folder: every later file is read into them,
 * so the pages of one run agree. A key the first file did not have is refused, naming both, and
 * a value is written as text in a text column, or refused in a column of another type.
 */
export function jsonRows(
  file: DriveFile,
  text: string,
  fetchedAt: string,
  carried: JsonColumns | undefined,
): { readonly columns: JsonColumns; readonly rows: Row[] } | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
  } catch {
    return `'${file.name}' is not JSON`;
  }
  let elements: readonly unknown[];
  if (Array.isArray(parsed)) elements = parsed;
  else if (typeof parsed === 'object' && parsed !== null) elements = [parsed];
  else return `'${file.name}' holds neither a JSON array nor an object`;

  const records = elements.map((element): Readonly<Record<string, CellValue>> => {
    if (typeof element === 'object' && element !== null && !Array.isArray(element)) {
      return Object.fromEntries(
        Object.entries(element as Record<string, unknown>).map(([key, value]) => [
          key,
          cellOf(value),
        ]),
      );
    }
    return { [VALUE_COLUMN]: cellOf(element) };
  });

  const names: string[] = [];
  const lowered = new Map<string, string>();
  for (const record of records) {
    for (const name of Object.keys(record)) {
      const lower = name.toLowerCase();
      const seen = lowered.get(lower);
      if (seen === name) continue;
      if (name.trim() === '') return `'${file.name}' has a key with no name`;
      if ((FILE_COLUMNS as readonly string[]).includes(lower)) {
        return `'${file.name}' has the key '${name}', which names the column every row of the file gets`;
      }
      if (seen !== undefined) {
        return `'${file.name}' has the keys '${seen}' and '${name}', which differ only in case`;
      }
      lowered.set(lower, name);
      names.push(name);
    }
  }
  if (names.length > MAX_JSON_COLUMNS) {
    return `'${file.name}' has ${names.length} keys, over ${MAX_JSON_COLUMNS}`;
  }

  const columns: JsonColumns =
    carried ?? names.map((name) => [name, typeOf(records.map((record) => record[name]))] as const);
  if (carried !== undefined) {
    const known = new Set(carried.map(([name]) => name));
    const extra = names.find((name) => !known.has(name));
    if (extra !== undefined) {
      return (
        `'${file.name}' has the key '${extra}', which the folder's first JSON file did not; ` +
        "a folder is read into its first file's columns, so read this file alone with file="
      );
    }
  }

  const rows: Row[] = [];
  for (const [index, record] of records.entries()) {
    const key = `${file.id}:${index}`;
    const values: Record<string, CellValue> = { file_id: file.id, file_name: file.name };
    for (const [name, type] of columns) {
      const value = fit(record[name] ?? null, type);
      if (value === undefined) {
        return (
          `'${file.name}' holds ${describe(record[name] ?? null)} under '${name}' in element ` +
          `${index}, where the folder's first JSON file had a ${type} column`
        );
      }
      values[name] = value;
    }
    rows.push({ key, values, provenance: { source: ORIGIN, id: key, fetchedAt } });
  }
  return { columns, rows };
}

/** A JSON value as a cell. */
function cellOf(value: unknown): CellValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  // JSON.parse turns 1e400 into Infinity, which no cell holds.
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value) && value.every(isScalar)) return value as CellValue[];
  return JSON.stringify(value);
}

function isScalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/** A column's type: one every filled cell agrees on, else text. */
function typeOf(values: readonly (CellValue | undefined)[]): ColumnType {
  const filled = values.filter(
    (value): value is CellValue => value !== undefined && value !== null,
  );
  if (filled.length === 0) return 'text';
  if (filled.every((value) => typeof value === 'number')) return 'number';
  if (filled.every((value) => typeof value === 'boolean')) return 'boolean';
  if (filled.every((value) => Array.isArray(value))) return 'list';
  return 'text';
}

/** The value as the column holds it, or `undefined` when it cannot be. */
function fit(value: CellValue, type: string): CellValue | undefined {
  if (value === null) return null;
  switch (type) {
    case 'number':
      return typeof value === 'number' ? value : undefined;
    case 'boolean':
      return typeof value === 'boolean' ? value : undefined;
    case 'list':
      return Array.isArray(value) ? value : undefined;
    default:
      if (typeof value === 'string') return value;
      return Array.isArray(value) ? JSON.stringify(value) : String(value);
  }
}

function describe(value: CellValue): string {
  if (Array.isArray(value)) return 'a list';
  return typeof value === 'string' ? 'text' : `the ${typeof value} ${String(value)}`;
}
