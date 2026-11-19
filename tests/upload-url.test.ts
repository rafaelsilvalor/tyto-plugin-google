import type { HostCapabilities, WorkspaceEntry } from '@tyto/plugin-api';
import { afterEach, describe, expect, it } from 'vitest';

import { plannedFolderKey } from '../src/planned-folder.js';
import {
  applyWith,
  fakeDrive,
  FOLDER_MIME,
  inputTable,
  type FakeDrive,
  type FakeGoogleDrive,
  type Planned,
} from './drive.js';

/**
 * TYTO-758: `google.drive-upload` plans a new folder's address, and `google.drive-url` below it
 * answers that address before the upload is applied. Over a synthetic Drive, a synthetic
 * workspace of one delivery folder and a cache port that records who asks it. Every id and name
 * is invented.
 */
const ROOT_ID = 'root0123456789';
const DELIVERIES_ID = 'deliveries01234';
const URL_OF = (id: string): string => `https://drive.google.com/drive/folders/${id}`;
const AT = '2026-11-18T10:00:00.000Z';
const FILE_BYTES = new TextEncoder().encode('a delivery');

/** One cache call as the host's port received it: the plugin it is for, and the key. */
interface CacheCall {
  readonly port: string;
  readonly plugin: string;
  readonly key: string;
}

function ports(cache: Map<string, Uint8Array>, cacheCalls: CacheCall[]): Partial<HostCapabilities> {
  const stat = (path: string): WorkspaceEntry => {
    if (path === 'entregas/D1/peca.png') {
      return { name: 'peca.png', kind: 'file', size: FILE_BYTES.length, modifiedAt: AT };
    }
    if (path === 'entregas/D1') return { name: 'D1', kind: 'folder', size: 0, modifiedAt: AT };
    throw new Error(`ENOENT: '${path}' is not in the workspace`);
  };
  const storedAt = '2026-11-19T00:00:00.000Z';
  return {
    cacheGet: async (plugin, key) => {
      cacheCalls.push({ port: 'get', plugin, key });
      const bytes = cache.get(key);
      return bytes === undefined ? undefined : { bytes, storedAt };
    },
    cachePut: async (plugin, key, bytes) => {
      cacheCalls.push({ port: 'put', plugin, key });
      cache.set(key, bytes);
      return { storedAt };
    },
    cacheDelete: async (plugin, key) => {
      cacheCalls.push({ port: 'delete', plugin, key });
      return cache.delete(key);
    },
    cacheList: async (_plugin, prefix) =>
      [...cache.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, bytes]) => ({ key, storedAt, size: bytes.length })),
    workspaceStat: async (_plugin, path) => stat(path),
    workspaceList: async (_plugin, path) =>
      path === 'entregas/D1' ? [stat('entregas/D1/peca.png')] : [],
    workspaceReadPart: async (_plugin, path, offset, length) =>
      path === 'entregas/D1/peca.png'
        ? FILE_BYTES.slice(offset, offset + length)
        : new Uint8Array(),
  };
}

function studio(): FakeDrive {
  const folder = (id: string, name: string, parents: string[]) => ({
    id,
    name,
    mimeType: FOLDER_MIME,
    parents,
    createdTime: '2026-11-01T09:00:00.000Z',
  });
  return {
    items: [
      folder(ROOT_ID, 'Studio', ['top0123456789x']),
      folder(DELIVERIES_ID, 'Deliveries', [ROOT_ID]),
    ],
    ids: ['newD1folder0001', 'newD1folder0002'],
  };
}

let open: FakeGoogleDrive | undefined;
afterEach(async () => {
  await open?.plugin.close();
  open = undefined;
});

async function harness(
  drive: FakeDrive,
  cache = new Map<string, Uint8Array>(),
  overrides: Partial<HostCapabilities> = {},
) {
  const cacheCalls: CacheCall[] = [];
  open = await fakeDrive(drive, {
    section: { root: ROOT_ID },
    capabilities: { ...ports(cache, cacheCalls), ...overrides },
  });
  return { google: open, cache, cacheCalls };
}

const RECIPE =
  'google.drive-upload from=Path to=Deliveries\ngoogle.drive-url path=Path in=Deliveries';
const INPUT = inputTable(['Path'], [['entregas/D1']]);

