import { afterEach, describe, expect, it } from 'vitest';

import { readLink } from '../src/doc-text.js';
import {
  DOCUMENT_MIME,
  fakeDrive,
  inputTable,
  SPREADSHEET_MIME,
  type FakeGoogleDrive,
  type FakeItem,
} from './drive.js';

/**
 * `google.doc-text` through `testPlugin`, over a synthetic Drive of Docs. Every id, name and
 * text is invented.
 */
const doc = (id: string, content: string, extra: Partial<FakeItem> = {}): FakeItem => ({
  id,
  name: `Copy ${id}`,
  mimeType: DOCUMENT_MIME,
  parents: ['copies0123456'],
  createdTime: '2026-11-01T09:00:00.000Z',
  content,
  ...extra,
});

const LINK = (id: string): string => `https://docs.google.com/document/d/${id}/edit`;

let open: FakeGoogleDrive | undefined;
afterEach(async () => {
  await open?.plugin.close();
  open = undefined;
});

async function run(step: string, links: readonly (string | null)[], column = 'Copy') {
  open = await fakeDrive({
    items: [
      doc('docA0123456789', '# Launch\n\n**Bold** line\n'),
      doc('docB0123456789', '- one\n- two\n'),
      doc('docHuge0123456', '', { exportTooLarge: true }),
      doc('docWord0123456', 'binary', { mimeType: 'application/msword' }),
      doc('sheet012345678', '', { mimeType: SPREADSHEET_MIME }),
    ],
  });
  const ran = await open.plugin.runRecipe(step, {
    input: inputTable(
      [column],
      links.map((link) => [link]),
    ),
  });
  if (!ran.ok) return { error: ran.error.map((item) => item.message) };
  const cell = ran.value.cells.at(-1);
  if (cell?.status === 'failed') return { error: cell.diagnostics.map((each) => each.message) };
  const exports = open.calls.filter((call) => call.path.endsWith('/export'));
  return {
    columns: cell?.table?.columns.map((each) => `${each.name}:${each.type}`),
    texts: cell?.table?.rows.map((row) => row.values[cell.table?.columns.at(-1)?.name ?? '']),
    diagnostics: (cell?.diagnostics ?? []).map((each) => `${each.severity}: ${each.message}`),
    exports: exports.map((call) => `${call.path} ${call.query['mimeType'] ?? ''}`),
  };
}

