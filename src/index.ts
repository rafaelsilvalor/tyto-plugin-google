import type { Disposable, PluginHost } from '@tyto/plugin-api';

import { driveCountVerb } from './drive-count.js';
import { driveFolderVerb } from './drive-folder.js';
import { driveListVerb } from './drive-list.js';
import { driveMoveVerb } from './drive-move.js';
import { driveReadVerb } from './drive-read.js';
import { sheetCreateVerb } from './sheet-create.js';
import { sheetLookupVerb } from './sheet-lookup.js';
import { sheetRowsVerb } from './sheet-rows.js';
import { sheetSyncVerb } from './sheet-sync.js';
import { sheetWriteVerb } from './sheet-write.js';

/**
 * The plugin's entry point: registers the recipe verbs: the `google.sheet-rows`,
 * `google.drive-list` and `google.drive-read` sources, the `google.sheet-write` and
 * `google.sheet-sync` sinks, the `google.drive-move`, `google.drive-folder` and `google.sheet-create` actions, and the
 * `google.drive-count` and `google.sheet-lookup` transforms.
 *
 * Nothing is read at activation: the service account and the project's `google`
 * section are resolved on every call of a verb, so a credential or a folder changed between two
 * runs is what the next run uses.
 */
export function activate(host: PluginHost): Disposable {
  const registered: Disposable[] = [
    host.registerRecipeVerb(sheetRowsVerb(host)),
    host.registerRecipeVerb(sheetWriteVerb(host)),
    host.registerRecipeVerb(sheetSyncVerb(host)),
    host.registerRecipeVerb(driveListVerb(host)),
    host.registerRecipeVerb(driveReadVerb(host)),
    host.registerRecipeVerb(driveMoveVerb(host)),
    host.registerRecipeVerb(driveFolderVerb(host)),
    host.registerRecipeVerb(sheetCreateVerb(host)),
    host.registerRecipeVerb(driveCountVerb(host)),
    host.registerRecipeVerb(sheetLookupVerb(host)),
  ];
  return {
    dispose() {
      for (const registration of registered) registration.dispose();
    },
  };
}
