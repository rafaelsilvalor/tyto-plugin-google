import type { PluginHost } from '@tyto/plugin-api';

import { fingerprint } from './cursor.js';
import type { GoogleResult } from './errors.js';
import type { GoogleClient } from './http.js';
import { readCache, writeCache, type CacheEntry } from './sheet-cache.js';
import { columnIndexOf, headerOf, type ReadPlan, type Snapshot } from './sheet-grid.js';
import {
  pickTab,
  readCellExtras,
  readTabs,
  readValues,
  readVersion,
  type Tab,
} from './sheet-snapshot.js';
import { argumentsProblem, verbFailed, type Diagnostic } from './verb.js';

/**
 * Reading one tab once, for every verb that reads a tab as a table (`google.sheet-rows`,
 * `google.sheet-lookup`): the same fetch, the same header rules, the same cache under
 * `sheet/<spreadsheetId>/<sheetId>` at the file's Drive `version`, and the same `refresh`.
 */

/** What a step asks of a tab: where it is, and the columns it needs found in its header. */
export interface TabAsk {
  readonly spreadsheetId: string;
  readonly tab?: string;
  readonly key?: string;
  readonly links: readonly string[];
  readonly notes: readonly string[];
}

export interface Read {
  readonly snapshot: Snapshot;
  readonly names: readonly string[];
  readonly plan: ReadPlan;
  readonly fetchedAt: string;
  readonly digest: string;
}

export type ReadHost = Pick<PluginHost, 'cache' | 'log'>;

/**
 * A run's snapshot of the tab: the cached one when Drive's `version` is still the one it was
 * read at and it holds the links and notes asked for, else a live read, which is then cached.
 * `refresh` skips the cache and still fills it.
 */
export async function firstSnapshot(
  host: ReadHost,
  verb: string,
  client: GoogleClient,
  asked: TabAsk,
  refresh: boolean,
): Promise<Read | Diagnostic> {
  const tabs = await readTabs(client, asked.spreadsheetId);
  if (!tabs.ok) return verbFailed(verb, tabs.error);
  const tab = pickTab(tabs.value, asked.tab);
  if (typeof tab === 'string') return argumentsProblem(verb, tab);

  const version = await readVersion(client, asked.spreadsheetId);
  if (!version.ok) {
    host.log.warn(
      `${verb} read the tab without its cache: Drive did not give the file's version ` +
        `(${version.error.code}: ${version.error.message})`,
    );
  }
  if (version.ok && !refresh) {
    const entry = await readCache(host, verb, asked.spreadsheetId, tab.sheetId);
    if (entry !== undefined && entry.version === version.value) {
      const cached = readOf(verb, entry.snapshot, asked, entry.fetchedAt);
      if ('severity' in cached || covers(entry.snapshot, cached.plan)) return cached;
    }
  }

  const live = await liveSnapshot(verb, client, asked, tab);
  if ('severity' in live) return live;
  if (version.ok) {
    const entry: CacheEntry = {
      v: 1,
      version: version.value,
      fetchedAt: live.fetchedAt,
      snapshot: live.snapshot,
    };
    await writeCache(host, verb, entry);
  }
  return live;
}

/** The tab read from Google: its values, then the links and notes asked for. */
export async function liveSnapshot(
  verb: string,
  client: GoogleClient,
  asked: TabAsk,
  tab: Tab,
): Promise<Read | Diagnostic> {
  const values = await readValues(client, asked.spreadsheetId, tab);
  if (!values.ok) return verbFailed(verb, values.error);
  const bare: Snapshot = {
    spreadsheetId: asked.spreadsheetId,
    sheetId: tab.sheetId,
    title: tab.title,
    values: values.value,
    links: {},
    notes: {},
  };
  const fetchedAt = new Date().toISOString();
  const resolved = readOf(verb, bare, asked, fetchedAt);
  if ('severity' in resolved) return resolved;
  const extras: GoogleResult<Pick<Snapshot, 'links' | 'notes'>> = await readCellExtras(
    client,
    asked.spreadsheetId,
    tab,
    resolved.plan,
    values.value.length,
  );
  if (!extras.ok) return verbFailed(verb, extras.error);
  return readOf(verb, { ...bare, ...extras.value }, asked, fetchedAt) as Read;
}

/** The snapshot with its header read and the step's columns found in it. */
export function readOf(
  verb: string,
  snapshot: Snapshot,
  asked: TabAsk,
  fetchedAt: string,
): Read | Diagnostic {
  const names = headerOf(snapshot.values, snapshot.title);
  if (typeof names === 'string') {
    return { severity: 'error', code: 'E_RECIPE_VERB', message: `'${verb}' failed: ${names}.` };
  }
  const find = (argument: string, written: string): number | Diagnostic =>
    columnIndexOf(names, written) ?? notInTab(verb, argument, written, names, snapshot.title);
  let key: number | undefined;
  if (asked.key !== undefined) {
    const found = find('key', asked.key);
    if (typeof found !== 'number') return found;
    key = found;
  }
  const links: number[] = [];
  for (const written of asked.links) {
    const found = find('links', written);
    if (typeof found !== 'number') return found;
    if (!links.includes(found)) links.push(found);
  }
  const notes: number[] = [];
  for (const written of asked.notes) {
    const found = find('notes', written);
    if (typeof found !== 'number') return found;
    if (!notes.includes(found)) notes.push(found);
  }
  const plan: ReadPlan = { ...(key === undefined ? {} : { key }), links, notes };
  return { snapshot, names, plan, fetchedAt, digest: digestOf(snapshot, plan) };
}

/** An argument naming a column the tab's header does not have, with the columns it has. */
export function notInTab(
  verb: string,
  argument: string,
  written: string,
  names: readonly string[],
  title: string,
): Diagnostic {
  const listed = names
    .slice(0, 20)
    .map((name) => `'${name}'`)
    .join(', ');
  return argumentsProblem(
    verb,
    `${argument}= names '${written}', which is not a column of the tab '${title}'; ` +
      `its columns are ${listed}${names.length > 20 ? ', …' : ''}`,
  );
}

/** Whether the snapshot holds the links and notes of every column the plan asks for. */
export function covers(snapshot: Snapshot, plan: ReadPlan): boolean {
  return (
    plan.links.every((column) => snapshot.links[String(column)] !== undefined) &&
    plan.notes.every((column) => snapshot.notes[String(column)] !== undefined)
  );
}

/** What a page is cut from, fingerprinted: the values and the asked columns' links and notes. */
function digestOf(snapshot: Snapshot, plan: ReadPlan): string {
  const pick = (byColumn: Snapshot['links'], columns: readonly number[]) =>
    columns.map((column) => [column, byColumn[String(column)] ?? null]);
  return fingerprint(
    JSON.stringify([
      snapshot.sheetId,
      snapshot.values,
      pick(snapshot.links, plan.links),
      pick(snapshot.notes, plan.notes),
    ]),
  );
}
