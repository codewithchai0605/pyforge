export {};

declare global {
  interface Window {
    cordova: {
      exec<T>(
        success: (result: T) => void,
        error: (err: unknown) => void,
        service: string,
        action: string,
        args: unknown[],
      ): void;
      platformId: string;
    };

    /**
     * From cordova-plugin-file. Only the subset this project's internalFs
     * backend actually uses is declared — see that plugin's own types if
     * you need more of its (much larger) surface.
     */
    resolveLocalFileSystemURL(
      url: string,
      successCallback: (entry: CordovaEntry) => void,
      errorCallback: (err: unknown) => void,
    ): void;
  }
  const cordova: Window["cordova"] & {
    file?: { dataDirectory: string; cacheDirectory: string };
  };

  interface CordovaMetadata {
    modificationTime: Date;
    size: number;
  }

  interface CordovaEntry {
    isFile: boolean;
    isDirectory: boolean;
    name: string;
    toURL(): string;
    getMetadata(
      success: (meta: CordovaMetadata) => void,
      error: (err: unknown) => void,
    ): void;
    getParent(
      success: (entry: CordovaDirectoryEntry) => void,
      error: (err: unknown) => void,
    ): void;
    remove(success: () => void, error: (err: unknown) => void): void;
    moveTo(
      parent: CordovaDirectoryEntry,
      newName: string | undefined,
      success: (entry: CordovaEntry) => void,
      error: (err: unknown) => void,
    ): void;
  }

  interface CordovaFileEntry extends CordovaEntry {
    file(success: (file: File) => void, error: (err: unknown) => void): void;
    createWriter(
      success: (writer: FileWriter) => void,
      error: (err: unknown) => void,
    ): void;
  }

  interface CordovaDirectoryReader {
    readEntries(
      success: (entries: CordovaEntry[]) => void,
      error: (err: unknown) => void,
    ): void;
  }

  interface CordovaDirectoryEntry extends CordovaEntry {
    removeRecursively(success: () => void, error: (err: unknown) => void): void;
    createReader(): CordovaDirectoryReader;
    getFile(
      path: string,
      options: { create?: boolean; exclusive?: boolean },
      success: (entry: CordovaFileEntry) => void,
      error: (err: unknown) => void,
    ): void;
    getDirectory(
      path: string,
      options: { create?: boolean; exclusive?: boolean },
      success: (entry: CordovaDirectoryEntry) => void,
      error: (err: unknown) => void,
    ): void;
  }

  /**
   * From the old (never fully standardized, now legacy) File API: Writer
   * spec — not part of TypeScript's built-in DOM lib, but still what
   * cordova-plugin-file's FileEntry.createWriter() actually returns.
   */
  interface FileWriter {
    write(data: Blob): void;
    truncate(size: number): void;
    seek(offset: number): void;
    onwriteend: ((event: ProgressEvent) => void) | null;
    onerror: ((event: unknown) => void) | null;
  }
}
