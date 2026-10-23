/**
 * Thin, typed wrapper around `cordova.exec` calls into the "SAF" native
 * plugin (src/native-plugins/cordova-plugin-saf). Every method here maps 1:1 to an action string handled by
 * SafPlugin.java.
 */

export interface SafEntry {
  url: string;
  name: string | null;
  isDirectory: boolean;
  size: number;
  lastModified: number;
  mimeType: string | null;
  canWrite: boolean;
}

export interface PersistedFolder {
  url: string;
  name: string | null;
}

function exec<T>(action: string, args: unknown[] = []): Promise<T> {
  return new Promise((resolve, reject) => {
    cordova.exec<T>(resolve, reject, "SAF", action, args);
  });
}

export const saf = {
  /** Launches Android's folder picker (ACTION_OPEN_DOCUMENT_TREE) and
   *  returns the picked folder's persistent tree URI. Rejects if the user
   *  cancels or the granted folder isn't writable. */
  pickFolder(): Promise<string> {
    return exec<string>("pickFolder");
  },

  /** Folders previously picked whose read+write grant is still valid —
   *  use this to restore "recent folders" across app launches instead of
   *  re-prompting the picker every time. */
  listPersistedFolders(): Promise<PersistedFolder[]> {
    return exec<PersistedFolder[]>("listPersistedFolders");
  },

  /** Forgets a previously granted folder (it'll disappear from
   *  listPersistedFolders() and the picker would need to run again). */
  releaseFolder(url: string): Promise<void> {
    return exec<void>("releaseFolder", [url]);
  },

  stat(url: string): Promise<SafEntry> {
    return exec<SafEntry>("stat", [url]);
  },

  listDir(url: string): Promise<SafEntry[]> {
    return exec<SafEntry[]>("listDir", [url]);
  },

  readFile(url: string, encoding: "utf8" | "base64" = "utf8"): Promise<string> {
    return exec<string>("readFile", [url, encoding]);
  },

  writeFile(
    url: string,
    content: string,
    encoding: "utf8" | "base64" = "utf8",
  ): Promise<void> {
    return exec<void>("writeFile", [url, content, encoding]);
  },

  createFile(
    parentUrl: string,
    name: string,
    mimeType = "text/plain",
  ): Promise<SafEntry> {
    return exec<SafEntry>("createFile", [parentUrl, name, mimeType]);
  },

  createDirectory(parentUrl: string, name: string): Promise<SafEntry> {
    return exec<SafEntry>("createDirectory", [parentUrl, name]);
  },

  delete(url: string): Promise<void> {
    return exec<void>("delete", [url]);
  },

  /** The returned entry's `url` may differ from the original — SAF doesn't
   *  guarantee a rename keeps the same URI, see SafPlugin.java's rename(). */
  rename(url: string, newName: string): Promise<SafEntry> {
    return exec<SafEntry>("rename", [url, newName]);
  },
};
