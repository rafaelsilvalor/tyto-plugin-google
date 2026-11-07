import type { Disposable, PluginHost } from '@tyto/plugin-api';

import { sheetRowsVerb } from './sheet-rows.js';
import { sheetWriteVerb } from './sheet-write.js';

/**
 * The plugin's entry point: registers the recipe verbs, so far the `google.sheet-rows` source and
 * the `google.sheet-write` sink.
 * The other `google.sheet-*` and `google.drive-*` verbs arrive one pull request at a time.
 *
 * Nothing is read at activation: the service account and the project's `google`
 * section are resolved on every call of a verb, so a credential or a folder changed between two
 * runs is what the next run uses.
 */
export function activate(host: PluginHost): Disposable {
  const registered: Disposable[] = [
    host.registerRecipeVerb(sheetRowsVerb(host)),
    host.registerRecipeVerb(sheetWriteVerb(host)),
  ];
  return {
    dispose() {
      for (const registration of registered) registration.dispose();
    },
  };
}
