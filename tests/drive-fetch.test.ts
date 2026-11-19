import {
  PLUGIN_FILE_LIMIT_BYTES,
  type HostCapabilities,
  type WorkspaceEntry,
} from '@tyto/plugin-api';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { MAX_FETCH_BYTES } from '../src/drive-fetch.js';
import {
  applyWith,
  DOCUMENT_MIME,
  fakeDrive,
  FOLDER_MIME,
  inputTable,
  planOver,
  type DriveCall,
  type FakeDrive,
  type FakeGoogleDrive,
  type FakeItem,
} from './drive.js';

/**
 * `google.drive-fetch` over a synthetic Drive and a synthetic workspace: planned by
 * `runRecipe`, applied as the notebook's Apply does. Every id, name and byte is invented.
 */
const ASSETS_ID = 'assets0123456789';
const MIB = 1024 * 1024;
const DRIVE_TIME = '2026-11-18T09:00:00.000Z';
/** When the fake workspace says a file was written: after every Drive time here. */
const WRITTEN_AT = '2026-11-19T12:00:00.000Z';

interface LocalFile {
  bytes: Uint8Array;
  modifiedAt: string;
}

function image(id: string, name: string, content: string, parent = ASSETS_ID): FakeItem {
  return {
    id,
    name,
    mimeType: 'image/png',
    parents: [parent],
    content,
    createdTime: '2026-11-17T09:00:00.000Z',
    modifiedTime: DRIVE_TIME,
  };
}

function assetsFolder(...children: FakeItem[]): FakeDrive {
  return {
    items: [
      {
        id: ASSETS_ID,
        name: 'Assets',
        mimeType: FOLDER_MIME,
        parents: ['parent0123456789'],
        createdTime: '2026-11-17T09:00:00.000Z',
      },
      ...children,
    ],
  };
}

/** The workspace ports over files by path, with the writes they took. */
function workspace(files: Map<string, LocalFile>): Partial<HostCapabilities> {
  const stat = (path: string): WorkspaceEntry => {
    const name = path.split('/').at(-1) ?? '';
    const file = files.get(path);
    if (file !== undefined) {
      return { name, kind: 'file', size: file.bytes.length, modifiedAt: file.modifiedAt };
    }
    if ([...files.keys()].some((each) => each.startsWith(`${path}/`))) {
      return { name, kind: 'folder', size: 0, modifiedAt: DRIVE_TIME };
    }
    // The words Tyto's own adapter refuses a missing path with.
    throw new Error(`E_WORKSPACE_FILE: '${path}': no such file or folder`);
  };
  return {
    workspaceStat: async (_plugin, path) => stat(path),
    workspaceList: async () => [],
    workspaceWrite: async (_plugin, path, bytes) => {
      files.set(path, { bytes, modifiedAt: WRITTEN_AT });
    },
  };
}

let open: FakeGoogleDrive | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await open?.plugin.close();
  open = undefined;
});

async function google(
  drive: FakeDrive,
  files: Map<string, LocalFile>,
  onCall?: (call: DriveCall) => void,
): Promise<FakeGoogleDrive> {
  await open?.plugin.close();
  open = await fakeDrive(drive, {
    capabilities: workspace(files),
    ...(onCall === undefined ? {} : { onCall }),
  });
  return open;
}

const STEP = 'google.drive-fetch from=assets into=record_path';
const FOLDER_LINK = `https://drive.google.com/drive/folders/${ASSETS_ID}`;
const rows = (...cells: (readonly (string | null)[])[]) =>
  inputTable(['assets', 'record_path'], cells);
const text = (file: LocalFile | undefined) =>
  file === undefined ? undefined : new TextDecoder().decode(file.bytes);
const downloads = (drive: FakeGoogleDrive) =>
  drive.calls.filter((call) => call.query['alt'] === 'media');

