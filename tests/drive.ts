import { readFileSync } from 'node:fs';

import type { FetchedResponse, HostCapabilities, HostFetchInit } from '@tyto/plugin-api';
import { testPlugin, type PluginHarness, type TestRecipeOptions } from '@tyto/plugin-api/testing';

import { PERSON_TOKEN, response } from './host.js';
import { withoutSigninPort } from './sheets.js';

/**
 * A synthetic Drive for `google.drive-list` and `google.drive-read`, answered through the
 * contract's own harness over the committed `dist/index.js`. Ids, names and contents are
 * invented; nothing here is a real file or person.
 */
const manifest = readFileSync(new URL('../tyto-plugin.json', import.meta.url), 'utf8');
const entry = new URL('../dist/index.js', import.meta.url).href;

export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const SPREADSHEET_MIME = 'application/vnd.google-apps.spreadsheet';
/** The Google types `files.create` makes with no content; any other `google-apps` type is 400. */
const CREATABLE_NATIVE = [FOLDER_MIME, SPREADSHEET_MIME];
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
  /** Drive's `imageMediaMetadata`, which it answers only for a file it reads as an image. */
  image?: { width: number; height: number };
  trashed?: boolean;
  /** The people the item is shared with, as `permissions.create` added them. */
  permissions?: { email: string; role: string; notified: boolean }[];
  /** `permissions.list` answers 403, as Drive does to a person who may not see the sharing. */
  permissionsHidden?: boolean;
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
  /** Resumable upload sessions, by their `upload_id`. */
  sessions?: Map<string, FakeSession>;
  /** How many of the next chunks Drive loses, answering 503 after keeping half of each. */
  lostChunks?: number;
}

/** A resumable upload as Drive holds it: what it is for, and the bytes it has, summed. */
export interface FakeSession {
  readonly name: string;
  readonly parents: string[];
  readonly modifiedTime: string;
  /** The file whose content it replaces; absent for a new file. */
  readonly replaces?: string;
  readonly total: number;
  received: number;
  /** A sum of every byte with its offset, so bytes sent out of place show. */
  checksum: number;
  done?: string;
}

/** The sum {@link FakeSession.checksum} keeps, for a test to compare with its own bytes. */
export function checksumOf(bytes: Uint8Array, offset: number, sum = 0): number {
  let total = sum;
  for (let index = 0; index < bytes.length; index += 1) {
    total = (total + bytes[index]! * ((offset + index) % 251)) % 1_000_000_007;
  }
  return total;
}

export interface DriveCall {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  /** The request's `Authorization` header: whose token signed it. */
  readonly authorization: string;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
  /** A raw body (an upload's chunk), kept as it was sent. */
  readonly bytes?: Uint8Array;
}

export interface FakeGoogleDrive {
  readonly plugin: PluginHarness;
  readonly calls: DriveCall[];
  readonly drive: FakeDrive;
}

export async function fakeDrive(
  drive: FakeDrive,
  options: {
    readonly section?: unknown;
    /**
     * The people signed in (`{}` for nobody). Left out, a person is, with {@link PERSON_TOKEN}:
     * every verb acts only as a signed-in person (TYTO-701).
     */
    readonly signins?: Readonly<Record<string, string>>;
    /** `false` for a terminal with no system keychain: `E_SIGNIN_UNAVAILABLE`, no verb runs. */
    readonly keychain?: boolean;
    /** Other ports over the harness's: a test's workspace files. */
    readonly capabilities?: Partial<HostCapabilities>;
  } = {},
): Promise<FakeGoogleDrive> {
  const calls: DriveCall[] = [];
  const loaded = await testPlugin({
    manifest,
    load: () => import(entry),
    ...(options.keychain === false
      ? { capabilities: { ...withoutSigninPort(), ...options.capabilities } }
      : {
          signins: options.signins ?? { google: PERSON_TOKEN },
          ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
        }),
    ...(options.section === undefined ? {} : { section: options.section }),
    async fetch(url: string, init: HostFetchInit) {
      return driveAnswer(drive, calls, url, init);
    },
  });
  if (!loaded.ok) {
    throw new Error(loaded.error.map((item) => `${item.code}: ${item.message}`).join('\n'));
  }
  return { plugin: loaded.value, calls, drive };
}

