import { readFileSync } from 'node:fs';

import type { FetchedResponse, HostFetchInit } from '@tyto/plugin-api';
import { testPlugin, type PluginHarness } from '@tyto/plugin-api/testing';

import { response } from './host.js';
import { testClock, testKey, tokenEndpoint, type TestKey } from './google.js';

/**
 * A synthetic Drive for `google.drive-list` and `google.drive-read`, answered through the
 * contract's own harness over the committed `dist/index.js`. Ids, names and contents are
 * invented; nothing here is a real file or person.
 */
const manifest = readFileSync(new URL('../tyto-plugin.json', import.meta.url), 'utf8');
const entry = new URL('../dist/index.js', import.meta.url).href;

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const INBOX_ID = 'inbox0123456789';
export const INBOX_URL = `https://drive.google.com/drive/folders/${INBOX_ID}`;

export interface FakeItem {
  readonly id: string;
  name: string;
  readonly mimeType: string;
  parents: string[];
  /** The bytes `alt=media` answers, as text. */
  content?: string;
  /** Drive's `size`, when it differs from the content's length (or there is no content). */
  size?: number;
  createdTime: string;
  modifiedTime?: string;
  trashed?: boolean;
  /** The people the item is shared with, as `permissions.create` added them. */
  permissions?: { email: string; role: string; notified: boolean }[];
}

export interface FakeDrive {
  items: FakeItem[];
  /** Drive's page size, smaller than the asked 1,000 when a test wants several pages. */
  pageSize?: number;
  /** The ids `files.generateIds` hands out next, in order; invented ones when it runs out. */
  ids?: string[];
  /** Emails whose domain Drive refuses to share with, as a domain's sharing settings do. */
  refusedDomain?: string;
  /** Item names whose create Drive refuses, with a body echoing the request's token. */
  refusedNames?: string[];
}

export interface DriveCall {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  /** The request's `Authorization` header: whose token signed it. */
  readonly authorization: string;
  readonly body?: unknown;
}

export interface FakeGoogleDrive {
  readonly plugin: PluginHarness;
  readonly calls: DriveCall[];
  readonly drive: FakeDrive;
}

let key: TestKey | undefined;

export async function fakeDrive(
  drive: FakeDrive,
  options: {
    readonly section?: unknown;
    readonly signins?: Readonly<Record<string, string>>;
  } = {},
): Promise<FakeGoogleDrive> {
  key ??= await testKey();
  const endpoint = tokenEndpoint(key.publicKey, testClock(Date.now()));
  const calls: DriveCall[] = [];
  const loaded = await testPlugin({
    manifest,
    load: () => import(entry),
    secrets: { 'service-account': key.json },
    ...(options.signins === undefined ? {} : { signins: options.signins }),
    ...(options.section === undefined ? {} : { section: options.section }),
    async fetch(url: string, init: HostFetchInit) {
      const parsed = new URL(url);
      if (parsed.host === 'oauth2.googleapis.com') {
        const answer = await endpoint.answer(init);
        return response(answer.status, await answer.text());
      }
      const call: DriveCall = {
        method: init.method ?? 'GET',
        path: decodeURIComponent(parsed.pathname),
        query: Object.fromEntries(parsed.searchParams),
        authorization: String(init.headers?.['Authorization'] ?? ''),
        ...(init.body === undefined ? {} : { body: JSON.parse(String(init.body)) as unknown }),
      };
      calls.push(call);
      return answerOf(drive, call);
    },
  });
  if (!loaded.ok) {
    throw new Error(loaded.error.map((item) => `${item.code}: ${item.message}`).join('\n'));
  }
  return { plugin: loaded.value, calls, drive };
}

const FILES = '/drive/v3/files';

let generated = 0;

