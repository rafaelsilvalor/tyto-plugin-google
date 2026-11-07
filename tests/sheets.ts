import { readFileSync } from 'node:fs';

import type { FetchedResponse, HostCapabilities, HostFetchInit } from '@tyto/plugin-api';
import { testPlugin, type PluginHarness } from '@tyto/plugin-api/testing';

import { response } from './host.js';
import { testClock, testKey, tokenEndpoint, type TestKey } from './google.js';

/**
 * A synthetic spreadsheet for `google.sheet-rows`, answered through the contract's own
 * harness: the committed `dist/index.js`, activated over the isolation protocol, with the
 * manifest's permissions in front of every request. Nothing here is a real file or person.
 */
const manifest = readFileSync(new URL('../tyto-plugin.json', import.meta.url), 'utf8');
const entry = new URL('../dist/index.js', import.meta.url).href;

export const SPREADSHEET_ID = 'sheet0123456789abcdef';
export const SPREADSHEET_URL = `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit`;

/** Where a cell's link lives, as Sheets answers it. */
export type LinkPlace = 'hyperlink' | 'run' | 'format';

export interface FakeTab {
  readonly sheetId: number;
  title: string;
  values: unknown[][];
  /** By A1 cell, such as `B2`. */
  links?: Record<string, { readonly uri: string; readonly place?: LinkPlace }>;
  notes?: Record<string, string>;
}

export interface FakeSpreadsheet {
  tabs: FakeTab[];
  /** Drive's `version`; a string, as Drive answers it. */
  version: string;
  /** Drive's answer to the version, when a test wants it to fail. */
  driveFailure?: FetchedResponse;
}

export interface SheetCall {
  readonly method: string;
  readonly host: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string | string[]>>;
}

export interface FakeGoogle {
  readonly plugin: PluginHarness;
  readonly calls: SheetCall[];
  readonly sheet: FakeSpreadsheet;
}

let key: TestKey | undefined;

export async function fakeGoogle(
  sheet: FakeSpreadsheet,
  options: {
    readonly section?: unknown;
    readonly capabilities?: Partial<HostCapabilities>;
  } = {},
): Promise<FakeGoogle> {
  key ??= await testKey();
  const endpoint = tokenEndpoint(key.publicKey, testClock(Date.now()));
  const calls: SheetCall[] = [];
  const loaded = await testPlugin({
    manifest,
    load: () => import(entry),
    secrets: { 'service-account': key.json },
    ...(options.section === undefined ? {} : { section: options.section }),
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    async fetch(url: string, init: HostFetchInit) {
      const parsed = new URL(url);
      if (parsed.host === 'oauth2.googleapis.com') {
        const answer = await endpoint.answer(init);
        return response(answer.status, await answer.text());
      }
      const query: Record<string, string | string[]> = {};
      for (const name of new Set(parsed.searchParams.keys())) {
        const all = parsed.searchParams.getAll(name);
        query[name] = all.length === 1 ? (all[0] ?? '') : all;
      }
      const call: SheetCall = {
        method: init.method ?? 'GET',
        host: parsed.host,
        path: decodeURIComponent(parsed.pathname),
        query,
      };
      calls.push(call);
      return answerOf(sheet, call);
    },
  });
  if (!loaded.ok) {
    throw new Error(loaded.error.map((item) => `${item.code}: ${item.message}`).join('\n'));
  }
  return { plugin: loaded.value, calls, sheet };
}

function answerOf(sheet: FakeSpreadsheet, call: SheetCall): FetchedResponse {
  if (call.host === 'www.googleapis.com' && call.path === `/drive/v3/files/${SPREADSHEET_ID}`) {
    return sheet.driveFailure ?? response(200, { version: sheet.version });
  }
  const base = `/v4/spreadsheets/${SPREADSHEET_ID}`;
  if (call.host !== 'sheets.googleapis.com') throw new Error(`no fake answers ${call.path}`);
  if (call.path === base && call.query['fields'] === 'sheets.properties(sheetId,title)') {
    return response(200, {
      sheets: sheet.tabs.map((tab) => ({ properties: { sheetId: tab.sheetId, title: tab.title } })),
    });
  }
  if (call.path.startsWith(`${base}/values/`)) {
    const tab = tabOf(sheet, call.path.slice(`${base}/values/`.length));
    return response(200, { range: tab.title, majorDimension: 'ROWS', values: tab.values });
  }
  if (call.path === base && call.query['ranges'] !== undefined) {
    return response(200, extrasOf(sheet, call));
  }
  throw new Error(`no fake answers ${call.method} ${call.path}`);
}

function tabOf(sheet: FakeSpreadsheet, quoted: string): FakeTab {
  const title = quoted.replace(/^'|'$/g, '').replace(/''/g, "'");
  const tab = sheet.tabs.find((each) => each.title === title);
  if (tab === undefined) throw new Error(`no tab ${quoted}`);
  return tab;
}

