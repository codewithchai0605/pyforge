import {
  fsOperation,
  memoryEnsureDirectory,
  memorySnapshot,
} from "@/fileSystem";
import type { PyRuntime, RunRequest, RuntimeInfo } from "@/python/protocol";
import { DEFAULT_FILE } from "@/python/templates";

/**
 * The workspace is the folder PyForge treats as "my projects".
 *
 *  - On a phone it is a real directory in the app's private storage that the
 *    Python process can open by ordinary path (`.../files/projects`). That's
 *    why imports of sibling modules and file I/O work.
 *  - In the desktop preview it is an in-memory folder (`mem://workspace`);
 *    its files are shipped to the dev bridge on every run.
 *
 * Files from elsewhere (an Android folder opened through the Storage Access
 * Framework, `content://`) can't be opened by path from Python, so those run
 * from a scratch copy of the current buffer instead.
 */
export interface Workspace {
  /** URL of the workspace folder in the editor's filesystem. */
  readonly rootUrl: string;
  readonly kind: "android" | "dev";
  /** Everything Python needs to run this file. `code` is the current buffer. */
  buildRunRequest(url: string | null, name: string, code: string): RunRequest;
  /** Maps a path from a Python traceback back to a file URL in the editor, if it is one of ours. */
  urlForPythonPath(path: string): string | null;
  /** Human-readable path of `url` inside the workspace ("src/app.py"), or null if outside it. */
  relativePath(url: string): string | null;
}

const MEM_ROOT = "mem://workspace";

function resolveEntry(url: string): Promise<CordovaEntry> {
  return new Promise((resolve, reject) =>
    window.resolveLocalFileSystemURL(url, resolve, reject),
  );
}

/** Makes sure `<dataDirectory>/projects/` exists and returns its URL (with trailing slash). */
async function ensureAndroidRoot(): Promise<string> {
  const base = cordova.file?.dataDirectory;
  if (!base) throw new Error("cordova-plugin-file is not available");
  const parent = (await resolveEntry(base)) as CordovaDirectoryEntry;
  const dir = await new Promise<CordovaDirectoryEntry>((resolve, reject) =>
    parent.getDirectory("projects", { create: true }, resolve, reject),
  );
  const url = dir.toURL();
  return url.endsWith("/") ? url : url + "/";
}

async function seedIfEmpty(rootUrl: string): Promise<void> {
  const entries = await fsOperation(rootUrl).listDir();
  if (entries.some((e) => !e.name.startsWith("."))) return;
  const file = await fsOperation(rootUrl).createFile(DEFAULT_FILE.filename);
  await fsOperation(file.url).writeFile(DEFAULT_FILE.content);
}

export async function createWorkspace(
  runtime: PyRuntime,
  info: RuntimeInfo | null,
): Promise<Workspace> {
  if (runtime.kind === "android") {
    const rootUrl = await ensureAndroidRoot();
    await seedIfEmpty(rootUrl);
    const rootPath =
      info?.projects ??
      decodeURIComponent(rootUrl.replace(/^file:\/\//, "")).replace(/\/$/, "");
    const scratch = `${rootPath}/.scratch`;
    return {
      rootUrl,
      kind: "android",
      relativePath: (url) =>
        url.startsWith(rootUrl)
          ? decodeURIComponent(url.slice(rootUrl.length))
          : null,
      urlForPythonPath: (p) =>
        p.startsWith(rootPath + "/")
          ? rootUrl +
            p
              .slice(rootPath.length + 1)
              .split("/")
              .map(encodeURIComponent)
              .join("/")
          : null,
      buildRunRequest(url, name, code) {
        if (url && url.startsWith(rootUrl)) {
          const abs = `${rootPath}/${decodeURIComponent(url.slice(rootUrl.length))}`;
          return { path: abs, cwd: abs.slice(0, abs.lastIndexOf("/")) };
        }
        // content:// or never-saved: run the buffer from a scratch location.
        return {
          path: `${scratch}/${name || "untitled.py"}`,
          code,
          cwd: rootPath,
        };
      },
    };
  }

  const rootUrl = memoryEnsureDirectory(MEM_ROOT);
  await seedIfEmpty(rootUrl);
  const hostRoot = info?.projects ?? "";
  return {
    rootUrl,
    kind: "dev",
    relativePath: (url) =>
      url.startsWith(rootUrl + "/") ? url.slice(rootUrl.length + 1) : null,
    urlForPythonPath: (p) =>
      hostRoot && p.startsWith(hostRoot + "/")
        ? `${rootUrl}/${p.slice(hostRoot.length + 1)}`
        : null,
    buildRunRequest(url, name, code) {
      const files = memorySnapshot(rootUrl);
      const rel =
        url && url.startsWith(rootUrl + "/")
          ? url.slice(rootUrl.length + 1)
          : `.scratch/${name || "untitled.py"}`;
      files[rel] = code; // the live buffer, saved or not
      const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
      return { path: rel, cwd: dir, files };
    },
  };
}
