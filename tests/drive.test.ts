import { afterEach, describe, expect, it } from 'vitest';

import {
  FOLDER_MIME,
  INBOX_ID,
  INBOX_URL,
  fakeDrive,
  inboxFile,
  listCalls,
  run,
  type FakeDrive,
  type FakeGoogleDrive,
} from './drive.js';

/**
 * `google.drive-list` and `google.drive-read` through `testPlugin` and `runRecipe`, over a
 * synthetic Drive: an inbox folder that a routine drops JSON returns into, as Buraqueira's.
 */
let open: FakeGoogleDrive | undefined;
async function google(
  drive: FakeDrive,
  section: unknown = { root: INBOX_URL },
): Promise<FakeGoogleDrive> {
  await open?.plugin.close();
  open = await fakeDrive(drive, { section });
  return open;
}
afterEach(async () => {
  await open?.plugin.close();
  open = undefined;
});

const RETURN_A = JSON.stringify([
  { task: 'EX-1', done: true, count: 2, tags: ['a', 'b'], detail: { by: 'routine' } },
  { task: 'EX-2', done: false, count: null, tags: [], detail: null },
]);
const RETURN_B = JSON.stringify([{ task: 'EX-3', done: true }]);

function inbox(): FakeDrive {
  return {
    items: [
      inboxFile('fileB0123456789', 'return-b.json', 6, RETURN_B),
      inboxFile('fileA0123456789', 'return-a.json', 5, RETURN_A),
      inboxFile('note0123456789x', 'notes.txt', 4, 'first\r\nsecond\n', 'text/plain'),
      inboxFile('image0123456789', 'cover.png', 3, undefined, 'image/png'),
      {
        ...inboxFile('processed012345', 'processed', 2, undefined, FOLDER_MIME),
      },
      inboxFile('doc0123456789xx', 'Brief', 1, undefined, 'application/vnd.google-apps.document'),
      { ...inboxFile('trash0123456789', 'old.json', 1, '[]'), trashed: true },
      { ...inboxFile('elsewhere012345', 'other.json', 1, '[]'), parents: ['other0123456789'] },
    ],
  };
}

