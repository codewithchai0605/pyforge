/**
 * A directory entry as returned by FsOperation.listDir() — enough
 * information to render a file browser without a second round-trip per
 * entry.
 */
export interface FileEntry {
  name: string;
  isDirectory: boolean;
  /** Backend-specific identifier for this entry (a content:// URI for the
   *  external/SAF backend, a plain path for the internal one) — pass this
   *  straight back into fsOperation() to act on it. */
  url: string;
  size: number;
  lastModified: number;
  mimeType: string | null;
}

/** Metadata for a single file/directory, without listing its children. */
export interface FileStats {
  name: string;
  isDirectory: boolean;
  size: number;
  lastModified: number;
  mimeType: string | null;
  canWrite: boolean;
}

/**
 * The operations every backend must implement. `fsOperation(url)` (see
 * ./index.ts) picks the right backend based on `url`'s shape and returns
 * an object satisfying this interface bound to that specific url — so
 * calling code never needs to know or care which backend it's talking to.
 */
export interface FsOperation {
  readonly url: string;

  exists(): Promise<boolean>;
  stat(): Promise<FileStats>;

  /** Only valid when stat().isDirectory is true. */
  listDir(): Promise<FileEntry[]>;

  readFile(encoding?: "utf8" | "base64"): Promise<string>;
  writeFile(content: string, encoding?: "utf8" | "base64"): Promise<void>;

  createFile(name: string, mimeType?: string): Promise<FileEntry>;
  createDirectory(name: string): Promise<FileEntry>;

  delete(): Promise<void>;
  rename(newName: string): Promise<FileEntry>;
}

/** What a backend module exports — a factory bound to one url. */
export type FsBackend = (url: string) => FsOperation;
