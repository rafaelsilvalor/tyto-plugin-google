import type { Disposable, PluginHost } from '@tyto/plugin-api';

/**
 * The plugin's entry point. This first version registers nothing: the manifest, the build and
 * the checks come first, and each verb arrives with its own pull request (the
 * `google.sheet-*` and `google.drive-*` verbs, over a service account).
 *
 * Nothing will be read at activation either: the service account and the project's `google`
 * section are resolved on every call of a verb, so a credential or a folder changed between two
 * runs is what the next run uses.
 */
export function activate(_host: PluginHost): Disposable {
  const registered: Disposable[] = [];
  return {
    dispose() {
      for (const registration of registered) registration.dispose();
    },
  };
}
