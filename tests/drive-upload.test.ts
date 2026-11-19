import type { FetchedResponse, HostCapabilities, WorkspaceEntry } from '@tyto/plugin-api';
import type { TestRecipeOptions } from '@tyto/plugin-api/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { applyDriveUploads } from '../src/drive-upload-apply.js';
import { sessionKey, type UploadHost } from '../src/drive-upload.js';
import {
  checksumOf,
  driveAnswer,
  fakeDrive,
  FOLDER_MIME,
  type DriveCall,
  type FakeDrive,
  type FakeGoogleDrive,
} from './drive.js';
import { testClock } from './google.js';

/**
 * `google.drive-upload` over a synthetic Drive and a synthetic workspace: planned by
 * `runRecipe`, applied as the notebook's Apply does. The workspace's bytes are made from each
 * file's seed, so a 100 MB file costs no 100 MB of test data. Every id and name is invented.
 */
type InputTable = NonNullable<TestRecipeOptions['input']>;

const ROOT_ID = 'root0123456789';
const DELIVERIES_ID = 'deliveries01234';
const MB = 1_000_000;

interface LocalFile {
  size: number;
  modifiedAt: string;
  seed: number;
}

/** The byte at `offset` of a file made from `seed`. */
const byteAt = (seed: number, offset: number): number => (offset * 7 + seed) & 255;

function bytesOf(file: LocalFile, offset: number, length: number): Uint8Array {
  const end = Math.min(file.size, offset + length);
  const bytes = new Uint8Array(Math.max(0, end - offset));
  for (let index = 0; index < bytes.length; index += 1)
    bytes[index] = byteAt(file.seed, offset + index);
  return bytes;
}

/** What Drive's checksum of the whole file must be, read in parts as the plugin reads it. */
function checksumOfFile(file: LocalFile): number {
  let sum = 0;
  for (let offset = 0; offset < file.size; offset += 8 * 1024 * 1024) {
    sum = checksumOf(bytesOf(file, offset, 8 * 1024 * 1024), offset, sum);
  }
  return sum;
}

/** The workspace ports over files by path; a folder is any path a file sits under. */
function workspace(
  files: Map<string, LocalFile>,
  cache = new Map<string, Uint8Array>(),
): Partial<HostCapabilities> {
  const stat = (path: string): WorkspaceEntry => {
    const name = path.split('/').at(-1) ?? '';
    const file = files.get(path);
    if (file !== undefined) {
      return { name, kind: 'file', size: file.size, modifiedAt: file.modifiedAt };
    }
    if ([...files.keys()].some((each) => each.startsWith(`${path}/`))) {
      return { name, kind: 'folder', size: 0, modifiedAt: '2026-11-18T09:00:00.000Z' };
    }
    throw new Error(`ENOENT: '${path}' is not in the workspace`);
  };
  const storedAt = '2026-11-19T00:00:00.000Z';
  return {
    cacheGet: async (_plugin, key) => {
      const bytes = cache.get(key);
      return bytes === undefined ? undefined : { bytes, storedAt };
    },
    cachePut: async (_plugin, key, bytes) => {
      cache.set(key, bytes);
      return { storedAt };
    },
    cacheDelete: async (_plugin, key) => cache.delete(key),
    cacheList: async (_plugin, prefix) =>
      [...cache.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, bytes]) => ({ key, storedAt, size: bytes.length })),
    workspaceStat: async (_plugin, path) => stat(path),
    workspaceList: async (_plugin, path) => {
      const names = new Set<string>();
      for (const each of files.keys()) {
        if (each.startsWith(`${path}/`)) names.add(each.slice(path.length + 1).split('/')[0]!);
      }
      return [...names].sort().map((name) => stat(`${path}/${name}`));
    },
    workspaceReadPart: async (_plugin, path, offset, length) => {
      const file = files.get(path);
      if (file === undefined) throw new Error(`ENOENT: '${path}'`);
      return bytesOf(file, offset, length);
    },
  };
}

/** A delivery: a 100 MB editable and four PNGs in its `exports` folder. */
function delivery(): Map<string, LocalFile> {
  const at = '2026-11-18T10:00:00.000Z';
  return new Map([
    ['entregas/D1/capa.psb', { size: 100 * MB, modifiedAt: at, seed: 1 }],
    ...[1, 2, 3, 4].map((n): [string, LocalFile] => [
      `entregas/D1/exports/peca-${n}.png`,
      { size: 300_000 + n, modifiedAt: at, seed: 10 + n },
    ]),
  ]);
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
  };
}