function answerOf(drive: FakeDrive, call: DriveCall): FetchedResponse {
  if (call.path === FILES && call.method === 'POST') return created(drive, call);
  if (call.path === FILES) return listOf(drive, call.query);
  if (call.path === `${FILES}/generateIds`) {
    const count = Number(call.query['count']);
    const ids = Array.from({ length: count }, () => {
      generated += 1;
      return drive.ids?.shift() ?? `gen${String(generated).padStart(12, '0')}`;
    });
    return response(200, { kind: 'drive#generatedIds', space: 'drive', ids });
  }
  if (!call.path.startsWith(`${FILES}/`)) throw new Error(`no fake answers ${call.path}`);
  const [id, sub] = call.path.slice(FILES.length + 1).split('/');
  const item = drive.items.find((each) => each.id === id);
  if (item === undefined) {
    return response(404, { error: { code: 404, message: 'File not found.', status: 'NOT_FOUND' } });
  }
  if (sub === 'permissions' && call.method === 'POST') return shared(drive, item, call);
  if (call.method === 'PATCH') {
    // Drive's files.update: the folders to add and remove, comma-separated, as Drive reads them.
    const removed = (call.query['removeParents'] ?? '').split(',').filter((id) => id !== '');
    const added = (call.query['addParents'] ?? '').split(',').filter((id) => id !== '');
    item.parents = [...item.parents.filter((id) => !removed.includes(id)), ...added];
    return response(200, { id: item.id, parents: item.parents });
  }
  if (call.query['alt'] === 'media') {
    if (item.content === undefined) {
      return response(403, {
        error: {
          code: 403,
          message: 'Only files with binary content can be downloaded.',
          errors: [{ reason: 'fileNotDownloadable' }],
        },
      });
    }
    return response(200, item.content);
  }
  return response(200, described(item));
}

/** `files.create` with a generated id: a second create of one id is Drive's 409. */
function created(drive: FakeDrive, call: DriveCall): FetchedResponse {
  const body = call.body as { id: string; name: string; mimeType: string; parents: string[] };
  if (drive.refusedNames?.includes(body.name)) {
    return response(403, {
      error: {
        code: 403,
        message: `The user does not have sufficient permissions (${call.authorization}).`,
        errors: [{ reason: 'insufficientFilePermissions' }],
      },
    });
  }
  if (drive.items.some((each) => each.id === body.id)) {
    return response(409, {
      error: { code: 409, message: 'A file already exists with the provided ID.' },
    });
  }
  drive.items.push({
    id: body.id,
    name: body.name,
    mimeType: body.mimeType,
    parents: [...body.parents],
    createdTime: '2026-11-11T09:00:00.000Z',
  });
  return response(200, { id: body.id });
}

/** `permissions.create` for a user; a refused domain answers as a domain's settings do. */
function shared(drive: FakeDrive, item: FakeItem, call: DriveCall): FetchedResponse {
  const body = call.body as { type: string; role: string; emailAddress: string };
  if (drive.refusedDomain !== undefined && body.emailAddress.endsWith(`@${drive.refusedDomain}`)) {
    return response(400, {
      error: {
        code: 400,
        message: 'Bad Request. User message: "ACL change not allowed."',
        errors: [{ reason: 'invalidSharingRequest' }],
      },
    });
  }
  item.permissions = [
    ...(item.permissions ?? []),
    {
      email: body.emailAddress,
      role: body.role,
      notified: call.query['sendNotificationEmail'] === 'true',
    },
  ];
  return response(200, { id: `perm-${item.permissions.length}` });
}

