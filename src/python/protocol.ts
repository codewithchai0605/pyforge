/**
 * Types for everything that crosses the WebView <-> Python boundary.
 * Mirrors the event protocol documented in
 * src/native-plugins/cordova-plugin-pyruntime/src/android/python/pyforge/core.py.
 */

/** A turtle drawing command: [opcode, ...args]. See shims/turtle.py's header. */
export type TurtleCmd = [string, ...unknown[]];

export type PyEvent =
  | { t: "started"; python: string }
  | { t: "out"; s: string }
  | { t: "err"; s: string }
  | { t: "input"; prompt: string }
  | { t: "gui"; cmds: TurtleCmd[] }
  | { t: "img"; path: string; title?: string }
  | { t: "exit"; code: number; ms: number };

/** Events the UI sends back into a running program. */
export type GuiEvent =
  | { k: "click"; x: number; y: number }
  | { k: "key"; key: string; down: boolean }
  | { k: "close" }
  | { k: "answer"; id: number; value: string | null };

export interface RunRequest {
  mode?: "script" | "repl";
  /** Absolute filesystem path of the script (what Python's __file__ will be). */
  path?: string;
  /** Run this text instead of reading `path` (used for unsaved SAF files). */
  code?: string;
  cwd?: string;
  args?: string[];
  /** Browser-preview only: every in-memory project file, so imports work. */
  files?: Record<string, string>;
}

export interface RuntimeInfo {
  python: string;
  android: boolean;
  abi: string | null;
  api: number;
  cp: string;
  site: string;
  /** Absolute path of the folder PyForge treats as its workspace. */
  projects: string;
}

export interface InstalledPackage {
  name: string;
  version: string;
  removable: boolean;
  summary: string;
  requires: string[];
}

export type LookupResult =
  | {
      status: "ok";
      name: string;
      version: string;
      kind: "pure" | "native";
      source: string;
      size: number | null;
      installed: string | null;
      filename: string;
      note: string | null;
    }
  | {
      status: "not_found" | "no_android_wheel" | "no_wheel";
      name: string;
      message: string;
    };

export interface PipProgress {
  t: "log" | "dl";
  s?: string;
  file?: string;
  done?: number;
  total?: number;
}

export interface RunHandle {
  /** Send a line to the program's stdin; `null` sends EOF (Ctrl-D). */
  stdin(text: string | null): void;
  gui(event: GuiEvent): void;
  /** Hard-stop the program. Resolves once the exit event was delivered. */
  stop(): Promise<void>;
  /** Resolves with the exit event. */
  done: Promise<Extract<PyEvent, { t: "exit" }>>;
}

export interface Insets {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PipApi {
  list(): Promise<InstalledPackage[]>;
  lookup(spec: string): Promise<LookupResult>;
  install(
    specs: string[],
    onProgress: (p: PipProgress) => void,
  ): Promise<{
    installed: { name: string; version: string }[];
    skipped: string[];
  }>;
  uninstall(
    name: string,
    onProgress: (p: PipProgress) => void,
  ): Promise<{ removed: string; files: number; dependents: string[] }>;
  /**
   * Stop the install/uninstall in progress. The pending promise rejects with a
   * PipError whose `cancelled` is true. Cancelling an install never leaves a
   * half-installed package behind.
   */
  cancel(): void;
}

export interface PyRuntime {
  /** 'android' = embedded Chaquopy; 'dev' = desktop Python behind the dev server; 'none' = nothing available. */
  readonly kind: "android" | "dev" | "none";
  init(): Promise<RuntimeInfo>;
  run(req: RunRequest, onEvent: (event: PyEvent) => void): RunHandle;
  /** A URL an <img> can display for a plot file the program wrote. */
  imageUrl(path: string): Promise<string>;
  /** Padding (CSS px) the page must add for system bars the WebView does not already avoid; null if unknown. */
  insets(): Promise<Insets | null>;
  readonly pip: PipApi;
}

/** Thrown by pip operations; `message` is safe to show to the user as-is. */
export class PipError extends Error {
  constructor(
    message: string,
    /** True when the user cancelled (not a failure). */
    readonly cancelled = false,
  ) {
    super(message);
  }
}
