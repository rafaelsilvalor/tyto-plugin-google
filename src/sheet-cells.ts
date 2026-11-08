import type { CellValue, JsonValue } from './verb.js';

/**
 * A cell as a `google.sheet-write` plan keeps it, in its payload, and as Apply writes it.
 *
 * - `null`: a blank cell, which clears what the cell held.
 * - a number or a boolean: Sheets' number or boolean.
 * - a string: **text, always**, written as `stringValue`, which Sheets never evaluates. A cell
 *   that starts with `=` from a table that read it off a web page or a ticket stays the text it
 *   was, so a recipe cannot be made to write `=IMPORTXML(...)` into a team's sheet.
 * - `{ f }`: a formula, only from a column the step names in `formulas=`.
 * - `{ t, u }`: text linked to `u` through the cell's text run, the link Ctrl+K makes, rather
 *   than `=HYPERLINK(...)` (the coordinator's decision of 2026-11-07).
 */
export type WriteCell =
  | null
  | number
  | boolean
  | string
  | { readonly f: string }
  | { readonly t: string; readonly u: string };

/** What Sheets holds in one cell at most, in characters. */
export const CELL_TEXT_LIMIT = 50_000;

/** The schemes a link may take: a web page or an address. Anything else is refused. */
const LINK = /^(https?:\/\/[^\s]+|mailto:[^\s]+)$/i;

/** How one column of the table is written: where, and whether it may hold formulas. */
export interface WriteColumn {
  /** The table column the cells come from. */
  readonly name: string;
  /** The `<name>_url` link column folded into this one, when the table has it. */
  readonly link?: string;
  /** A link column of its own: each cell is its address, linked to itself. */
  readonly linksItself?: boolean;
  readonly formula: boolean;
}

/** Why a row cannot be written, from one of its cells. */
export interface CellProblem {
  readonly problem: string;
}

/** The cell, or why the row cannot be written. */
export function writeCellOf(
  value: CellValue | undefined,
  column: WriteColumn,
  link: CellValue | undefined,
): WriteCell | CellProblem {
  const text = textOf(value ?? null);
  const uri = textOf((column.linksItself === true ? value : link) ?? null);
  if (uri !== null && uri !== '') {
    if (!LINK.test(uri)) {
      return {
        problem: `${column.link ?? column.name} holds '${shortly(uri)}', which is not a web address`,
      };
    }
    const shown = text === null || text === '' ? uri : text;
    return tooLong(column, shown) ?? { t: shown, u: uri };
  }
  if (value === undefined || value === null) return null;
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (text === null || text === '') return null;
  const limit = tooLong(column, text);
  if (limit !== undefined) return limit;
  return column.formula && text.startsWith('=') ? { f: text } : text;
}

function tooLong(column: WriteColumn, text: string): CellProblem | undefined {
  if (text.length <= CELL_TEXT_LIMIT) return undefined;
  return {
    problem:
      `${column.name} holds ${text.length.toLocaleString('en-US')} characters, over the ` +
      `${CELL_TEXT_LIMIT.toLocaleString('en-US')} a Sheets cell holds`,
  };
}

/** A list's items joined, everything else its text; `null` for a blank cell. */
function textOf(value: CellValue): string | null {
  if (value === null) return null;
  if (Array.isArray(value)) {
    return value
      .map((item) => textOf(item))
      .filter((item): item is string => item !== null && item !== '')
      .join(', ');
  }
  return String(value as string | number | boolean);
}

function shortly(text: string): string {
  return text.length > 60 ? `${text.slice(0, 59)}…` : text;
}

/** A payload's cell, checked, or `undefined` when it is not one this plugin writes. */
export function readWriteCell(value: JsonValue): WriteCell | undefined {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return value;
  if (typeof value !== 'object' || Array.isArray(value)) return undefined;
  const record = value as Readonly<Record<string, JsonValue>>;
  const keys = Object.keys(record).sort().join(',');
  const f = record['f'];
  if (keys === 'f' && typeof f === 'string' && f.startsWith('=')) return { f };
  const t = record['t'];
  const u = record['u'];
  if (keys === 't,u' && typeof t === 'string' && typeof u === 'string' && LINK.test(u)) {
    return { t, u };
  }
  return undefined;
}

/**
 * The fields every write sets, and so clears where a cell gives none: the value, its text runs,
 * and the link Sheets moves into the cell's format when a run covers the whole cell (measured
 * by Buraqueira, 2026-08-09). Without the last one, text written where a link was would still
 * open the old address. Colours, borders and number formats are left as the sheet has them.
 */
export const WRITTEN_FIELDS = 'userEnteredValue,textFormatRuns,userEnteredFormat.textFormat.link';

/** Sheets' link colour, so a written link reads as one. */
const LINK_COLOUR = { red: 0.067, green: 0.4, blue: 0.86 };

/** The cell as Sheets' `CellData`. */
export function cellData(cell: WriteCell): Readonly<Record<string, unknown>> {
  if (cell === null) return {};
  if (typeof cell === 'number') return { userEnteredValue: { numberValue: cell } };
  if (typeof cell === 'boolean') return { userEnteredValue: { boolValue: cell } };
  if (typeof cell === 'string') return { userEnteredValue: { stringValue: cell } };
  if ('f' in cell) return { userEnteredValue: { formulaValue: cell.f } };
  return {
    userEnteredValue: { stringValue: cell.t },
    textFormatRuns: [
      {
        startIndex: 0,
        format: { link: { uri: cell.u }, underline: true, foregroundColor: LINK_COLOUR },
      },
    ],
  };
}

/**
 * Locales whose formulas separate arguments with `;`, because `,` is their decimal mark: the
 * list Buraqueira's `detect_formula_separator` measured against real sheets (2026-08).
 */
const SEMICOLON_LOCALES = ['pt', 'es', 'fr', 'it', 'de', 'nl', 'pl', 'ru', 'tr'];

/** The argument separator a spreadsheet in `locale` (such as `pt_BR`) parses formulas with. */
export function formulaSeparator(locale: string): ',' | ';' {
  const lowered = locale.toLowerCase();
  return SEMICOLON_LOCALES.some((prefix) => lowered.startsWith(prefix)) ? ';' : ',';
}

/**
 * A formula written the English way, `=IF(A2>0,"yes","no")`, in the separator of the sheet it
 * is written to: Sheets parses `formulaValue` in the spreadsheet's locale, so a `pt_BR` sheet
 * refuses `,` between arguments. Only a `,` outside text, a quoted tab name and `{…}` changes:
 * an array literal's `,` means a column there, not an argument, and is left as written.
 */
export function localFormula(formula: string, separator: ',' | ';'): string {
  if (separator === ',') return formula;
  let quote: '"' | "'" | undefined;
  let braces = 0;
  let out = '';
  for (const character of formula) {
    if (quote !== undefined) {
      // A doubled quote inside text closes and reopens it, which comes out the same.
      if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '{') {
      braces += 1;
    } else if (character === '}') {
      braces = Math.max(0, braces - 1);
    } else if (character === ',' && braces === 0) {
      out += ';';
      continue;
    }
    out += character;
  }
  return out;
}

/** One line for a person: the cell as the sheet will show it. */
export function shownCell(cell: WriteCell): string {
  if (cell === null) return '';
  if (typeof cell === 'boolean') return cell ? 'TRUE' : 'FALSE';
  if (typeof cell !== 'object') return String(cell);
  return 'f' in cell ? cell.f : `${cell.t} (${cell.u})`;
}