const input = (...paths: string[]): InputTable => ({
  columns: [{ name: 'path', type: 'text', origin: 'test' }],
  rows: paths.map((path, index) => ({
    key: `r${index + 1}`,
    values: { path },
    provenance: { source: 'test', id: `r${index + 1}`, fetchedAt: '2026-11-18T00:00:00.000Z' },
  })),
});

let open: FakeGoogleDrive | undefined;
afterEach(async () => {
  await open?.plugin.close();
  open = undefined;
});

async function google(drive: FakeDrive, files: Map<string, LocalFile>): Promise<FakeGoogleDrive> {
  await open?.plugin.close();
  open = await fakeDrive(drive, { section: { root: ROOT_ID }, capabilities: workspace(files) });
  return open;
}

async function plan(drive: FakeGoogleDrive, step: string, table: InputTable) {
  const ran = await drive.plugin.runRecipe(step, { input: table });
  if (!ran.ok) throw new Error(ran.error.map((item) => item.message).join('\n'));
  const cell = ran.value.cells.at(-1);
  return {
    plan: cell?.plan,
    diagnostics: (cell?.diagnostics ?? []).map(({ code, message }) => ({ code, message })),
  };
}

async function apply(drive: FakeGoogleDrive, planned: unknown) {
  const verb = drive.plugin.recipes.verbs.get('google.drive-upload');
  if (verb?.apply === undefined) throw new Error('google.drive-upload has no apply');
  const applied = await verb.apply(planned as Parameters<typeof verb.apply>[0]);
  if (!applied.ok) throw new Error(applied.error.map((item) => item.message).join('\n'));
  return applied.value.operations.map(({ status, reason }) => ({
    status,
    ...(reason === undefined ? {} : { reason }),
  }));
}

const STEP = 'google.drive-upload from=path to=Deliveries';
const named = (drive: FakeGoogleDrive, name: string) =>
  drive.drive.items.find((item) => item.name === name);
const puts = (drive: FakeGoogleDrive): DriveCall[] =>
  drive.calls.filter(
    (call) => call.method === 'PUT' && call.bytes !== undefined && call.bytes.length > 0,
  );

