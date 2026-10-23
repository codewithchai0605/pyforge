import { externalFs } from "./backends/external";
import { internalFs } from "./backends/internal";
import { memoryFs, MEMORY_SCHEME } from "./backends/memory";
import type { FsOperation } from "./types";

/**
 * Every consumer of the file system goes through this one function —
 * nothing in the app ever imports a backend directly. Adding a future
 * backend (ftp://, sftp://) means adding one more branch here, not
 * touching any calling code.
 *
 * The dispatch rule: a `content://` URL is a SAF-managed document (see
 * externalFs) — that scheme is Android-specific and never collides with
 * anything cordova-plugin-file hands back (`file://`, `cdvfile://`, or a
 * bare app-private path), so a single prefix check is all this needs.
 */
export function fsOperation(url: string): FsOperation {
  if (url.startsWith("content://")) {
    return externalFs(url);
  }
  // In-memory files for the desktop browser preview (no Cordova there).
  if (url.startsWith(MEMORY_SCHEME)) {
    return memoryFs(url);
  }
  return internalFs(url);
}

export { memoryEnsureDirectory, memorySnapshot } from "./backends/memory";
export type { FileEntry, FileStats, FsOperation } from "./types";