async function runBoth(google: FakeGoogleDrive) {
  const ran = await google.plugin.runRecipe(RECIPE, { input: INPUT });
  if (!ran.ok) throw new Error(ran.error.map((item) => item.message).join('\n'));
  const [upload, url] = ran.value.cells;
  return {
    plan: upload?.plan as Planned | undefined,
    creates: (upload?.plan?.operations ?? [])
      .filter((operation) => operation.write === 'create')
      .map((operation) => operation.description),
    url: url?.table?.rows.map((row) => row.values['Path_url']),
    diagnostics: (url?.diagnostics ?? []).map((each) => each.message),
  };
}

const generateCalls = (google: FakeGoogleDrive): number =>
  google.calls.filter((call) => call.path.endsWith('/generateIds')).length;

describe('google.drive-upload with google.drive-url below it', () => {
  it("gives the planned folder's address before the upload applies, through the plugin's cache", async () => {
    const { google, cacheCalls } = await harness(studio());
    const answer = await runBoth(google);
    expect(answer.creates).toEqual([
      `create folder 'D1' in 'Deliveries' (${DELIVERIES_ID}): ${URL_OF('newD1folder0001')}`,
    ]);
    expect(answer.url).toEqual([URL_OF('newD1folder0001')]);
    expect(answer.diagnostics).toEqual([
      "'google.drive-url' gave Path_url for 'D1' as the address the upload above planned: the " +
        'folder will be created by the upload above when its plan is applied.',
    ]);
    // The proof the cache is the plugin's and not a verb's: the upload's put and the lookup's
    // get reach the host's port under one plugin name and one key.
    const key = plannedFolderKey(DELIVERIES_ID, 'D1');
    expect(cacheCalls).toEqual([
      { port: 'get', plugin: 'google', key },
      { port: 'put', plugin: 'google', key },
      { port: 'get', plugin: 'google', key },
    ]);
  });

  it('keeps one address across plans made before the upload applies', async () => {
    const { google } = await harness(studio());
    const first = await runBoth(google);
    const second = await runBoth(google);
    expect(second.creates).toEqual(first.creates);
    expect(second.url).toEqual([URL_OF('newD1folder0001')]);
    expect(generateCalls(google)).toBe(1);
  });

  it('plans a new id when something already holds the kept one', async () => {
    const drive = studio();
    const cache = new Map([
      [plannedFolderKey(DELIVERIES_ID, 'D1'), new TextEncoder().encode('trashedD1fold01')],
    ]);
    drive.items.push({
      id: 'trashedD1fold01',
      name: 'D1',
      mimeType: FOLDER_MIME,
      parents: [DELIVERIES_ID],
      createdTime: '2026-11-02T09:00:00.000Z',
      trashed: true,
    });
    const { google } = await harness(drive, cache);
    const answer = await runBoth(google);
    expect(answer.url).toEqual([URL_OF('newD1folder0001')]);
    expect(new TextDecoder().decode(cache.get(plannedFolderKey(DELIVERIES_ID, 'D1')))).toBe(
      'newD1folder0001',
    );
  });

  it('forgets the kept id once the upload creates the folder, and the real folder answers', async () => {
    const { google, cache } = await harness(studio());
    const planned = await runBoth(google);
    expect(cache.size).toBe(1);
    expect(await applyWith(google, 'google.drive-upload', planned.plan!)).toEqual([
      { status: 'applied' },
      { status: 'applied' },
    ]);
    expect(cache.size).toBe(0);
    const after = await runBoth(google);
    expect(after.creates).toEqual([]);
    expect(after.url).toEqual([URL_OF('newD1folder0001')]);
    expect(after.diagnostics).toEqual([]);
  });

  it('gives a folder that already exists its real address, with no warning', async () => {
    const drive = studio();
    drive.items.push({
      id: 'existingD1fold1',
      name: 'D1',
      mimeType: FOLDER_MIME,
      parents: [DELIVERIES_ID],
      createdTime: '2026-11-02T09:00:00.000Z',
    });
    const { google, cache } = await harness(drive);
    const answer = await runBoth(google);
    expect(answer.creates).toEqual([]);
    expect(answer.url).toEqual([URL_OF('existingD1fold1')]);
    expect(answer.diagnostics).toEqual([]);
    expect(cache.size).toBe(0);
  });

  it('still plans with a cache that refuses, and the link stays empty', async () => {
    const refuse = async (): Promise<never> => {
      throw new Error('no cache here');
    };
    const { google } = await harness(studio(), new Map(), {
      cacheGet: refuse,
      cachePut: refuse,
      cacheDelete: refuse,
    });
    const answer = await runBoth(google);
    expect(answer.creates).toHaveLength(1);
    expect(answer.url).toEqual([null]);
  });
});