describe('google.doc-text', () => {
  it("adds each Doc's text as Markdown, exporting each distinct Doc once", async () => {
    const answer = await run('google.doc-text doc=Copy', [
      LINK('docA0123456789'),
      'https://docs.google.com/document/u/0/d/docB0123456789/edit?tab=t.0',
      `${LINK('docA0123456789')}#heading=h.x`,
      null,
      '  ',
    ]);
    expect(answer.columns).toEqual(['Copy:text', 'Copy_text:text']);
    expect(answer.texts).toEqual([
      '# Launch\n\n**Bold** line\n',
      '- one\n- two\n',
      '# Launch\n\n**Bold** line\n',
      null,
      null,
    ]);
    // A blank cell is no link to warn about.
    expect(answer.diagnostics).toEqual([]);
    expect(answer.exports).toEqual([
      '/drive/v3/files/docA0123456789/export text/markdown',
      '/drive/v3/files/docB0123456789/export text/markdown',
    ]);
  });

  it('leaves a cell that is no Doc link empty, with one warning naming the rows', async () => {
    const answer = await run('google.doc-text doc=copy', [
      'just some words',
      LINK('docA0123456789'),
      'https://drive.google.com/file/d/docA0123456789/view',
      'docA0123456789',
      'https://docs.google.com/spreadsheets/d/sheet012345678/edit',
      'https://docs.google.com/presentation/d/slides01234567/edit',
    ]);
    expect(answer.texts).toEqual([null, '# Launch\n\n**Bold** line\n', null, null, null, null]);
    expect(answer.diagnostics).toEqual([
      "warning: 'google.doc-text' left Copy_text empty for rows r1, r3, r4: the cell is not a " +
        'Google Doc link (https://docs.google.com/document/d/<id>/…).',
      "warning: 'google.doc-text' left Copy_text empty for rows r5, r6: the link is to a " +
        "Sheet, Slides or another Google file, not a Doc; only a Doc's text is read.",
    ]);
    // Sheets and Slides are refused by their link: Drive is never asked to export them.
    expect(answer.exports).toEqual(['/drive/v3/files/docA0123456789/export text/markdown']);
  });

  it('leaves a Doc over the export limit, an uploaded Word file and a missing Doc empty', async () => {
    const answer = await run('google.doc-text doc=Copy', [
      LINK('docHuge0123456'),
      LINK('docWord0123456'),
      LINK('docGone0123456'),
      LINK('docHuge0123456'),
      LINK('docB0123456789'),
    ]);
    expect(answer.texts).toEqual([null, null, null, null, '- one\n- two\n']);
    expect(answer.diagnostics).toEqual([
      "warning: 'google.doc-text' left Copy_text empty for row r3: the Doc does not exist, or " +
        'is not shared with the Google account signed in on the plugins screen.',
      "warning: 'google.doc-text' left Copy_text empty for row r2: the file opens in Docs but " +
        'is not a Google Doc (an uploaded Word file); convert it with File > Save as Google Docs.',
      "warning: 'google.doc-text' left Copy_text empty for rows r1, r4: Drive exports at most " +
        "10 MB of a Doc's text, and the Doc is larger; split it.",
    ]);
    expect(answer.exports).toHaveLength(4);
  });

  it('names the column with as=, and refuses one the table already has', async () => {
    const named = await run('google.doc-text doc=Copy as=Body', [LINK('docB0123456789')]);
    expect(named.columns).toEqual(['Copy:text', 'Body:text']);
    expect(named.texts).toEqual(['- one\n- two\n']);
    expect((await run('google.doc-text doc=Copy as=copy', [LINK('docB0123456789')])).error).toEqual(
      [expect.stringContaining("would add the column 'copy', which the table already has")],
    );
    expect((await run('google.doc-text doc=Nope', [])).error).toEqual([
      expect.stringContaining("doc= names the column 'Nope', which the table does not have"),
    ]);
  });

  it('refuses more than 100 distinct Docs before any request', async () => {
    const links = Array.from({ length: 101 }, (_, index) =>
      LINK(`doc${String(index).padStart(11, '0')}`),
    );
    const answer = await run('google.doc-text doc=Copy', [...links, links[0] ?? null]);
    expect(answer.error).toEqual([
      "'google.doc-text' would export 101 Docs, over the 100 one call exports; narrow it to " +
        'fewer rows first.',
    ]);
    expect(open?.calls).toEqual([]);
    // 100 distinct Docs, one of them on two rows, is under the cap.
    const under = await run('google.doc-text doc=Copy', [...links.slice(0, 100), links[0] ?? null]);
    expect(under.error).toBeUndefined();
    expect(under.exports).toHaveLength(100);
  });

  it('reads a link only on docs.google.com, by the kind of editor in its path', () => {
    expect(
      [
        LINK('docA0123456789'),
        'https://docs.google.com/document/u/1/d/docA0123456789/',
        'http://docs.google.com/document/d/docA0123456789/edit',
        'https://docs.google.com.evil.example/document/d/docA0123456789/edit',
        'https://docs.google.com/document/d/e/2PACX-published/pub',
        'https://docs.google.com/forms/d/form0123456789/edit',
        'https://docs.google.com/document/d/short/edit',
        42,
        null,
      ].map((value) => readLink(value)),
    ).toEqual([
      { kind: 'doc', id: 'docA0123456789' },
      { kind: 'doc', id: 'docA0123456789' },
      { kind: 'not-a-link' },
      { kind: 'not-a-link' },
      { kind: 'not-a-link' },
      { kind: 'other-editor', type: 'Form' },
      { kind: 'not-a-link' },
      { kind: 'not-a-link' },
      { kind: 'not-a-link' },
    ]);
  });
});
