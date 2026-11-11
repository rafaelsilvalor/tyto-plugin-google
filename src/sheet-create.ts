import type { RecipeVerbContribution } from '@tyto/plugin-api';

import {
  applyCreates,
  CREATE_ARGUMENTS,
  CREATE_WRITE,
  planCreates,
  SHARE_WRITE,
  type CreateHost,
  type CreateKind,
} from './drive-create.js';
import { systemClock, type WriteClock } from './sheet-write-apply.js';

export const SHEET_CREATE = 'google.sheet-create';

/** A Google Sheets spreadsheet, as Drive types it. */
export const SPREADSHEET_MIME_TYPE = 'application/vnd.google-apps.spreadsheet';

/**
 * A new spreadsheet is a Drive `files.create` of this type, so it shares the folder verb's
 * parent, second-run and sharing rules; the Sheets API is not needed to make an empty one, and
 * Google names its first tab.
 */
export const SPREADSHEET_KIND: CreateKind = {
  verb: SHEET_CREATE,
  noun: 'spreadsheet',
  mimeType: SPREADSHEET_MIME_TYPE,
  link: (id) => `https://docs.google.com/spreadsheets/d/${id}/edit`,
};

/**
 * `google.sheet-create [name=<column>] [parent=<folder>] [share=<column>] [notify=yes|no]`:
 * creates one empty spreadsheet per row under the section's `root`, as the signed-in person,
 * and shares it with the people the row lists, as a plan a person applies.
 */
export function sheetCreateVerb(
  host: CreateHost,
  clock: WriteClock = systemClock,
): RecipeVerbContribution {
  return {
    id: SHEET_CREATE,
    kind: 'action',
    arguments: CREATE_ARGUMENTS,
    writes: [CREATE_WRITE, SHARE_WRITE],
    plan: (request) => planCreates(host, request, SPREADSHEET_KIND, clock),
    apply: (request) => applyCreates(host, request, clock),
  };
}
