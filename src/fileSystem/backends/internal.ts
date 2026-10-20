import type { FileEntry, FileStats, FsOperation } from '../types';

/**
 * Backs any plain local URL cordova-plugin-file understands (app-private
 * storage, `file://` paths, `cdvfile://` URLs) — everything that ISN'T a
 * SAF `content://` document, which is externalFs's job instead. See
 * ../index.ts for how a URL ends up routed to one or the other.
 *
 * cordova-plugin-file's API predates Promises (callback pairs, paginated
 * directory reads, event-based FileWriter) — every function below exists
 * to turn exactly one piece of that into a Promise, nothing more.
 */

const EXTENSION_MIME_TYPES: Record<string, string> = {
  txt: 'text/plain',
  py: 'text/x-python',
  md: 'text/markdown',
  js: 'text/javascript',
  ts: 'text/typescript',
  json: 'application/json',
  html: 'text/html',
  css: 'text/css',
};

function guessMimeType(name: string): string | null {
  const ext = name.split('.').pop()?.toLowerCase();
  return (ext && EXTENSION_MIME_TYPES[ext]) ?? null;
}

function resolveEntry(url: string): Promise<CordovaEntry> {
  return new Promise((resolve, reject) => {
    window.resolveLocalFileSystemURL(url, resolve, reject);
  });
}

function getMetadata(entry: CordovaEntry): Promise<CordovaMetadata> {
  return new Promise((resolve, reject) => entry.getMetadata(resolve, reject));
}

/**
 * DirectoryReader.readEntries() is paginated by spec — a single call isn't
 * guaranteed to return everything, and it signals "done" by returning an
 * empty array, not by any explicit end marker. Keep calling until that
 * happens.
 */
async function readAllEntries(dir: CordovaDirectoryEntry): Promise<CordovaEntry[]> {
  const reader = dir.createReader();
  const all: CordovaEntry[] = [];
  let batch: CordovaEntry[];
  do {
    batch = await new Promise<CordovaEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    all.push(...batch);
  } while (batch.length > 0);
  return all;
}

async function toFileEntry(entry: CordovaEntry): Promise<FileEntry> {
  if (entry.isDirectory) {
    return { name: entry.name, isDirectory: true, url: entry.toURL(), size: 0, lastModified: 0, mimeType: null };
  }
  const meta = await getMetadata(entry);
  return {
    name: entry.name,
    isDirectory: false,
    url: entry.toURL(),
    size: meta.size,
    lastModified: meta.modificationTime.getTime(),
    mimeType: guessMimeType(entry.name),
  };
}

function base64ToBlob(base64: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes]);
}

function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(reader.result as string);
    reader.readAsText(file);
  });
}

function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      // readAsDataURL yields "data:<mime>;base64,<data>" — only the part
      // after the comma is the base64 payload callers actually asked for.
      const dataUrl = reader.result as string;
      resolve(dataUrl.slice(dataUrl.indexOf(',') + 1));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Overwrites a file's entire content. FileWriter.write() *appends* at the
 * current seek position by default — getting "replace" instead of "append"
 * means truncating to empty first and waiting for *that* operation's own
 * writeend event before starting the real write, not just firing both and
 * hoping they land in order.
 */
function overwriteWith(writer: FileWriter, blob: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    writer.onerror = (err) => reject(err);
    writer.onwriteend = () => {
      writer.onwriteend = () => resolve();
      writer.write(blob);
    };
    writer.truncate(0);
  });
}

export function internalFs(url: string): FsOperation {
  return {
    url,

    async exists() {
      try {
        await resolveEntry(url);
        return true;
      } catch {
        return false;
      }
    },

    async stat(): Promise<FileStats> {
      const entry = await resolveEntry(url);
      const fileEntry = await toFileEntry(entry);
      return { ...fileEntry, canWrite: true };
    },

    async listDir() {
      const entry = await resolveEntry(url);
      if (!entry.isDirectory) throw new Error(`Not a directory: ${url}`);
      const children = await readAllEntries(entry as CordovaDirectoryEntry);
      return Promise.all(children.map(toFileEntry));
    },

    async readFile(encoding: 'utf8' | 'base64' = 'utf8') {
      const entry = (await resolveEntry(url)) as CordovaFileEntry;
      const file = await new Promise<File>((resolve, reject) => entry.file(resolve, reject));
      return encoding === 'base64' ? readFileAsBase64(file) : readFileAsText(file);
    },

    async writeFile(content: string, encoding: 'utf8' | 'base64' = 'utf8') {
      const entry = (await resolveEntry(url)) as CordovaFileEntry;
      const writer = await new Promise<FileWriter>((resolve, reject) => entry.createWriter(resolve, reject));
      const blob = encoding === 'base64' ? base64ToBlob(content) : new Blob([content], { type: 'text/plain' });
      await overwriteWith(writer, blob);
    },

    async createFile(name: string) {
      const dir = (await resolveEntry(url)) as CordovaDirectoryEntry;
      const created = await new Promise<CordovaFileEntry>((resolve, reject) =>
        dir.getFile(name, { create: true, exclusive: true }, resolve, reject),
      );
      return toFileEntry(created);
    },

    async createDirectory(name: string) {
      const dir = (await resolveEntry(url)) as CordovaDirectoryEntry;
      const created = await new Promise<CordovaDirectoryEntry>((resolve, reject) =>
        dir.getDirectory(name, { create: true, exclusive: true }, resolve, reject),
      );
      return toFileEntry(created);
    },

    async delete() {
      const entry = await resolveEntry(url);
      // remove() refuses a non-empty directory; removeRecursively() is the
      // one that behaves like "delete this folder" from a user's point of view.
      if (entry.isDirectory) {
        const dir = entry as CordovaDirectoryEntry;
        await new Promise<void>((resolve, reject) => dir.removeRecursively(resolve, reject));
        return;
      }
      await new Promise<void>((resolve, reject) => entry.remove(resolve, reject));
    },

    async rename(newName: string) {
      const entry = await resolveEntry(url);
      const parent = await new Promise<CordovaDirectoryEntry>((resolve, reject) => entry.getParent(resolve, reject));
      const renamed = await new Promise<CordovaEntry>((resolve, reject) =>
        entry.moveTo(parent, newName, resolve, reject),
      );
      return toFileEntry(renamed);
    },
  };
}