describe('google.drive-list', () => {
  it("lists the section root's children, oldest first, keyed by Drive id", async () => {
    const drive = await google(inbox());
    const answer = await run(drive, 'google.drive-list');
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.columns.map((column) => `${column.name}:${column.type}`)).toEqual([
      'id:text',
      'name:text',
      'mime_type:text',
      'kind:text',
      'size:number',
      'created:datetime',
      'modified:datetime',
      'url:link',
      'parent_id:text',
      'width:number',
      'height:number',
    ]);
    expect(answer.table?.rows.map((row) => `${row.key} ${String(row.values['kind'])}`)).toEqual([
      'doc0123456789xx file',
      'processed012345 folder',
      'image0123456789 image',
      'note0123456789x file',
      'fileA0123456789 json',
      'fileB0123456789 json',
    ]);
    expect(answer.table?.rows[4]?.values).toEqual({
      id: 'fileA0123456789',
      name: 'return-a.json',
      mime_type: 'application/json',
      kind: 'json',
      size: new TextEncoder().encode(RETURN_A).byteLength,
      created: '2026-11-05T09:00:00.000Z',
      modified: '2026-11-05T09:00:00.000Z',
      url: 'https://drive.google.com/file/d/fileA0123456789/view',
      parent_id: INBOX_ID,
      width: null,
      height: null,
    });
    expect(answer.table?.rows[1]?.values['size']).toBeNull();
    expect(answer.table?.rows[0]?.provenance).toMatchObject({
      source: 'google',
      id: 'doc0123456789xx',
    });
    expect(listCalls(drive).map((call) => call.query)).toEqual([
      {
        q: `'${INBOX_ID}' in parents and trashed = false`,
        fields:
          'nextPageToken, files(id, name, mimeType, size, createdTime, modifiedTime, ' +
          'webViewLink, parents, imageMediaMetadata(width, height))',
        orderBy: 'createdTime,name',
        pageSize: '1000',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      },
    ]);
  });

  it("adds an image's width and height from the same listing, empty for a PSD", async () => {
    const drive = await google({
      items: [
        {
          ...inboxFile('grid0123456789x', 'grid-01.png', 1, undefined, 'image/png'),
          image: { width: 1080, height: 1350 },
        },
        inboxFile('psd0123456789xx', 'grid-01.psd', 2, undefined, 'image/vnd.adobe.photoshop'),
      ],
    });
    const answer = await run(drive, 'google.drive-list');
    expect(answer.diagnostics).toEqual([]);
    expect(
      answer.table?.rows.map((row) => [
        row.values['name'],
        row.values['width'],
        row.values['height'],
      ]),
    ).toEqual([
      ['grid-01.png', 1080, 1350],
      ['grid-01.psd', null, null],
    ]);
    // One listing, no request per file.
    expect(drive.calls).toHaveLength(1);
  });

  it("walks Drive's pages through nextPageToken, one call per page", async () => {
    const drive = await google({ ...inbox(), pageSize: 2 });
    const answer = await run(drive, 'google.drive-list');
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.rows).toHaveLength(6);
    expect(listCalls(drive).map((call) => call.query['pageToken'] ?? null)).toEqual([
      null,
      'page-2',
      'page-4',
    ]);
  });

  it('keeps only the type asked for', async () => {
    const drive = await google(inbox());
    const kinds = async (type: string) =>
      (await run(drive, `google.drive-list type=${type}`)).table?.rows.map((row) => row.key);
    expect(await kinds('folder')).toEqual(['processed012345']);
    expect(await kinds('image')).toEqual(['image0123456789']);
    expect(await kinds('json')).toEqual(['fileA0123456789', 'fileB0123456789']);
    expect(await kinds('file')).toEqual([
      'doc0123456789xx',
      'image0123456789',
      'note0123456789x',
      'fileA0123456789',
      'fileB0123456789',
    ]);
    const asked = listCalls(drive).map((call) => call.query['q']);
    expect(asked[0]).toBe(
      `'${INBOX_ID}' in parents and trashed = false and mimeType = '${FOLDER_MIME}'`,
    );
    expect(asked[1]).toBe(
      `'${INBOX_ID}' in parents and trashed = false and mimeType contains 'image/'`,
    );
  });

  it('reads folder= over the section, and refuses more items than max= rather than cut', async () => {
    const drive = await google(inbox(), {});
    const named = await run(drive, `google.drive-list folder=${INBOX_URL} type=json`);
    expect(named.table?.rows).toHaveLength(2);
    const cut = await run(drive, `google.drive-list folder=${INBOX_ID} max=1`);
    expect(cut.table).toBeUndefined();
    expect(cut.diagnostics[0]?.message).toMatch(/cut .* short/);
  });

  it('says what it needs when no folder is named or set, and names a wrong type', async () => {
    const drive = await google(inbox(), {});
    const none = await run(drive, 'google.drive-list');
    expect(none.diagnostics).toEqual([
      {
        code: 'E_RECIPE_ARGUMENTS',
        message:
          "'google.drive-list' needs folder=, or root in the google section of " +
          '.tyto/project.json, and was given neither.',
      },
    ]);
    const wrong = await run(drive, `google.drive-list folder=${INBOX_ID} type=video`);
    expect(wrong.diagnostics[0]?.message).toBe(
      "'google.drive-list' type= must be one of folder, file, image, json, not 'video'.",
    );
    expect(drive.calls).toEqual([]);
  });
});

