import type { DriveFile } from './drive-files.js';
import { ORIGIN, type CellValue, type Column, type ColumnType, type Row } from './verb.js';

/** A JSON file's own columns, as `[name, type]`, in the order their keys first appear. */
export type JsonColumns = readonly (readonly [string, string])[];

/** The most keys a JSON file's elements may hold between them, and a folder's files too. */
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

/** One JSON file read as records: each row's cells, and their keys in first-seen order. */
export interface JsonRecords {
  readonly records: readonly Readonly<Record<string, CellValue>>[];
  readonly names: readonly string[];
}

/**
 * A JSON file as records, one per row, or why it cannot be read. An array gives one record per
 * element and an object gives one. With `rowsKey`, the file must be an object holding a list
 * under that key: each element of the list is a record, and the object's other scalar keys are
 * copied onto every one of them (an element's own key of the same name wins).
 *
 * An element's keys are its cells; an element that is not an object goes into `value`. A
 * nested object, or a list holding one, is kept as its JSON text, since a cell holds only text,
 * numbers, booleans and lists of them.
 */
export function jsonRecords(
  file: DriveFile,
  text: string,
  rowsKey: string | undefined,
): JsonRecords | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as unknown;
  } catch {
    return `'${file.name}' is not JSON`;
  }
  const isObject = typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed);
  let elements: readonly unknown[];
  let shared: Readonly<Record<string, CellValue>> = {};
  if (rowsKey !== undefined) {
    if (!isObject) {
      return `'${file.name}' is not a JSON object, and rows=${rowsKey} reads a list in one`;
    }
    const object = parsed as Readonly<Record<string, unknown>>;
    if (!Object.hasOwn(object, rowsKey)) return `'${file.name}' has no key '${rowsKey}'`;
    const list = object[rowsKey];
    if (!Array.isArray(list)) {
      return `'${file.name}' holds ${kindOf(list)} under '${rowsKey}', not a list`;
    }
    elements = list;
    shared = Object.fromEntries(
      Object.entries(object)
        .filter(([key, value]) => key !== rowsKey && (value === null || typeof value !== 'object'))
        .map(([key, value]) => [key, cellOf(value)]),
    );
  } else if (Array.isArray(parsed)) elements = parsed;
  else if (isObject) elements = [parsed];
  else return `'${file.name}' holds neither a JSON array nor an object`;

  const records = elements.map((element): Readonly<Record<string, CellValue>> => {
    if (typeof element === 'object' && element !== null && !Array.isArray(element)) {
      return {
        ...shared,
        ...Object.fromEntries(
          Object.entries(element as Record<string, unknown>).map(([key, value]) => [
            key,
            cellOf(value),
          ]),
        ),
      };
    }
    return { ...shared, [VALUE_COLUMN]: cellOf(element) };
  });
  // The copied keys come first, in the file's order, even when the list is empty.
  const names = namesOf([shared, ...records], file.name);
  if (typeof names === 'string') return names;
  return { records, names };
}

/** The keys of the records, first-seen order, or why one of them cannot be a column. */
function namesOf(
  records: readonly Readonly<Record<string, CellValue>>[],
  fileName: string,
): string[] | string {
  const names: string[] = [];
  const lowered = new Map<string, string>();
  for (const record of records) {
    for (const name of Object.keys(record)) {
      const lower = name.toLowerCase();
      const seen = lowered.get(lower);
      if (seen === name) continue;
      if (name.trim() === '') return `'${fileName}' has a key with no name`;
      if ((FILE_COLUMNS as readonly string[]).includes(lower)) {
        return `'${fileName}' has the key '${name}', which names the column every row of the file gets`;
      }
      if (seen !== undefined) {
        return `'${fileName}' has the keys '${seen}' and '${name}', which differ only in case`;
      }
      lowered.set(lower, name);
      names.push(name);
    }
  }
  if (names.length > MAX_JSON_COLUMNS) {
    return `'${fileName}' has ${names.length} keys, over ${MAX_JSON_COLUMNS}`;
  }
  return names;
}

/**
 * The columns of one or more JSON files, gathered a file at a time: the union of their keys in
 * first-seen order, each typed by what every file holds under it. A file that cannot join is
 * refused alone, and the columns stay as they were before it.
 */
export class ColumnUnion {
  private readonly names: string[] = [];
  private readonly lowered = new Map<string, string>();
  private readonly kinds = new Map<string, Set<ColumnType>>();

  /** Adds the file's keys and values, or says why the file cannot join, changing nothing. */
  add(fileName: string, read: JsonRecords): string | undefined {
    const added: string[] = [];
    for (const name of read.names) {
      const seen = this.lowered.get(name.toLowerCase());
      if (seen === name) continue;
      if (seen !== undefined) {
        return `'${fileName}' has the key '${name}', which differs only in case from '${seen}' in an earlier file`;
      }
      added.push(name);
    }
    const total = this.names.length + added.length;
    if (total > MAX_JSON_COLUMNS) {
      return `'${fileName}' would bring the folder's keys to ${total}, over ${MAX_JSON_COLUMNS}`;
    }
    for (const name of added) {
      this.lowered.set(name.toLowerCase(), name);
      this.names.push(name);
      this.kinds.set(name, new Set());
    }
    for (const record of read.records) {
      for (const [name, value] of Object.entries(record)) {
        if (value !== null) this.kinds.get(name)?.add(kindOfCell(value));
      }
    }
    return undefined;
  }

  /** A column is a number, a boolean or a list only when every filled value agrees; else text. */
  columns(): JsonColumns {
    return this.names.map((name) => [name, typeOfKinds(this.kinds.get(name))] as const);
  }
}

/**
 * A file's records as rows into `columns`, keyed `<fileId>:<index>` from 0; a key the file
 * lacks is an empty cell. A key outside the columns, or a value its column cannot hold, is
 * refused: the columns were read off this file when the run began, so the file changed since.
 */
export function jsonRows(
  file: DriveFile,
  read: JsonRecords,
  columns: JsonColumns,
  fetchedAt: string,
): Row[] | string {
  const known = new Set(columns.map(([name]) => name));
  const extra = read.names.find((name) => !known.has(name));
  if (extra !== undefined) {
    return `'${file.name}' has the key '${extra}', which it did not have when the run began`;
  }
  const rows: Row[] = [];
  for (const [index, record] of read.records.entries()) {
    const key = `${file.id}:${index}`;
    const values: Record<string, CellValue> = { file_id: file.id, file_name: file.name };
    for (const [name, type] of columns) {
      const value = fit(record[name] ?? null, type);
      if (value === undefined) {
        return (
          `'${file.name}' holds ${describe(record[name] ?? null)} under '${name}' in element ` +
          `${index}, where the run began with a ${type} column`
        );
      }
      values[name] = value;
    }
    rows.push({ key, values, provenance: { source: ORIGIN, id: key, fetchedAt } });
  }
  return rows;
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

function kindOf(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'object') return 'an object';
  return `the ${typeof value} ${String(value)}`;
}

function kindOfCell(value: CellValue): ColumnType {
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';
  if (Array.isArray(value)) return 'list';
  return 'text';
}

function typeOfKinds(kinds: ReadonlySet<ColumnType> | undefined): ColumnType {
  if (kinds === undefined || kinds.size !== 1) return 'text';
  const [only] = kinds;
  return only ?? 'text';
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
