import type { PluginHost } from '@tyto/plugin-api';

import { fingerprint } from './cursor.js';

/**
 * The id `google.drive-upload` generated for a folder it plans to create, kept in the plugin's
 * private cache (Tyto ADR 0138) by the folder it goes in and its name (TYTO-758).
 *
 * Two readers need it before the folder exists:
 *
 * - **The upload's next plan** reuses it, so planning again before Apply keeps one address
 *   instead of handing out a new one each run.
 * - **`google.drive-url` below the upload** answers that address while the folder is not in
 *   Drive yet: an action answers a plan and cannot add a column, so the link reaches the cells
 *   below through the transform. Under `apply together` (Tyto ADR 0219) a sheet write or a
 *   tracker comment below is planned before the upload applies, and carries the link anyway.
 *
 * The cache is the plugin's, not a verb's: the host keys it by the plugin's name alone
 * (`cache/plugins/<plugin>/`). Once the upload creates the folder, the entry is forgotten and
 * the real folder answers. **The cache never fails a step**: a host with none keeps nothing,
 * and the upload plans a fresh id as it did before.
 */
export type PlannedFolderHost = Pick<PluginHost, 'cache'>;

/** The cache key of the folder named `name` planned in the folder `parentId`. */
export function plannedFolderKey(parentId: string, name: string): string {
  return `planned-folder/${fingerprint(JSON.stringify([parentId, name]))}`;
}

const DRIVE_ID = /^[A-Za-z0-9_-]{10,}$/;

/** The id kept for that folder, or `undefined` when none is (or the cache cannot be read). */
export async function plannedFolderId(
  host: PlannedFolderHost,
  parentId: string,
  name: string,
): Promise<string | undefined> {
  try {
    const entry = await host.cache.get(plannedFolderKey(parentId, name));
    if (entry === undefined) return undefined;
    const id = new TextDecoder().decode(entry.bytes);
    return DRIVE_ID.test(id) ? id : undefined;
  } catch {
    return undefined;
  }
}

export async function rememberPlannedFolder(
  host: PlannedFolderHost,
  parentId: string,
  name: string,
  id: string,
): Promise<void> {
  try {
    await host.cache.put(plannedFolderKey(parentId, name), id);
  } catch {
    // Kept nothing: the next plan generates another id, as before TYTO-758.
  }
}

export async function forgetPlannedFolder(
  host: PlannedFolderHost,
  parentId: string,
  name: string,
): Promise<void> {
  try {
    await host.cache.delete(plannedFolderKey(parentId, name));
  } catch {
    // Nothing to do: an entry left behind names a folder that now exists, and is not read.
  }
}