describe('google.drive-read', () => {
  it("reads the folder's JSON files, one per page, into the files' columns", async () => {
    const drive = await google(inbox());
    const answer = await run(drive, 'google.drive-read');
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.columns.map((column) => `${column.name}:${column.type}`)).toEqual([
      'file_id:text',
      'file_name:text',
      'task:text',
      'done:boolean',
      'count:number',
      'tags:list',
      'detail:text',
    ]);
    expect(answer.table?.rows.map((row) => row.key)).toEqual([
      'fileA0123456789:0',
      'fileA0123456789:1',
      'fileB0123456789:0',
    ]);
    expect(answer.table?.rows[0]?.values).toEqual({
      file_id: 'fileA0123456789',
      file_name: 'return-a.json',
      task: 'EX-1',
      done: true,
      count: 2,
      tags: ['a', 'b'],
      detail: '{"by":"routine"}',
    });
    expect(answer.table?.rows[2]?.values).toMatchObject({ task: 'EX-3', count: null });
    const downloads = drive.calls.filter((call) => call.query['alt'] === 'media');
    // The first page reads every file to gather the columns and answers the first from that
    // read; the second page downloads the second file again.
    expect(downloads.map((call) => call.path)).toEqual([
      '/drive/v3/files/fileA0123456789',
      '/drive/v3/files/fileB0123456789',
      '/drive/v3/files/fileB0123456789',
    ]);
    expect(downloads[0]?.query['supportsAllDrives']).toBe('true');
    // Each page lists the folder once, to find its file and see the folder did not change.
    expect(listCalls(drive)).toHaveLength(2);
  });

  it('reads a JSON object as one row, and a text file as one row per line', async () => {
    const drive = await google({
      items: [
        inboxFile('object012345678', 'single.json', 1, '{"task":"EX-9","n":3}'),
        inboxFile('note0123456789x', 'notes.txt', 2, '\uFEFFfirst\r\nsecond\n', 'text/plain'),
      ],
    });
    const object = await run(drive, 'google.drive-read file=object012345678');
    expect(object.table?.rows.map((row) => [row.key, row.values])).toEqual([
      [
        'object012345678:0',
        { file_id: 'object012345678', file_name: 'single.json', task: 'EX-9', n: 3 },
      ],
    ]);
    const text = await run(
      drive,
      'google.drive-read file=https://drive.google.com/file/d/note0123456789x/view',
    );
    expect(text.table?.columns.map((column) => column.name)).toEqual([
      'file_id',
      'file_name',
      'line',
      'text',
    ]);
    expect(
      text.table?.rows.map((row) => [row.key, row.values['line'], row.values['text']]),
    ).toEqual([
      ['note0123456789x:1', 1, 'first'],
      ['note0123456789x:2', 2, 'second'],
    ]);
    const metadata = drive.calls.find((call) => call.query['alt'] === undefined);
    expect(metadata?.query).toMatchObject({ supportsAllDrives: 'true' });
  });

  it('refuses a native Google file without downloading it', async () => {
    const drive = await google(inbox());
    const answer = await run(drive, 'google.drive-read file=doc0123456789xx');
    expect(answer.table).toBeUndefined();
    expect(answer.diagnostics[0]?.code).toBe('E_RECIPE_ARGUMENTS');
    expect(answer.diagnostics[0]?.message).toMatch(
      /cannot read 'Brief', a native Google file \(application\/vnd\.google-apps\.document\)/,
    );
    expect(drive.calls.filter((call) => call.query['alt'] === 'media')).toEqual([]);
  });

  it('refuses a body over 8 MiB, by its size before the download or by its bytes after', async () => {
    const big = 8 * 1024 * 1024 + 1;
    const drive = await google({
      items: [
        { ...inboxFile('large0123456789', 'large.json', 1, '[]'), size: big },
        inboxFile('unsized01234567', 'unsized.txt', 2, 'x'.repeat(big), 'text/plain'),
      ],
    });
    const declared = await run(drive, 'google.drive-read file=large0123456789');
    expect(declared.diagnostics[0]?.message).toBe(
      "'google.drive-read' reads files of at most 8388608 bytes (8 MiB), and 'large.json' has " +
        `${big}.`,
    );
    expect(drive.calls.filter((call) => call.query['alt'] === 'media')).toEqual([]);
    // Drive's size can be missing or stale: the downloaded bytes are measured too.
    const item = drive.drive.items[1];
    if (item !== undefined) item.size = 10;
    const measured = await run(drive, 'google.drive-read file=unsized01234567');
    expect(measured.diagnostics[0]?.message).toMatch(/'unsized\.txt' has 8388609\.$/);
  });

  it("reads a folder into the union of its files' keys, typed by every file's values", async () => {
    const drive = await google({
      items: [
        inboxFile('fileA0123456789', 'a.json', 1, '[{"task":"EX-1","count":1}]'),
        inboxFile('fileB0123456789', 'b.json', 2, '[{"extra":true,"task":"EX-2","count":"many"}]'),
      ],
    });
    const answer = await run(drive, 'google.drive-read');
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.columns.map((column) => `${column.name}:${column.type}`)).toEqual([
      'file_id:text',
      'file_name:text',
      'task:text',
      'count:text',
      'extra:boolean',
    ]);
    expect(answer.table?.rows.map((row) => row.values)).toEqual([
      { file_id: 'fileA0123456789', file_name: 'a.json', task: 'EX-1', count: '1', extra: null },
      { file_id: 'fileB0123456789', file_name: 'b.json', task: 'EX-2', count: 'many', extra: true },
    ]);
  });

  it("spreads each return file's items into rows, and skips a file that is not JSON", async () => {
    const first = { origem: 'routine', versao: 2, itens: [{ task: 'EX-1', descricao: 'one' }] };
    const second = {
      origem: 'routine',
      versao: 2,
      aviso: 'late',
      itens: [
        { task: 'EX-2', descricao: 'two' },
        { task: 'EX-3', descricao: 'three', erro: 'not found' },
      ],
    };
    const drive = await google({
      items: [
        inboxFile('fileA0123456789', 'return-1.json', 1, JSON.stringify(first)),
        inboxFile('fileB0123456789', 'return-2.json', 2, JSON.stringify(second)),
        inboxFile('fileC0123456789', 'return-3.json', 3, '{"origem":"routine","itens":['),
      ],
    });
    const answer = await run(drive, 'google.drive-read rows=itens');
    expect(answer.diagnostics).toEqual([
      {
        code: 'E_RECIPE_VERB',
        message:
          "'google.drive-read' skipped the file fileC0123456789 and read the others: " +
          "'return-3.json' is not JSON.",
      },
    ]);
    expect(answer.table?.columns.map((column) => `${column.name}:${column.type}`)).toEqual([
      'file_id:text',
      'file_name:text',
      'origem:text',
      'versao:number',
      'task:text',
      'descricao:text',
      'aviso:text',
      'erro:text',
    ]);
    expect(answer.table?.rows.map((row) => [row.key, row.values])).toEqual([
      [
        'fileA0123456789:0',
        {
          file_id: 'fileA0123456789',
          file_name: 'return-1.json',
          origem: 'routine',
          versao: 2,
          task: 'EX-1',
          descricao: 'one',
          aviso: null,
          erro: null,
        },
      ],
      [
        'fileB0123456789:0',
        {
          file_id: 'fileB0123456789',
          file_name: 'return-2.json',
          origem: 'routine',
          versao: 2,
          task: 'EX-2',
          descricao: 'two',
          aviso: 'late',
          erro: null,
        },
      ],
      [
        'fileB0123456789:1',
        {
          file_id: 'fileB0123456789',
          file_name: 'return-2.json',
          origem: 'routine',
          versao: 2,
          task: 'EX-3',
          descricao: 'three',
          aviso: 'late',
          erro: 'not found',
        },
      ],
    ]);
  });

  it("copies an object's scalar keys onto each item of rows=, an item's own key first", async () => {
    const file = {
      origem: 'routine',
      versao: 2,
      meta: { run: 7 },
      flags: ['a'],
      itens: [{ task: 'EX-1', origem: 'item', detail: { by: 'x' } }, 'loose'],
    };
    const drive = await google({
      items: [inboxFile('object012345678', 'return.json', 1, JSON.stringify(file))],
    });
    const answer = await run(drive, 'google.drive-read file=object012345678 rows=itens');
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.columns.map((column) => `${column.name}:${column.type}`)).toEqual([
      'file_id:text',
      'file_name:text',
      'origem:text',
      'versao:number',
      'task:text',
      'detail:text',
      'value:text',
    ]);
    expect(answer.table?.rows.map((row) => [row.key, row.values])).toEqual([
      [
        'object012345678:0',
        {
          file_id: 'object012345678',
          file_name: 'return.json',
          origem: 'item',
          versao: 2,
          task: 'EX-1',
          detail: '{"by":"x"}',
          value: null,
        },
      ],
      [
        'object012345678:1',
        {
          file_id: 'object012345678',
          file_name: 'return.json',
          origem: 'routine',
          versao: 2,
          task: null,
          detail: null,
          value: 'loose',
        },
      ],
    ]);
  });

  it('skips a folder file without the rows= list, and never downloads it again', async () => {
    const drive = await google({
      items: [
        inboxFile('fileA0123456789', 'a.json', 1, '{"origem":"routine","itens":[{"task":"EX-1"}]}'),
        inboxFile('fileB0123456789', 'b.json', 2, '{"origem":"routine"}'),
        inboxFile('fileC0123456789', 'c.json', 3, '{"itens":"none"}'),
        inboxFile('fileD0123456789', 'd.json', 4, '{"itens":[{"task":"EX-4"}]}'),
      ],
    });
    const answer = await run(drive, 'google.drive-read rows=itens');
    expect(answer.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      "'google.drive-read' skipped the file fileB0123456789 and read the others: 'b.json' has " +
        "no key 'itens'.",
      "'google.drive-read' skipped the file fileC0123456789 and read the others: 'c.json' holds " +
        "the string none under 'itens', not a list.",
    ]);
    expect(answer.table?.rows.map((row) => [row.key, row.values['origem']])).toEqual([
      ['fileA0123456789:0', 'routine'],
      ['fileD0123456789:0', null],
    ]);
    const downloads = drive.calls.filter((call) => call.query['alt'] === 'media');
    expect(downloads.map((call) => call.path.replace('/drive/v3/files/', ''))).toEqual([
      'fileA0123456789',
      'fileB0123456789',
      'fileC0123456789',
      'fileD0123456789',
      'fileD0123456789',
    ]);
    // One file alone is the whole run: without the list, it fails.
    const alone = await run(drive, 'google.drive-read file=fileB0123456789 rows=itens');
    expect(alone.table).toBeUndefined();
    expect(alone.diagnostics).toEqual([
      {
        code: 'E_RECIPE_VERB',
        message: "'google.drive-read' failed: 'b.json' has no key 'itens'.",
      },
    ]);
  });

  it('pages a file of more than 5,000 elements, downloading it again for each page', async () => {
    const many = JSON.stringify(Array.from({ length: 5001 }, (_, at) => ({ n: at })));
    const drive = await google({ items: [inboxFile('many0123456789x', 'many.json', 1, many)] });
    const answer = await run(drive, 'google.drive-read');
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.rows).toHaveLength(5001);
    expect(answer.table?.rows.at(-1)?.key).toBe('many0123456789x:5000');
    expect(drive.calls.filter((call) => call.query['alt'] === 'media')).toHaveLength(2);
  });

  it('says what it needs of its arguments before any request', async () => {
    const drive = await google(inbox());
    const message = async (step: string) => (await run(drive, step)).diagnostics[0]?.message;
    expect(await message('google.drive-read type=text')).toBe(
      "'google.drive-read' reads a folder as its JSON files only; type=text needs file=.",
    );
    expect(await message('google.drive-read file=fileA0123456789 type=text rows=itens')).toBe(
      "'google.drive-read' rows= spreads a list of a JSON object into rows; type=text reads lines.",
    );
    expect(await message(`google.drive-read file=fileA0123456789 folder=${INBOX_ID}`)).toBe(
      "'google.drive-read' takes file= or folder=, not both.",
    );
    expect(await message('google.drive-read file=not-an-id')).toMatch(
      /file= holds 'not-an-id', which is neither a Drive file id nor its address/,
    );
    expect(drive.calls).toEqual([]);
  });

  it('answers an empty table for a folder without JSON files', async () => {
    const drive = await google({ items: [] });
    const answer = await run(drive, 'google.drive-read');
    expect(answer.diagnostics).toEqual([]);
    expect(answer.table?.rows).toEqual([]);
  });
});
