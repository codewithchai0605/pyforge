import { saf, type SafEntry } from "@/native/saf";
import type { FileEntry, FileStats, FsOperation } from "../types";

function toFileEntry(entry: SafEntry): FileEntry {
  return {
    name: entry.name ?? "",
    isDirectory: entry.isDirectory,
    url: entry.url,
    size: entry.size,
    lastModified: entry.lastModified,
    mimeType: entry.mimeType,
  };
}

function toFileStats(entry: SafEntry): FileStats {
  return {
    name: entry.name ?? "",
    isDirectory: entry.isDirectory,
    size: entry.size,
    lastModified: entry.lastModified,
    mimeType: entry.mimeType,
    canWrite: entry.canWrite,
  };
}

/** Backs any `content://...` URL — a SAF-managed document or tree root. */
export function externalFs(url: string): FsOperation {
  return {
    url,

    async exists() {
      try {
        await saf.stat(url);
        return true;
      } catch {
        return false;
      }
    },

    async stat() {
      return toFileStats(await saf.stat(url));
    },

    async listDir() {
      const entries = await saf.listDir(url);
      return entries.map(toFileEntry);
    },

    async readFile(encoding: "utf8" | "base64" = "utf8") {
      return saf.readFile(url, encoding);
    },

    async writeFile(content: string, encoding: "utf8" | "base64" = "utf8") {
      await saf.writeFile(url, content, encoding);
    },

    async createFile(name: string, mimeType?: string) {
      return toFileEntry(await saf.createFile(url, name, mimeType));
    },

    async createDirectory(name: string) {
      return toFileEntry(await saf.createDirectory(url, name));
    },

    async delete() {
      await saf.delete(url);
    },

    async rename(newName: string) {
      return toFileEntry(await saf.rename(url, newName));
    },
  };
}
