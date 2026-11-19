import type { TestRecipeOptions } from '@tyto/plugin-api/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { lastSegment } from '../src/drive-url.js';
import { fakeDrive, FOLDER_MIME, type FakeGoogleDrive, type FakeItem } from './drive.js';

/**
 * `google.drive-url` through `testPlugin`, over a synthetic Drive: the root, a `Deliveries`
 * folder in it, and delivery folders under that. Every id and name is invented.
 */
type InputTable = NonNullable<TestRecipeOptions['input']>;

const ROOT_ID = 'root0123456789';
const DELIVERIES_ID = 'deliveries01234';
const folder = (id: string, name: string, parents: string[], trashed = false): FakeItem => ({
  id,
  name,
  mimeType: FOLDER_MIME,
  parents,
  createdTime: '2026-11-01T09:00:00.000Z',
  ...(trashed ? { trashed } : {}),
});

const input = (...paths: (string | null)[]): InputTable => ({
  columns: [{ name: 'Path', type: 'text', origin: 'test' }],
  rows: paths.map((path, index) => ({
    key: `r${index + 1}`,
    values: { Path: path },
    provenance: { source: 'test', id: `r${index + 1}`, fetchedAt: '2026-11-19T00:00:00.000Z' },
  })),
});

let open: FakeGoogleDrive | undefined;
afterEach(async () => {
  await open?.plugin.close();
  open = undefined;
});

async function run(step: string, table: InputTable) {
  open = await fakeDrive(
    {
      items: [
        folder(ROOT_ID, 'Studio', ['top0123456789x']),
        folder(DELIVERIES_ID, 'Deliveries', [ROOT_ID]),
        folder('d1folder012345', 'D1', [DELIVERIES_ID]),
        folder('d1elsewhere012', 'D2', [ROOT_ID]),
        folder('d3twinA0123456', 'D3', [DELIVERIES_ID]),
        folder('d3twinB0123456', 'D3', [DELIVERIES_ID]),
        folder('d4trashed01234', 'D4', [DELIVERIES_ID], true),
        { ...folder('d5file01234567', 'D5', [DELIVERIES_ID]), mimeType: 'image/png' },
      ],
    },
    { section: { root: ROOT_ID } },
  );
  const ran = await open.plugin.runRecipe(step, { input: table });
  if (!ran.ok) return { error: ran.error.map((item) => item.message) };
  const cell = ran.value.cells.at(-1);
  if (cell?.status === 'failed') return { error: cell.diagnostics.map((each) => each.message) };
  return {
    columns: cell?.table?.columns.map((each) => `${each.name}:${each.type}`),
    urls: cell?.table?.rows.map((row) => row.values['Path_url']),
    diagnostics: (cell?.diagnostics ?? []).map((each) => each.message),
    lookups: open.calls.filter((call) => call.query['q']?.startsWith('name =')).length,
  };
}

const URL_OF = (id: string): string => `https://drive.google.com/drive/folders/${id}`;

describe('google.drive-url', () => {
  it("adds a link to each row's folder in in=, and leaves it empty where none is", async () => {
    const answer = await run(
      'google.drive-url path=Path in=Deliveries',
      input('entregas/D1', 'entregas\\D1\\', 'entregas/D2', 'entregas/D4', 'entregas/D5', null),
    );
    expect(answer.columns).toEqual(['Path:text', 'Path_url:link']);
    // D2 is in the root, not in Deliveries; D4 is in the trash; D5 is a file, not a folder.
    expect(answer.urls).toEqual([
      URL_OF('d1folder012345'),
      URL_OF('d1folder012345'),
      null,
      null,
      null,
      null,
    ]);
    expect(answer.diagnostics).toEqual([]);
    // One lookup per distinct name, never per row.
    expect(answer.lookups).toBe(4);
  });

  it('runs after an action in one recipe, on the table the action was handed', async () => {
    const answer = await run(
      'google.drive-folder name=Path parent=Deliveries\ngoogle.drive-url path=Path in=Deliveries',
      input('D1'),
    );
    expect(answer.urls).toEqual([URL_OF('d1folder012345')]);
  });

  it('looks in the root when in= is left out', async () => {
    const answer = await run('google.drive-url path=path', input('x/D2', 'x/D1'));
    expect(answer.urls).toEqual([URL_OF('d1elsewhere012'), null]);
  });

  it('leaves the link empty, with a warning, where two folders carry the name', async () => {
    const answer = await run('google.drive-url path=Path in=Deliveries', input('a/D3'));
    expect(answer.urls).toEqual([null]);
    expect(answer.diagnostics).toEqual([
      "'google.drive-url' left Path_url empty for 'D3': more than one folder of that name is " +
        'there; keep one.',
    ]);
  });

  it('refuses a column it would overwrite, and an in= that is not under the root', async () => {
    const taken: InputTable = {
      ...input('a/D1'),
      columns: [...input().columns, { name: 'path_URL', type: 'text', origin: 'test' }],
    };
    expect((await run('google.drive-url path=Path', taken)).error).toEqual([
      expect.stringContaining("would add the column 'Path_url', which the table already has"),
    ]);
    expect((await run('google.drive-url path=Path in=Nowhere', input('a/D1'))).error).toEqual([
      expect.stringContaining("in= names 'Nowhere', and no folder of that name is in"),
    ]);
  });

  it('reads the last segment of a path written either way', () => {
    expect(['a/b/D1', 'a\\D1\\', ' D1 ', '', '/', null].map(lastSegment)).toEqual([
      'D1',
      'D1',
      'D1',
      undefined,
      undefined,
      undefined,
    ]);
  });
});
