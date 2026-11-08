import { base64Decode, base64Url } from './jwt.js';

/**
 * Where a `google.sheet-rows` read left off, handed to the host and back with the next page.
 *
 * Opaque to the host, which only compares it with the cursors it already saw. Every page of one
 * run is cut from one snapshot of the tab, read by the first page: `o` is the offset of the
 * next row in it, `d` the snapshot's digest, so a later page cut from another snapshot (the
 * sheet edited between two pages) is refused rather than stitched onto the earlier ones. `s`
 * is the tab's sheet id, which names the cache entry the snapshot is kept in, and `f`
 * fingerprints the step's arguments, so a cursor handed to a changed step is refused too.
 */
export interface SheetCursor {
  readonly v: 1;
  /** The offset, among the tab's data rows, of the next page's first row. */
  readonly o: number;
  /** {@link fingerprint} of the snapshot the first page read. */
  readonly d: string;
  /** The tab's sheet id. */
  readonly s: number;
  /** {@link fingerprint} of the step's arguments. */
  readonly f: string;
}

/** A cursor longer than this was not written by this plugin. */
export const MAX_CURSOR_LENGTH = 1000;

export function encodeCursor(cursor: SheetCursor): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(cursor)));
}

/** The cursor, or why it is not one this plugin gave. */
export function decodeCursor(text: string): SheetCursor | string {
  if (text.length > MAX_CURSOR_LENGTH) {
    return `the cursor is ${text.length} characters long, over ${MAX_CURSOR_LENGTH}`;
  }
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return 'the cursor is not base64url';
  const bytes = base64Decode(text.replace(/-/g, '+').replace(/_/g, '/'));
  if (bytes === undefined) return 'the cursor is not base64url';
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return 'the cursor is not JSON';
  }
  return isCursor(parsed) ? parsed : 'the cursor is not one this plugin writes';
}

function isCursor(value: unknown): value is SheetCursor {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return (
    record['v'] === 1 &&
    Number.isSafeInteger(record['o']) &&
    (record['o'] as number) > 0 &&
    typeof record['d'] === 'string' &&
    /^[0-9a-f]{16}$/.test(record['d']) &&
    Number.isSafeInteger(record['s']) &&
    (record['s'] as number) >= 0 &&
    typeof record['f'] === 'string' &&
    /^[0-9a-f]{16}$/.test(record['f'])
  );
}

const FNV_OFFSET = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const MASK_64 = 0xffffffffffffffffn;

/** FNV-1a, 64 bits, of the text's UTF-8, as 16 hex digits: a fingerprint, not a secret. */
export function fingerprint(text: string): string {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(text)) {
    hash ^= BigInt(byte);
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash.toString(16).padStart(16, '0');
}

/**
 * Any JSON value as a cursor, for the Drive verbs, whose cursors carry their own shapes; the
 * verb checks the shape. `limit` is the longest cursor the verb writes.
 */
export function encodeOpaque(value: unknown): string {
  return base64Url(new TextEncoder().encode(JSON.stringify(value)));
}

/** The JSON a cursor of {@link encodeOpaque} carries, or why the text is not one. */
export function decodeOpaque(text: string, limit: number): { readonly value: unknown } | string {
  if (text.length > limit) return `the cursor is ${text.length} characters long, over ${limit}`;
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return 'the cursor is not base64url';
  const bytes = base64Decode(text.replace(/-/g, '+').replace(/_/g, '/'));
  if (bytes === undefined) return 'the cursor is not base64url';
  try {
    return { value: JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) };
  } catch {
    return 'the cursor is not JSON';
  }
}
