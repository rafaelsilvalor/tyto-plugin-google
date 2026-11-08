import { describe, expect, it } from 'vitest';

import {
  childByNameQuery,
  childrenQuery,
  escapeDriveQueryValue,
  kindOf,
  matchesType,
} from '../src/drive-query.js';

describe('escapeDriveQueryValue', () => {
  it('escapes a quote and a backslash, the backslash first', () => {
    expect(escapeDriveQueryValue("Ana's\\notes")).toBe("Ana\\'s\\\\notes");
    // A backslash before a quote: escaped once each, never the quote's own backslash again.
    expect(escapeDriveQueryValue("\\'")).toBe("\\\\\\'");
    expect(escapeDriveQueryValue('plain')).toBe('plain');
  });
});

describe('childByNameQuery', () => {
  it('is the probed form, with both values escaped', () => {
    expect(childByNameQuery('folder0123456789', "processed's")).toBe(
      "'folder0123456789' in parents and name = 'processed\\'s' and trashed = false",
    );
  });
});

describe('childrenQuery', () => {
  it('asks Drive for the children of one type, never the trash', () => {
    const base = "'folder0123456789' in parents and trashed = false";
    expect(childrenQuery('folder0123456789', undefined)).toBe(base);
    expect(childrenQuery('folder0123456789', 'folder')).toBe(
      `${base} and mimeType = 'application/vnd.google-apps.folder'`,
    );
    expect(childrenQuery('folder0123456789', 'image')).toBe(
      `${base} and mimeType contains 'image/'`,
    );
    for (const type of ['file', 'json'] as const) {
      expect(childrenQuery('folder0123456789', type)).toBe(
        `${base} and mimeType != 'application/vnd.google-apps.folder'`,
      );
    }
    expect(childrenQuery("a'b", undefined)).toBe("'a\\'b' in parents and trashed = false");
  });
});

describe('kindOf and matchesType', () => {
  it('tells a JSON file by its type or its name, and a file is anything but a folder', () => {
    expect(kindOf('application/json', 'a')).toBe('json');
    expect(kindOf('text/plain', 'return.JSON')).toBe('json');
    expect(kindOf('image/png', 'a.png')).toBe('image');
    expect(kindOf('application/vnd.google-apps.folder', 'a')).toBe('folder');
    expect(kindOf('application/vnd.google-apps.document', 'a')).toBe('file');
    expect(matchesType('image', 'file')).toBe(true);
    expect(matchesType('folder', 'file')).toBe(false);
    expect(matchesType('file', 'json')).toBe(false);
    expect(matchesType('folder', undefined)).toBe(true);
  });
});