/** The fake's answer to one request, recorded in `calls`. */
export function driveAnswer(
  drive: FakeDrive,
  calls: DriveCall[],
  url: string,
  init: HostFetchInit,
): FetchedResponse {
  const parsed = new URL(url);
  const call: DriveCall = {
    method: init.method ?? 'GET',
    path: decodeURIComponent(parsed.pathname),
    query: Object.fromEntries(parsed.searchParams),
    authorization: String(init.headers?.['Authorization'] ?? ''),
    ...(init.headers === undefined ? {} : { headers: init.headers }),
    ...(init.body instanceof Uint8Array
      ? { bytes: init.body }
      : init.body === undefined
        ? {}
        : { body: JSON.parse(init.body) as unknown }),
  };
  calls.push(call);
  return answerOf(drive, call);
}

const FILES = '/drive/v3/files';
const UPLOADS = '/upload/drive/v3/files';
let sessionCount = 0;

/**
 * Drive's resumable upload: a POST (a new file) or a PATCH (new content for one, whose id
 * stays) opens a session at the `Location` it answers; each PUT sends a chunk, or asks with
 * an empty `Content-Range` total where the session stands. A 308 says how far it got.
 */
function uploaded(drive: FakeDrive, call: DriveCall): FetchedResponse {
  const sessions = (drive.sessions ??= new Map());
  if (call.method !== 'PUT') {
    if (call.query['uploadType'] !== 'resumable') throw new Error('not a resumable upload');
    const body = call.body as { name?: string; parents?: string[]; modifiedTime: string };
    const replaces = call.path.slice(UPLOADS.length + 1);
    const target = drive.items.find((each) => each.id === replaces);
    sessionCount += 1;
    const id = `s${sessionCount}`;
    sessions.set(id, {
      name: body.name ?? target?.name ?? '',
      parents: body.parents ?? target?.parents ?? [],
      modifiedTime: body.modifiedTime,
      ...(replaces === '' ? {} : { replaces }),
      total: Number(call.headers?.['X-Upload-Content-Length']),
      received: 0,
      checksum: 0,
    });
    const location = `https://www.googleapis.com${UPLOADS}?uploadType=resumable&upload_id=${id}`;
    return response(200, '', { location });
  }
  const session = sessions.get(call.query['upload_id'] ?? '');
  if (session === undefined) return response(404, { error: { code: 404, message: 'No session.' } });
  const held = (): FetchedResponse =>
    session.done !== undefined
      ? response(200, { id: session.done })
      : response(
          308,
          '',
          session.received === 0 ? {} : { range: `bytes=0-${session.received - 1}` },
        );
  const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(call.headers?.['Content-Range'] ?? '');
  if (range === null) {
    if (session.received === session.total && session.done === undefined) finish(drive, session);
    return held();
  }
  const start = Number(range[1]);
  const bytes = call.bytes ?? new Uint8Array(0);
  // Strict on purpose: a chunk that does not start where the session stands is refused, so an
  // upload that guesses its offset after a lost chunk, instead of asking, fails here.
  if (start !== session.received || Number(range[2]) - start + 1 !== bytes.length) {
    return response(400, { error: { code: 400, message: 'Content-Range does not match.' } });
  }
  const kept = (drive.lostChunks ?? 0) > 0 ? bytes.subarray(0, bytes.length / 2) : bytes;
  session.checksum = checksumOf(kept, start, session.checksum);
  session.received += kept.length;
  if (kept !== bytes) {
    drive.lostChunks = (drive.lostChunks ?? 1) - 1;
    return response(503, { error: { code: 503, message: 'Backend Error' } });
  }
  if (session.received === session.total) finish(drive, session);
  return held();
}

function finish(drive: FakeDrive, session: FakeSession): void {
  const existing = drive.items.find((each) => each.id === session.replaces);
  if (existing !== undefined) {
    existing.size = session.total;
    existing.modifiedTime = session.modifiedTime;
    session.done = existing.id;
    return;
  }
  generated += 1;
  const id = `up${String(generated).padStart(12, '0')}`;
  drive.items.push({
    id,
    name: session.name,
    mimeType: 'application/octet-stream',
    parents: [...session.parents],
    size: session.total,
    createdTime: '2026-11-19T09:00:00.000Z',
    modifiedTime: session.modifiedTime,
  });
  session.done = id;
}

type InputTable = NonNullable<TestRecipeOptions['input']>;

let generated = 0;

