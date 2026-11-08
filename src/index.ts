import type { Disposable, PluginHost } from '@tyto/plugin-api';

import { driveListVerb } from './drive-list.js';
import { driveReadVerb } from './drive-read.js';
import { sheetRowsVerb } from './sheet-rows.js';
import { sheetSyncVerb } from './sheet-sync.js';
import { sheetWriteVerb } from './sheet-write.js';

/**
 * The plugin's entry point: registers the recipe verbs, so far the `google.sheet-rows`,
 * `google.drive-list` and `google.drive-read` sources and the `google.sheet-write` and
 * `google.sheet-sync` sinks. `google.drive-move` and `google.drive-count` arrive next.
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
  ];
  return {
    dispose() {
      for (const registration of registered) registration.dispose();
    },
  };
}
