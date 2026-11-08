import { googleOk, type GoogleResult } from './errors.js';
import { getFile, type DriveFile } from './drive-files.js';
import type { GoogleClient } from './http.js';

/**
 * How far above a file the walk looks for the root, as Buraqueira's `dentro_da_raiz` does: a
 * file six folders down is under it, one deeper reads as outside, and a Drive whose parents
 * loop (which Drive should never answer, but a walk must not trust) ends here too.
 */
export const MAX_LEVELS = 6;

/** Where a file stands against the root, and the file as Drive described it. */
export type RootVerdict =
  | { readonly under: true; readonly file: DriveFile }
  | { readonly under: false; readonly file: DriveFile; readonly why: string };

/**
 * A walk from files up to one root folder, with a memo: the folders a plan's files share are
 * read once, so a hundred files of one inbox cost a hundred reads and not six hundred.
 */
export interface RootWalk {
  readonly client: GoogleClient;
  /** Whether `fileId` is the root or under it, at most {@link MAX_LEVELS} parents up. */
  verdict(fileId: string): Promise<GoogleResult<RootVerdict>>;
  /** A file's description, read once per walk. */
  describe(fileId: string): Promise<GoogleResult<DriveFile>>;
}

export function rootWalk(client: GoogleClient, rootId: string): RootWalk {
  const described = new Map<string, DriveFile>();
  /**
   * What earlier walks learnt of a folder: how many levels it sits under the root, or why it is
   * not under it. A depth is kept rather than a yes, so a deeper file reaching a known folder is
   * still held to {@link MAX_LEVELS}.
   */
  const known = new Map<string, number | string>();

  async function describe(fileId: string): Promise<GoogleResult<DriveFile>> {
    const kept = described.get(fileId);
    if (kept !== undefined) return googleOk(kept);
    const read = await getFile(client, fileId);
    if (read.ok) described.set(fileId, read.value);
    return read;
  }

  async function verdict(fileId: string): Promise<GoogleResult<RootVerdict>> {
    const file = await describe(fileId);
    if (!file.ok) return file;
    const path: string[] = [];
    const seen = new Set<string>();
    let current = fileId;
    /** Levels from the file to the root, or why the root is not above it. */
    let found: number | string | undefined;
    for (let level = 0; found === undefined; level += 1) {
      if (current === rootId) {
        found = level;
        break;
      }
      const memo = known.get(current);
      if (memo !== undefined) {
        found = typeof memo === 'number' ? level + memo : memo;
        break;
      }
      if (seen.has(current)) {
        found = `its parents loop back to ${current}`;
        break;
      }
      seen.add(current);
      path.push(current);
      if (level === MAX_LEVELS) break;
      const step = await describe(current);
      if (!step.ok) return step;
      const parent = step.value.parents[0];
      if (parent === undefined) {
        found = 'it is not under the root folder';
        break;
      }
      current = parent;
    }
    // A walk cut at the depth limit learnt nothing it may keep: the folders above are unread.
    if (found !== undefined) {
      for (const [level, each] of path.entries()) {
        known.set(each, typeof found === 'number' ? found - level : found);
      }
    }
    if (typeof found === 'number' && found <= MAX_LEVELS) {
      return googleOk({ under: true, file: file.value });
    }
    const why =
      typeof found === 'string' ? found : `the root is not within ${MAX_LEVELS} folders above it`;
    return googleOk({ under: false, file: file.value, why });
  }

  return { client, verdict, describe };
}
