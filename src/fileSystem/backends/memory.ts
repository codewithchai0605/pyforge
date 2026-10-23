import type { FileEntry, FileStats, FsOperation } from "../types";

/**
 * An in-memory filesystem under `mem://`, used when the app runs in a plain
 * desktop browser (`npm run dev`) where there is no Cordova file plugin. It
 * lets the whole editor (tree, tabs, new/rename/delete, run) be developed and
 * tested without a phone. Nothing is persisted across reloads.
 */

interface Node {
  isDirectory: boolean;
  content: string;
  modified: number;
}

export const MEMORY_SCHEME = "mem://";

const nodes = new Map<string, Node>();

function normalize(url: string): string {
  const path = url
    .slice(MEMORY_SCHEME.length)
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
  return MEMORY_SCHEME + path;
}

function parentOf(url: string): string {
  return url.slice(0, url.lastIndexOf("/"));
}

function nameOf(url: string): string {
  return url.slice(url.lastIndexOf("/") + 1);
}

function toEntry(url: string, node: Node): FileEntry {
  return {
    name: nameOf(url),
    isDirectory: node.isDirectory,
    url,
    size: node.isDirectory ? 0 : node.content.length,
    lastModified: node.modified,
    mimeType: null,
  };
}

function need(url: string): Node {
  const node = nodes.get(url);
  if (!node) throw new Error(`No such file or directory: ${url}`);
  return node;
}

function ensureDirectory(url: string): void {
  if (url === normalize(MEMORY_SCHEME) || nodes.get(url)?.isDirectory) return;
  nodes.set(url, { isDirectory: true, content: "", modified: Date.now() });
}

function childrenOf(url: string): string[] {
  return [...nodes.keys()].filter((k) => k !== url && parentOf(k) === url);
}

/** Creates `mem://workspace` (and parents) if missing. Used to bootstrap the preview. */
export function memoryEnsureDirectory(url: string): string {
  const u = normalize(url);
  const parts = u.slice(MEMORY_SCHEME.length).split("/");
  let cur = MEMORY_SCHEME.slice(0, -1);
  for (const part of parts) {
    cur += "/" + part;
    ensureDirectory(cur);
  }
  return u;
}

/** Every file under `rootUrl` as { relativePath: content } (for the dev Python bridge). */
export function memorySnapshot(rootUrl: string): Record<string, string> {
  const root = normalize(rootUrl) + "/";
  const out: Record<string, string> = {};
  for (const [url, node] of nodes) {
    if (!node.isDirectory && url.startsWith(root))
      out[url.slice(root.length)] = node.content;
  }
  return out;
}

export function memoryFs(rawUrl: string): FsOperation {
  const url = normalize(rawUrl);
  return {
    url,

    async exists() {
      return nodes.has(url) || url === normalize(MEMORY_SCHEME);
    },

    async stat(): Promise<FileStats> {
      const node = need(url);
      return { ...toEntry(url, node), canWrite: true };
    },

    async listDir() {
      if (!need(url).isDirectory) throw new Error(`Not a directory: ${url}`);
      return childrenOf(url).map((k) => toEntry(k, nodes.get(k)!));
    },

    async readFile() {
      const node = need(url);
      if (node.isDirectory) throw new Error(`Is a directory: ${url}`);
      return node.content;
    },

    async writeFile(content: string) {
      const node = need(url);
      node.content = content;
      node.modified = Date.now();
    },

    async createFile(name: string) {
      need(url);
      const child = `${url}/${name}`;
      if (nodes.has(child)) throw new Error(`${name} already exists`);
      const node: Node = {
        isDirectory: false,
        content: "",
        modified: Date.now(),
      };
      nodes.set(child, node);
      return toEntry(child, node);
    },

    async createDirectory(name: string) {
      need(url);
      const child = `${url}/${name}`;
      if (nodes.has(child)) throw new Error(`${name} already exists`);
      const node: Node = {
        isDirectory: true,
        content: "",
        modified: Date.now(),
      };
      nodes.set(child, node);
      return toEntry(child, node);
    },

    async delete() {
      need(url);
      for (const key of [...nodes.keys()]) {
        if (key === url || key.startsWith(url + "/")) nodes.delete(key);
      }
    },

    async rename(newName: string) {
      const node = need(url);
      const target = `${parentOf(url)}/${newName}`;
      if (nodes.has(target)) throw new Error(`${newName} already exists`);
      for (const key of [...nodes.keys()]) {
        if (key === url || key.startsWith(url + "/")) {
          const moved = target + key.slice(url.length);
          nodes.set(moved, nodes.get(key)!);
          nodes.delete(key);
        }
      }
      return toEntry(target, node);
    },
  };
}