function answerOf(drive: FakeDrive, call: DriveCall): FetchedResponse {
  if (call.path.startsWith(UPLOADS)) return uploaded(drive, call);
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
  if (sub === 'permissions' && call.method === 'GET') return permissionsOf(drive, item, call);
  if (sub === 'permissions') throw new Error(`the plugin sent ${call.method} to permissions`);
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
  if (
    body.mimeType.startsWith('application/vnd.google-apps.') &&
    !CREATABLE_NATIVE.includes(body.mimeType)
  ) {
    return response(400, {
      error: { code: 400, message: `Invalid MIME type provided for the uploaded content.` },
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
  // A person who already holds a permission gets the new role in its place: the worst case,
  // where sharing again with a weaker role would lower theirs.
  item.permissions = [
    ...(item.permissions ?? []).filter(
      (each) => each.email.toLowerCase() !== body.emailAddress.toLowerCase(),
    ),
    {
      email: body.emailAddress,
      role: body.role,
      notified: call.query['sendNotificationEmail'] === 'true',
    },
  ];
  return response(200, { id: `perm-${item.permissions.length}` });
}

/** `permissions.list`, paged by `pageSize` (or the drive's smaller page), as Drive pages it. */
function permissionsOf(drive: FakeDrive, item: FakeItem, call: DriveCall): FetchedResponse {
  if (item.permissionsHidden === true) {
    return response(403, {
      error: {
        code: 403,
        message: 'The user does not have sufficient permissions for this file.',
        errors: [{ reason: 'insufficientFilePermissions' }],
      },
    });
  }
  const size = Math.min(Number(call.query['pageSize'] ?? 100), drive.pageSize ?? 100);
  const offset = Number((call.query['pageToken'] ?? 'perm-page-0').slice('perm-page-'.length));
  const all = (item.permissions ?? []).map((each) => ({
    emailAddress: each.email,
    role: each.role,
  }));
  const next = offset + size < all.length ? `perm-page-${offset + size}` : undefined;
  return response(200, {
    permissions: all.slice(offset, offset + size),
    ...(next === undefined ? {} : { nextPageToken: next }),
  });
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
    // Drive answers only the fields asked for: dimensions only when the mask names them.
    const sized = (query['fields'] ?? '').includes('imageMediaMetadata(width, height)');
    return paged(
      drive,
      query,
      chosen.map((item) => ({
        id: item.id,
        ...(sized && item.image !== undefined ? { imageMediaMetadata: { ...item.image } } : {}),
      })),
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
    ...(item.image === undefined ? {} : { imageMediaMetadata: { ...item.image } }),
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

/** An input table of text columns, its rows keyed `r1`, `r2`, … */
export function inputTable(
  columns: readonly string[],
  rows: readonly (readonly (string | null)[])[],
): InputTable {
  return {
    columns: columns.map((name) => ({ name, type: 'text', origin: 'test' })),
    rows: rows.map((cells, index) => ({
      key: `r${index + 1}`,
      values: Object.fromEntries(columns.map((name, at) => [name, cells[at] ?? null])),
      provenance: { source: 'test', id: `r${index + 1}`, fetchedAt: '2026-11-11T00:00:00.000Z' },
    })),
  };
}

/** What an action step planned over a table: its plan, or its diagnostics. */
export async function planOver(drive: FakeGoogleDrive, step: string, input: InputTable) {
  const ran = await drive.plugin.runRecipe(step, { input });
  if (!ran.ok) throw new Error(ran.error.map((item) => item.message).join('\n'));
  const cell = ran.value.cells.at(-1);
  return {
    plan: cell?.plan,
    diagnostics: (cell?.diagnostics ?? []).map(({ code, message }) => ({ code, message })),
  };
}

export type Planned = NonNullable<Awaited<ReturnType<typeof planOver>>['plan']>;

/** A plan applied as the notebook's Apply does: each operation's status and reason. */
export async function applyWith(drive: FakeGoogleDrive, verbId: string, planned: Planned) {
  const verb = drive.plugin.recipes.verbs.get(verbId);
  if (verb?.apply === undefined) throw new Error(`${verbId} has no apply`);
  const applied = await verb.apply(planned);
  if (!applied.ok) throw new Error(applied.error.map((item) => item.message).join('\n'));
  return applied.value.operations.map(({ status, reason }) => ({
    status,
    ...(reason === undefined ? {} : { reason }),
  }));
}

/** The calls a run made to `files.list`. */
export function listCalls(google: FakeGoogleDrive): DriveCall[] {
  return google.calls.filter((call) => call.path === FILES);
}
