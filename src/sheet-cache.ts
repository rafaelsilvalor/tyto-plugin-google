import type { PluginHost } from '@tyto/plugin-api';

import { messageOf } from './errors.js';
import type { RawCell, Snapshot } from './sheet-grid.js';

/**
 * The private cache of `google.sheet-rows` (Tyto ADR 0138): one tab's snapshot, read once and
 * cut into pages from here, so a 30,000-row tab is one read of Google and six pages of Tyto.
 *
 * **An entry is served only at the Drive `version` it was read at**, which the first page asks
 * Drive for every time: any edit to the spreadsheet raises it, so a cached tab is never older
 * than the file. Later pages of the same run take the entry by the snapshot's digest instead,
 * so a run is one snapshot even if the sheet is edited while it pages.
 *
 * **The cache never fails a read.** A host with no cache, a refused write, an entry over the
 * host's 32 MiB or one that is not this plugin's shape is a warning in the log and a live read.
 */

/** The host's ceiling on one entry (Tyto ADR 0138), written here to keep the bundle import-free. */
export const ENTRY_LIMIT_BYTES = 32 * 1024 * 1024;

export type CacheHost = Pick<PluginHost, 'cache' | 'log'>;

export interface CacheEntry {
  readonly v: 1;
  /** The Drive version the snapshot was read at. Nothing is cached when Drive did not say. */
  readonly version: string;
  readonly fetchedAt: string;
  readonly snapshot: Snapshot;
}

/** `sheet/<spreadsheetId>/<sheetId>`: one entry per tab, replaced by every live read of it. */
export function cacheKey(spreadsheetId: string, sheetId: number): string {
  return `sheet/${spreadsheetId}/${sheetId}`;
}

export async function readCache(
  host: CacheHost,
  verb: string,
  spreadsheetId: string,
  sheetId: number,
): Promise<CacheEntry | undefined> {
  let stored;
  try {
    stored = await host.cache.get(cacheKey(spreadsheetId, sheetId));
  } catch (thrown) {
    host.log.warn(`${verb} read no cache: ${messageOf(thrown)}`);
    return undefined;
  }
  if (stored === undefined) return undefined;
  if (stored.bytes.byteLength > ENTRY_LIMIT_BYTES) {
    host.log.warn(`${verb} ignored a cache entry of ${stored.bytes.byteLength} bytes`);
    return undefined;
  }
  const entry = entryOf(stored.bytes);
  if (
    entry === undefined ||
    entry.snapshot.spreadsheetId !== spreadsheetId ||
    entry.snapshot.sheetId !== sheetId
  ) {
    host.log.warn(`${verb} ignored a cache entry it did not write`);
    return undefined;
  }
  return entry;
}

/** Stores a tab's snapshot; a refusal is a warning, never the read's failure. */
export async function writeCache(host: CacheHost, verb: string, entry: CacheEntry): Promise<void> {
  const bytes = new TextEncoder().encode(JSON.stringify(entry));
  if (bytes.byteLength > ENTRY_LIMIT_BYTES) {
    host.log.warn(`${verb} cached no tab of ${bytes.byteLength} bytes, over the host's limit`);
    return;
  }
  try {
    await host.cache.put(cacheKey(entry.snapshot.spreadsheetId, entry.snapshot.sheetId), bytes);
  } catch (thrown) {
    host.log.warn(`${verb} cached nothing: ${messageOf(thrown)}`);
  }
}

function entryOf(bytes: Uint8Array): CacheEntry | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
  const entry = recordOf(parsed);
  const snapshot = recordOf(entry?.['snapshot']);
  if (
    entry?.['v'] !== 1 ||
    typeof entry['version'] !== 'string' ||
    typeof entry['fetchedAt'] !== 'string' ||
    snapshot === undefined ||
    typeof snapshot['spreadsheetId'] !== 'string' ||
    !Number.isSafeInteger(snapshot['sheetId']) ||
    typeof snapshot['title'] !== 'string' ||
    !isValues(snapshot['values']) ||
    !isByColumn(snapshot['links']) ||
    !isByColumn(snapshot['notes'])
  ) {
    return undefined;
  }
  return parsed as CacheEntry;
}

function isValues(value: unknown): value is RawCell[][] {
  return (
    Array.isArray(value) &&
    value.every(
      (row) =>
        Array.isArray(row) &&
        row.every((cell) => ['string', 'number', 'boolean'].includes(typeof cell)),
    )
  );
}

function isByColumn(value: unknown): boolean {
  const columns = recordOf(value);
  return (
    columns !== undefined &&
    Object.values(columns).every((rows) => {
      const byRow = recordOf(rows);
      return byRow !== undefined && Object.values(byRow).every((text) => typeof text === 'string');
    })
  );
}

function recordOf(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : undefined;
}
