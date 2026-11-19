import { keyText } from './sheet-sync-apply.js';
import type { CellValue } from './verb.js';

/** How a `<name>_note` column writes its cell's note: `set` replaces it, `append` adds a line. */
export type NoteMode = 'set' | 'append';

/** A cell's note to write: the column, from 0, and the note's whole text. */
export type NoteChange = readonly [number, string];

/**
 * The note a cell ends with, or `undefined` when its note stays as it is.
 *
 * A blank value leaves the note alone in both modes, so a read that failed before this step
 * never erases a note a person wrote; `set` cannot clear a note. `append` adds the value as a
 * line under the note, and plans nothing when the note's last line is the value already, so a
 * recipe run twice does not write the same line twice. Only the last line counts: the same
 * line after another one, such as an assignee changed back and forth, is added again.
 */
export function plannedNote(
  mode: NoteMode,
  current: string | undefined,
  value: CellValue | undefined,
): string | undefined {
  const text = keyText(value);
  if (text === '') return undefined;
  const now = current ?? '';
  if (mode === 'set') return now === text ? undefined : text;
  const kept = now.trimEnd();
  if (kept === text || kept.endsWith(`\n${text}`)) return undefined;
  return kept === '' ? text : `${kept}\n${text}`;
}

/** One line for a person: how the note of the column `name` changes. */
export function shownNote(
  name: string,
  mode: NoteMode,
  current: string | undefined,
  value: CellValue | undefined,
  next: string,
): string {
  if (mode === 'append') return `${name} note: + ${JSON.stringify(keyText(value))}`;
  const before = current === undefined || current === '' ? '(none)' : JSON.stringify(current);
  return `${name} note: ${before} → ${JSON.stringify(next)}`;
}