/** `spreadsheets.get` with ranges, answering only the fields the mask names, as Google does. */
function extrasOf(sheet: FakeSpreadsheet, call: SheetCall): unknown {
  const fields = String(call.query['fields']);
  const ranges = ([] as string[]).concat(call.query['ranges'] ?? []);
  const data = ranges.map((range) => {
    const match = /^(.*)!([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(range);
    if (match === null) throw new Error(`a range the fake does not read: ${range}`);
    const [, quoted = '', letter = 'A', from = '2', , to = '2'] = match;
    const tab = tabOf(sheet, quoted);
    const column = letter.charCodeAt(0) - 65;
    const rowData = [];
    for (let row = Number(from); row <= Number(to); row += 1) {
      const cell: Record<string, unknown> = {};
      const link = tab.links?.[`${letter}${row}`];
      const place = link?.place ?? 'hyperlink';
      if (link !== undefined && place === 'hyperlink' && fields.includes('hyperlink')) {
        cell['hyperlink'] = link.uri;
      }
      if (link !== undefined && place === 'run' && fields.includes('textFormatRuns')) {
        cell['textFormatRuns'] = [
          { format: {} },
          { startIndex: 2, format: { link: { uri: link.uri } } },
        ];
      }
      if (link !== undefined && place === 'format' && fields.includes('effectiveFormat')) {
        cell['effectiveFormat'] = { textFormat: { link: { uri: link.uri } } };
      }
      const note = tab.notes?.[`${letter}${row}`];
      if (note !== undefined && fields.includes('note')) cell['note'] = note;
      rowData.push(Object.keys(cell).length === 0 ? {} : { values: [cell] });
    }
    return { startRow: Number(from) - 1, startColumn: column, rowData };
  });
  return { sheets: [{ data }] };
}

/** What a one-step recipe answered: its table, or its diagnostics. */
export async function rows(google: FakeGoogle, step: string) {
  const run = await google.plugin.runRecipe(step);
  if (!run.ok) throw new Error(run.error.map((item) => item.message).join('\n'));
  const cell = run.value.cells[0];
  return {
    table: cell?.table,
    diagnostics: (cell?.diagnostics ?? []).map(({ code, message }) => ({ code, message })),
  };
}

/** `google.sheet-rows`'s `page`, called as the host's loop calls it. */
export function pageOf(google: FakeGoogle) {
  const verb = google.plugin.host.registry
    .recipeVerbs()
    .find((each) => each.id === 'google.sheet-rows');
  if (verb?.page === undefined) throw new Error('google.sheet-rows is not registered');
  return verb.page;
}

/** A host cache in memory. */
export interface MemoryCache {
  readonly capabilities: Partial<HostCapabilities>;
  readonly entries: Map<string, { bytes: Uint8Array; storedAt: string }>;
  entry(key: string): Record<string, unknown>;
}

export function memoryCache(): MemoryCache {
  const entries = new Map<string, { bytes: Uint8Array; storedAt: string }>();
  const now = () => new Date().toISOString();
  return {
    entries,
    capabilities: {
      cacheGet: async (_plugin, key) => entries.get(key),
      async cachePut(_plugin, key, bytes) {
        const storedAt = now();
        entries.set(key, { bytes, storedAt });
        return { storedAt };
      },
      cacheDelete: async (_plugin, key) => entries.delete(key),
      cacheList: async (_plugin, prefix) =>
        [...entries]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, { bytes, storedAt }]) => ({ key, storedAt, size: bytes.byteLength })),
    },
    entry(key) {
      const stored = entries.get(key);
      if (stored === undefined) throw new Error(`no cache entry ${key}`);
      return JSON.parse(new TextDecoder().decode(stored.bytes)) as Record<string, unknown>;
    },
  };
}

/** A small tab: a header and three people, every type of cell Sheets answers. */
export function peopleTab(): FakeTab {
  return {
    sheetId: 0,
    title: 'People',
    values: [
      ['Name', 'Age', 'Active', 'Joined', 'Code', 'Profile'],
      ['Ana', 31, true, '01/03/2026', 'A1', 'profile'],
      ['Bruno', 27, false, '15/04/2026', 7, 'profile'],
      ['Clara', '', true, '', 'C3', 'none'],
    ],
  };
}

/** The calls a run made to one kind of endpoint. */
export function callsTo(google: FakeGoogle, kind: 'tabs' | 'values' | 'extras' | 'version') {
  return google.calls.filter((call) => {
    if (kind === 'version') return call.host === 'www.googleapis.com';
    if (kind === 'values') return call.path.includes('/values/');
    if (call.host !== 'sheets.googleapis.com' || call.path.includes('/values/')) return false;
    return kind === 'extras'
      ? call.query['ranges'] !== undefined
      : call.query['ranges'] === undefined;
  });
}