describe('google.drive-fetch', () => {
  it("writes a task's two Drive images into its assets folder, and plans nothing on a second run", async () => {
    const files = new Map<string, LocalFile>();
    const drive = await google(
      assetsFolder(
        image('img1-0123456789', 'capa.png', 'png bytes of the cover'),
        image('img2-0123456789', 'fundo.png', 'png bytes of the background'),
      ),
      files,
    );
    const first = await planOver(drive, STEP, rows([FOLDER_LINK, 'entregas/MCA-1_aula']));
    expect(first.diagnostics).toEqual([]);
    expect(first.plan?.operations.map((each) => [each.write, each.description])).toEqual([
      ['fetch', "fetch 'capa.png' (22 B) from Drive into 'entregas/MCA-1_aula/assets/capa.png'"],
      ['fetch', "fetch 'fundo.png' (27 B) from Drive into 'entregas/MCA-1_aula/assets/fundo.png'"],
    ]);
    expect(await applyWith(drive, 'google.drive-fetch', first.plan!)).toEqual([
      { status: 'applied' },
      { status: 'applied' },
    ]);
    expect(text(files.get('entregas/MCA-1_aula/assets/capa.png'))).toBe('png bytes of the cover');
    expect(text(files.get('entregas/MCA-1_aula/assets/fundo.png'))).toBe(
      'png bytes of the background',
    );

    // An Apply run twice downloads nothing again.
    const fetched = downloads(drive).length;
    expect(await applyWith(drive, 'google.drive-fetch', first.plan!)).toEqual([
      { status: 'applied' },
      { status: 'applied' },
    ]);
    expect(downloads(drive)).toHaveLength(fetched);

    const second = await planOver(drive, STEP, rows([FOLDER_LINK, 'entregas/MCA-1_aula']));
    expect(second.plan?.operations).toEqual([]);
    expect(second.diagnostics.map((each) => each.message)).toEqual([
      expect.stringMatching(
        /^'google\.drive-fetch' plans nothing for 2 files already in the workspace with the same size/,
      ),
    ]);
  });

  it("expands a folder link to its direct files, leaves out a Doc and a subfolder's files, and takes a file link alone", async () => {
    const files = new Map<string, LocalFile>();
    const drive = await google(
      assetsFolder(
        image('img1-0123456789', 'capa.png', 'cover'),
        {
          id: 'doc0-0123456789',
          name: 'Briefing',
          mimeType: DOCUMENT_MIME,
          parents: [ASSETS_ID],
          createdTime: '2026-11-17T10:00:00.000Z',
        },
        {
          id: 'sub0-0123456789',
          name: 'old',
          mimeType: FOLDER_MIME,
          parents: [ASSETS_ID],
          createdTime: '2026-11-17T11:00:00.000Z',
        },
        image('img3-0123456789', 'deep.png', 'not fetched', 'sub0-0123456789'),
        image('img4-0123456789', 'logo.png', 'a logo', 'elsewhere0123456'),
      ),
      files,
    );
    const planned = await planOver(
      drive,
      STEP,
      rows(
        [FOLDER_LINK, 'entregas/A'],
        ['https://drive.google.com/file/d/img4-0123456789/view', 'entregas/B/'],
      ),
    );
    expect(planned.plan?.operations.map((each) => each.description)).toEqual([
      "fetch 'capa.png' (5 B) from Drive into 'entregas/A/assets/capa.png'",
      "fetch 'logo.png' (6 B) from Drive into 'entregas/B/assets/logo.png'",
    ]);
    expect(planned.diagnostics.map((each) => each.message)).toEqual([
      "'google.drive-fetch' left out 1 Google file with no bytes to fetch: 'Briefing'.",
    ]);
  });

  it("fetches at most the plugin API's ceiling on one workspace file", () => {
    expect(MAX_FETCH_BYTES).toBe(PLUGIN_FILE_LIMIT_BYTES);
  });

  it('shows a file over 32 MiB as a line that fails, and still fetches the rest of the row', async () => {
    const files = new Map<string, LocalFile>();
    const drive = await google(
      assetsFolder(image('img1-0123456789', 'capa.png', 'cover'), {
        id: 'big0-0123456789',
        name: 'video.mov',
        mimeType: 'video/quicktime',
        parents: [ASSETS_ID],
        size: 40 * MIB,
        createdTime: '2026-11-17T09:00:00.000Z',
        modifiedTime: DRIVE_TIME,
      }),
      files,
    );
    const planned = await planOver(drive, STEP, rows([FOLDER_LINK, 'entregas/A']));
    expect(planned.plan?.operations.map((each) => each.description)).toEqual([
      "fetch 'capa.png' (5 B) from Drive into 'entregas/A/assets/capa.png'",
      "r1 (will fail: E_GOOGLE_PLAN: r1: 'video.mov' is 41.9 MB, over the 33.6 MB one workspace " +
        'write holds; it is not fetched)',
    ]);
    expect(await applyWith(drive, 'google.drive-fetch', planned.plan!)).toEqual([
      { status: 'applied' },
      { status: 'failed', reason: expect.stringMatching(/^E_GOOGLE_PLAN: r1: 'video\.mov' is/) },
    ]);
    expect(downloads(drive).map((call) => call.path)).toEqual(['/drive/v3/files/img1-0123456789']);
  });

  it('replaces a local file of another size, and never writes over one changed since the plan', async () => {
    const files = new Map<string, LocalFile>([
      [
        'entregas/A/assets/capa.png',
        { bytes: new TextEncoder().encode('old'), modifiedAt: WRITTEN_AT },
      ],
    ]);
    const drive = await google(assetsFolder(image('img1-0123456789', 'capa.png', 'cover')), files);
    const planned = await planOver(drive, STEP, rows([FOLDER_LINK, 'entregas/A']));
    expect(planned.plan?.operations.map((each) => [each.write, each.description])).toEqual([
      [
        'replace',
        `replace 'entregas/A/assets/capa.png' (3 B, ${WRITTEN_AT}) with Drive's 'capa.png' ` +
          `(5 B, ${DRIVE_TIME})`,
      ],
    ]);
    files.set('entregas/A/assets/capa.png', {
      bytes: new TextEncoder().encode('edited by a person'),
      modifiedAt: '2026-11-19T13:00:00.000Z',
    });
    expect(await applyWith(drive, 'google.drive-fetch', planned.plan!)).toEqual([
      {
        status: 'failed',
        reason: expect.stringMatching(
          /^E_GOOGLE_CHANGED: 'entregas\/A\/assets\/capa\.png' changed/,
        ),
      },
    ]);
    expect(text(files.get('entregas/A/assets/capa.png'))).toBe('edited by a person');
  });

  it('fails a row whose link or folder it cannot read, and leaves out a blank one', async () => {
    const drive = await google(assetsFolder(), new Map());
    const planned = await planOver(
      drive,
      STEP,
      rows(['not a link', 'entregas/A'], [FOLDER_LINK, '../outside'], [null, 'entregas/C']),
    );
    expect(planned.plan?.operations.map((each) => each.description)).toEqual([
      "r1 (will fail: E_GOOGLE_PLAN: r1: 'not a link' in assets is neither a Drive file nor a folder link)",
      "r2 (will fail: E_GOOGLE_PLAN: r2: '../outside' in record_path is not a folder inside the workspace)",
    ]);
    expect(planned.diagnostics.map((each) => each.message)).toEqual([
      "'google.drive-fetch' left out 1 row with no link or no folder.",
    ]);
  });
});