/** `files.list`, reading the one query shape the plugin writes, as Drive pages it. */
function listOf(drive: FakeDrive, query: Readonly<Record<string, string>>): FetchedResponse {
  const q = query['q'] ?? '';
  const typed =
    /^name = '((?:[^'\\]|\\.)*)' and '((?:[^'\\]|\\.)*)' in parents and mimeType = '((?:[^'\\]|\\.)*)' and trashed = false$/.exec(
      q,
    );
  if (typed !== null) {
    const [name, parent, mime] = [unescaped(typed[1]), unescaped(typed[2]), unescaped(typed[3])];
    const files = drive.items
      .filter(
        (item) =>
          item.parents.includes(parent) &&
          item.name === name &&
          item.mimeType === mime &&
          item.trashed !== true,
      )
      .map(described);
    return response(200, { files });
  }
  const named =
    /^'((?:[^'\\]|\\.)*)' in parents and name = '((?:[^'\\]|\\.)*)' and trashed = false$/.exec(q);
  if (named !== null) {
    const [parent, name] = [unescaped(named[1]), unescaped(named[2])];
    const files = drive.items
      .filter(
        (item) => item.parents.includes(parent) && item.name === name && item.trashed !== true,
      )
      .map(described);
    return response(200, { files });
  }
  const images =
    /^'((?:[^'\\]|\\.)*)' in parents and trashed = false and \(mimeType = 'image\/png' or mimeType = 'image\/jpeg'\)$/.exec(
      q,
    );
  if (images !== null) {
    const parent = unescaped(images[1]);
    const chosen = drive.items.filter(
      (item) =>
        item.parents.includes(parent) &&
        item.trashed !== true &&
        (item.mimeType === 'image/png' || item.mimeType === 'image/jpeg'),
    );
    return paged(
      drive,
      query,
      chosen.map((item) => ({ id: item.id })),
    );
  }
  const match =
    /^'((?:[^'\\]|\\.)*)' in parents and trashed = false(?: and mimeType (=|!=|contains) '([^']*)')?$/.exec(
      q,
    );
  if (match === null) throw new Error(`a query the fake does not read: ${q}`);
  const parent = unescaped(match[1]);
  const [operator, mime = ''] = [match[2], match[3]];
  const chosen = drive.items
    .filter((item) => item.parents.includes(parent) && item.trashed !== true)
    .filter((item) => {
      if (operator === '=') return item.mimeType === mime;
      if (operator === '!=') return item.mimeType !== mime;
      if (operator === 'contains') return item.mimeType.includes(mime);
      return true;
    })
    .sort((a, b) => a.createdTime.localeCompare(b.createdTime) || a.name.localeCompare(b.name));
  return paged(drive, query, chosen.map(described));
}

/** One page of a listing, as Drive pages it: `pageSize` items and a token for the next. */
function paged(
  drive: FakeDrive,
  query: Readonly<Record<string, string>>,
  all: readonly Record<string, unknown>[],
): FetchedResponse {
  const size = Math.min(Number(query['pageSize'] ?? 100), drive.pageSize ?? 1000);
  const offset = Number((query['pageToken'] ?? 'page-0').slice('page-'.length));
  const files = all.slice(offset, offset + size);
  const next = offset + size < all.length ? `page-${offset + size}` : undefined;
  return response(200, { files, ...(next === undefined ? {} : { nextPageToken: next }) });
}

function unescaped(text: string | undefined): string {
  return (text ?? '').replace(/\\(.)/g, '$1');
}

function described(item: FakeItem): Record<string, unknown> {
  const size = item.size ?? (item.content === undefined ? undefined : byteLength(item.content));
  return {
    id: item.id,
    name: item.name,
    mimeType: item.mimeType,
    ...(size === undefined ? {} : { size: String(size) }),
    createdTime: item.createdTime,
    modifiedTime: item.modifiedTime ?? item.createdTime,
    webViewLink: `https://drive.google.com/file/d/${item.id}/view`,
    parents: item.parents,
  };
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).byteLength;
}

/** A file of the inbox, created on the given day of November 2026. */
export function inboxFile(
  id: string,
  name: string,
  day: number,
  content?: string,
  mimeType = 'application/json',
): FakeItem {
  return {
    id,
    name,
    mimeType,
    parents: [INBOX_ID],
    createdTime: `2026-11-${String(day).padStart(2, '0')}T09:00:00.000Z`,
    ...(content === undefined ? {} : { content }),
  };
}

/** What a one-step recipe answered: its table, or its diagnostics. */
export async function run(google: FakeGoogleDrive, step: string) {
  const ran = await google.plugin.runRecipe(step);
  if (!ran.ok) throw new Error(ran.error.map((item) => item.message).join('\n'));
  const cell = ran.value.cells[0];
  return {
    table: cell?.table,
    diagnostics: (cell?.diagnostics ?? []).map(({ code, message }) => ({ code, message })),
  };
}

/** The calls a run made to `files.list`. */
export function listCalls(google: FakeGoogleDrive): DriveCall[] {
  return google.calls.filter((call) => call.path === FILES);
}