describe('google.drive-upload', () => {
  it('uploads a delivery folder, plans nothing on a second run, and replaces a changed PNG in place', async () => {
    const files = delivery();
    const drive = await google(studio(), files);
    const first = await plan(drive, STEP, input('entregas/D1'));
    expect(first.diagnostics).toEqual([]);
    expect(first.plan?.operations.map((each) => each.write)).toEqual([
      'create',
      'upload',
      'create',
      'upload',
      'upload',
      'upload',
      'upload',
    ]);
    expect(first.plan?.operations.map((each) => each.description).slice(0, 4)).toEqual([
      expect.stringMatching(/^create folder 'D1' in 'Deliveries' \(deliveries01234\): https:/),
      expect.stringMatching(/^upload 'entregas\/D1\/capa\.psb' \(100\.0 MB\) into 'D1' \(gen/),
      expect.stringMatching(/^create folder 'exports' in 'D1'/),
      expect.stringMatching(/^upload 'entregas\/D1\/exports\/peca-1\.png' \(300 KB\) into/),
    ]);

    expect(await apply(drive, first.plan)).toEqual(Array(7).fill({ status: 'applied' }));
    expect(named(drive, 'capa.psb')).toMatchObject({
      size: 100 * MB,
      modifiedTime: '2026-11-18T10:00:00.000Z',
    });
    expect(named(drive, 'peca-3.png')?.parents).toEqual([named(drive, 'exports')?.id]);
    // 100 MB in 8 MiB chunks (32 x 256 KiB): eleven whole ones, then the rest.
    const chunks = puts(drive).filter((call) =>
      call.headers?.['Content-Range']?.endsWith(`/${100 * MB}`),
    );
    expect(chunks.map((call) => call.bytes?.length)).toEqual([
      ...Array(11).fill(8_388_608),
      7_725_312,
    ]);
    const sessions = [...(drive.drive.sessions?.values() ?? [])];
    expect(sessions.find((each) => each.name === 'capa.psb')?.checksum).toBe(
      checksumOfFile(files.get('entregas/D1/capa.psb')!),
    );

    // An Apply run twice sends nothing again.
    const sent = puts(drive).length;
    expect(await apply(drive, first.plan)).toEqual(Array(7).fill({ status: 'applied' }));
    expect(puts(drive).length).toBe(sent);

    const second = await plan(drive, STEP, input('entregas/D1'));
    expect(second.plan?.operations).toEqual([]);
    expect(second.diagnostics.map((each) => each.message)).toEqual([
      expect.stringMatching(
        /^'google\.drive-upload' plans nothing for 5 files already in Drive with the same name, size and time/,
      ),
    ]);

    // Same size, new content and time: still a change.
    const id = named(drive, 'peca-2.png')?.id;
    files.set('entregas/D1/exports/peca-2.png', {
      size: 300_002,
      modifiedAt: '2026-11-19T08:00:00.000Z',
      seed: 99,
    });
    const third = await plan(drive, STEP, input('entregas/D1'));
    expect(third.plan?.operations.map((each) => [each.write, each.description])).toEqual([
      [
        'replace',
        `replace 'entregas/D1/exports/peca-2.png' (300 KB, was 300 KB) in 'exports' ` +
          `(${named(drive, 'exports')?.id}), keeping its id ${id}`,
      ],
    ]);
    expect(await apply(drive, third.plan)).toEqual([{ status: 'applied' }]);
    expect(drive.drive.items.filter((item) => item.name === 'peca-2.png')).toEqual([
      expect.objectContaining({ id, modifiedTime: '2026-11-19T08:00:00.000Z' }),
    ]);
    const replaced = [...drive.drive.sessions!.values()].find((each) => each.replaces === id);
    expect(replaced?.checksum).toBe(checksumOfFile(files.get('entregas/D1/exports/peca-2.png')!));
  });

  it('asks the session where it stands after a lost chunk and goes on from there', async () => {
    const files = new Map([
      ['a/big.psd', { size: 20 * MB, modifiedAt: '2026-11-18T10:00:00.000Z', seed: 5 }],
    ]);
    const drive = await google({ ...studio(), lostChunks: 1 }, files);
    const planned = await plan(drive, STEP, input('a/big.psd'));
    expect(await apply(drive, planned.plan)).toEqual([{ status: 'applied' }]);
    const session = [...drive.drive.sessions!.values()][0];
    expect(session?.checksum).toBe(checksumOfFile(files.get('a/big.psd')!));
    expect(named(drive, 'big.psd')?.size).toBe(20 * MB);
  });

  it('fails a row whose path is not in the workspace, and plans the others', async () => {
    const files = new Map([
      ['a/one.png', { size: 10, modifiedAt: '2026-11-18T10:00:00.000Z', seed: 1 }],
    ]);
    const drive = await google(studio(), files);
    const planned = await plan(drive, STEP, input('a/one.png', 'a/missing.png'));
    expect(planned.plan?.operations.map((each) => each.description)).toEqual([
      `upload 'a/one.png' (10 B) into 'Deliveries' (${DELIVERIES_ID})`,
      expect.stringMatching(
        /^r2 \(will fail: E_GOOGLE_PLAN: r2: 'a\/missing\.png' could not be read in the workspace: .*ENOENT/,
      ),
    ]);
    expect(await apply(drive, planned.plan)).toEqual([
      { status: 'applied' },
      { status: 'failed', reason: expect.stringMatching(/^E_GOOGLE_PLAN: r2:/) },
    ]);
  });
});

describe('applyDriveUploads across calls', () => {
  /** A host in process, with a clock each chunk moves by six seconds. */
  function host(
    drive: FakeDrive,
    files: Map<string, LocalFile>,
    clock: ReturnType<typeof testClock>,
  ) {
    const calls: DriveCall[] = [];
    const cache = new Map<string, Uint8Array>();
    const ports = workspace(files, cache);
    const uploadHost = {
      fetch: async (url: string, init: Parameters<UploadHost['fetch']>[1] = {}) => {
        if (init.body instanceof Uint8Array && init.body.length > 0) clock.advance(6_000);
        const answer: FetchedResponse = driveAnswer(drive, calls, url, init);
        const text = new TextDecoder().decode(answer.body);
        return {
          ...answer,
          ok: answer.status < 300,
          text: async () => text,
          json: async () => JSON.parse(text),
        };
      },
      signin: { accessToken: async () => 'person-token-0701' },
      cache: {
        get: (key: string) => ports.cacheGet!('google', key),
        put: (key: string, value: string) =>
          ports.cachePut!('google', key, new TextEncoder().encode(value)),
        delete: (key: string) => ports.cacheDelete!('google', key),
        list: (prefix = '') => ports.cacheList!('google', prefix),
      },
      workspace: {
        stat: (path: string) => ports.workspaceStat!('google', path),
        list: (path = '') => ports.workspaceList!('google', path),
        read: (path: string, part?: { offset: number; length: number }) =>
          ports.workspaceReadPart!('google', path, part?.offset ?? 0, part?.length ?? 0),
        write: async () => null,
      },
    } as unknown as UploadHost;
    return { uploadHost, calls, cache };
  }

  it('stops before a chunk that would not fit, says how far it got, and the next Apply goes on', async () => {
    const files = new Map([
      ['a/big.psb', { size: 60 * MB, modifiedAt: '2026-11-18T10:00:00.000Z', seed: 3 }],
    ]);
    const drive = studio();
    const clock = testClock(Date.now());
    const { uploadHost, calls, cache } = host(drive, files, clock);
    const request = {
      arguments: {},
      target: 'Deliveries',
      operations: [
        {
          write: 'upload',
          description: 'upload',
          payload: {
            u: 'a/big.psb',
            n: 'big.psb',
            p: DELIVERIES_ID,
            s: 60 * MB,
            m: '2026-11-18T10:00:00.000Z',
          },
        },
      ],
    };
    const first = await applyDriveUploads(uploadHost, request, clock);
    expect(first.ok && first.value.operations).toEqual([
      {
        status: 'skipped',
        reason:
          "sent 16.8 MB of 60.0 MB in this call's time; run the cell and Apply again to go on from there",
      },
    ]);
    expect(cache.size).toBe(1);

    const second = await applyDriveUploads(uploadHost, request, clock);
    expect(second.ok && second.value.operations).toEqual([
      { status: 'skipped', reason: expect.stringMatching(/^sent 33\.6 MB of 60\.0 MB/) },
    ]);
    const third = await applyDriveUploads(uploadHost, request, clock);
    expect(third.ok && third.value.operations).toEqual([
      { status: 'skipped', reason: expect.stringMatching(/^sent 50\.3 MB of 60\.0 MB/) },
    ]);
    const fourth = await applyDriveUploads(uploadHost, request, clock);
    expect(fourth.ok && fourth.value.operations).toEqual([{ status: 'applied' }]);
    // One session for the four calls, each later one asking first where it stands.
    expect(calls.filter((call) => call.method === 'POST')).toHaveLength(1);
    expect(drive.sessions?.size).toBe(1);
    expect([...drive.sessions!.values()][0]?.checksum).toBe(
      checksumOfFile(files.get('a/big.psb')!),
    );
    expect(cache.size).toBe(0);
  });

  it('starts over when Drive no longer has the session the cache kept', async () => {
    const files = new Map([
      ['a/one.png', { size: 1000, modifiedAt: '2026-11-18T10:00:00.000Z', seed: 2 }],
    ]);
    const drive = studio();
    const clock = testClock(Date.now());
    const { uploadHost, cache } = host(drive, files, clock);
    const payload = {
      u: 'a/one.png',
      n: 'one.png',
      p: DELIVERIES_ID,
      s: 1000,
      m: '2026-11-18T10:00:00.000Z',
    };
    cache.set(
      sessionKey(payload),
      new TextEncoder().encode(
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=gone',
      ),
    );
    const answer = await applyDriveUploads(
      uploadHost,
      { arguments: {}, target: 'x', operations: [{ write: 'upload', description: 'u', payload }] },
      clock,
    );
    expect(answer.ok && answer.value.operations).toEqual([{ status: 'applied' }]);
    expect(drive.items.find((item) => item.name === 'one.png')?.size).toBe(1000);
  });
});
