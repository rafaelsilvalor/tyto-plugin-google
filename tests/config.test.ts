import { describe, expect, it } from 'vitest';

import { folderIdOf, readSection, spreadsheetIdOf } from '../src/config.js';

const SHEET_ID = '1AbCdEfGhIjKlMnOpQrStUvWxYz0123456789';
const FOLDER_ID = '0BxExampleFolderId123';

describe('readSection', () => {
  it('is empty when the folder has no section', () => {
    expect(readSection(undefined)).toEqual({ ok: true, value: {} });
  });

  it('reads the spreadsheet and the root from their addresses, and the tabs as they are', () => {
    expect(
      readSection({
        spreadsheet: `https://docs.google.com/spreadsheets/d/${SHEET_ID}/edit#gid=0`,
        root: `https://drive.google.com/drive/folders/${FOLDER_ID}?usp=sharing`,
        tabs: { Done: { colour: 'green' } },
      }),
    ).toEqual({
      ok: true,
      value: { spreadsheet: SHEET_ID, root: FOLDER_ID, tabs: { Done: { colour: 'green' } } },
    });
  });

  it.each([
    ['a list', []],
    [
      'a spreadsheet on another host',
      { spreadsheet: `https://example.com/spreadsheets/d/${SHEET_ID}` },
    ],
    ['a root that is a word', { root: 'drive' }],
    ['tabs as a list', { tabs: ['Done'] }],
  ])('refuses %s', (_name, section) => {
    expect(readSection(section).ok).toBe(false);
  });

  it('takes an id as it is', () => {
    expect(spreadsheetIdOf(SHEET_ID)).toBe(SHEET_ID);
    expect(folderIdOf(` ${FOLDER_ID} `)).toBe(FOLDER_ID);
  });
});
