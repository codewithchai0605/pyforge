import { fsOperation, type FileEntry } from "./index";

export interface WalkedFile {
  url: string;
  name: string;
  /** Slash-separated path relative to the root that was walked (e.g.
   *  "src/main.ts") — for display only. Always use `url` to re-open or
   *  re-read the file, since that's the identifier each backend actually
   *  understands (a content:// URI for SAF, a plain path internally). */
  path: string;
}

export interface WalkResult {
  files: WalkedFile[];
  /** True if the walk stopped early after hitting maxFiles — `files` is a
   *  prefix of the tree, not the complete listing. */
  truncated: boolean;
}

/**
 * Directory names skipped by default: build output and tooling directories
 * that are almost never what someone means by "search my files", and that
 * can be large enough to make an unfiltered walk slow (this project's own
 * node_modules/www/platforms among them). Pass `ignoreDirNames: []` to walk
 * everything instead.
 */
export const DEFAULT_IGNORED_DIR_NAMES = [
  ".git",
  "node_modules",
  "target",
  "www",
  "platforms",
  "plugins",
];

const DEFAULT_MAX_FILES = 500;

/**
 * Recursively lists every file (not directory) under `rootUrl`, depth-first,
 * across whichever filesystem backend `rootUrl` belongs to — `fsOperation()`
 * picks that automatically (see fileSystem/index.ts), so this doesn't care
 * whether it's SAF or the internal backend.
 *
 * Stops after `maxFiles` regardless of how much of the tree remains, so an
 * unexpectedly large or deep folder can't make a caller (multi-file search,
 * currently the only caller) hang. Directories it can't read (permissions,
 * a race with some other app editing the same folder) are skipped rather
 * than failing the whole walk.
 */
export async function walkFiles(
  rootUrl: string,
  options: { maxFiles?: number; ignoreDirNames?: string[] } = {},
): Promise<WalkResult> {
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const ignore = new Set(options.ignoreDirNames ?? DEFAULT_IGNORED_DIR_NAMES);

  const files: WalkedFile[] = [];
  let truncated = false;

  async function walk(url: string, path: string): Promise<void> {
    if (truncated) return;
    let entries: FileEntry[];
    try {
      entries = await fsOperation(url).listDir();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      const entryPath = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isDirectory) {
        if (ignore.has(entry.name)) continue;
        await walk(entry.url, entryPath);
      } else {
        files.push({ url: entry.url, name: entry.name, path: entryPath });
        if (files.length >= maxFiles) {
          truncated = true;
          return;
        }
      }
    }
  }

  await walk(rootUrl, "");
  return { files, truncated };
}