describe('one Apply over several calls (Tyto ADR 0216)', () => {
  it('finishes five files that need three calls in one Apply, saying how many each call fetched', async () => {
    // The plugin measures its 20 s with the system clock: Date is faked, and every download
    // moves it by six seconds, so a call fetches two files.
    vi.useFakeTimers({ toFake: ['Date'], now: Date.UTC(2026, 10, 19, 12) });
    const files = new Map<string, LocalFile>();
    const names = ['a', 'b', 'c', 'd', 'e'];
    const drive = await google(
      assetsFolder(
        ...names.map((name) => image(`img-${name}-0123456789`, `${name}.png`, `bytes ${name}`)),
      ),
      files,
      (call) => {
        if (call.query['alt'] === 'media') vi.setSystemTime(Date.now() + 6_000);
      },
    );
    const planned = await planOver(drive, STEP, rows([FOLDER_LINK, 'entregas/A']));
    const verb = drive.plugin.recipes.verbs.get('google.drive-fetch');
    const notes: (string | undefined)[] = [];
    const applied = await verb!.apply!(planned.plan!, {
      onProgress: (progress) => notes.push(progress.note),
    });
    expect(applied.ok && applied.value.operations.map((each) => each.status)).toEqual(
      Array(5).fill('applied'),
    );
    expect(notes).toEqual(['fetched 2 of 5 files', 'fetched 2 of 3 files', undefined]);
    expect(downloads(drive)).toHaveLength(5);
    expect(names.map((name) => text(files.get(`entregas/A/assets/${name}.png`)))).toEqual(
      names.map((name) => `bytes ${name}`),
    );
  });
});
