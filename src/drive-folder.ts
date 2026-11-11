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
import { FOLDER_MIME_TYPE } from './drive-query.js';
import { systemClock, type WriteClock } from './sheet-write-apply.js';

export const DRIVE_FOLDER = 'google.drive-folder';

export const FOLDER_KIND: CreateKind = {
  verb: DRIVE_FOLDER,
  noun: 'folder',
  mimeType: FOLDER_MIME_TYPE,
  link: (id) => `https://drive.google.com/drive/folders/${id}`,
};

/**
 * `google.drive-folder [name=<column>] [parent=<folder>] [share=<column>] [notify=yes|no]`:
 * creates one folder per row under the section's `root`, as the signed-in person, and shares
 * it with the people the row lists, as a plan a person applies.
 */
export function driveFolderVerb(
  host: CreateHost,
  clock: WriteClock = systemClock,
): RecipeVerbContribution {
  return {
    id: DRIVE_FOLDER,
    kind: 'action',
    arguments: CREATE_ARGUMENTS,
    writes: [CREATE_WRITE, SHARE_WRITE],
    plan: (request) => planCreates(host, request, FOLDER_KIND, clock),
    apply: (request) => applyCreates(host, request, clock),
  };
}
