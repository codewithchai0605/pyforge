/**
 * Shared types for the terminal feature. Nothing in here touches the DOM or
 * xterm.js, so the transport (src/native/terminal.ts), the line editor and the
 * tests can all use it.
 */

export interface Disposable {
  dispose(): void;
}

export interface TerminalOpenOptions {
  cols: number;
  rows: number;
  /** Start directory. Defaults to the PyForge workspace. */
  cwd?: string;
  /** Program to run. Defaults to the platform shell. */
  shell?: string;
}

export interface TerminalExit {
  /** Exit status, or 128 + signal number if the shell was killed by a signal. */
  code: number;
}

/** One running shell on a pseudo-terminal. */
export interface TerminalSession {
  /** Output bytes from the shell (raw, so xterm decodes UTF-8 itself, even across chunk borders). */
  onData(cb: (data: Uint8Array) => void): () => void;
  onExit(cb: (exit: TerminalExit) => void): () => void;
  /** Keystrokes / pasted text, as the terminal would send them. */
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Hang up the shell. The exit is reported through `onExit`. */
  close(): void;
  readonly exited: boolean;
  readonly done: Promise<TerminalExit>;
}

export interface TerminalBackend {
  readonly kind: "android" | "dev" | "none";
  /** What runs inside, for display ("/system/bin/sh"). */
  readonly shell: string;
  readonly available: boolean;
  /** Why the terminal can't be used, shown on the page instead of a shell. */
  readonly reason?: string;
  open(options: TerminalOpenOptions): TerminalSession;
}

/** The read-only slice of xterm's buffer that link detection and word selection need. */
export interface BufferCellLike {
  getChars(): string;
  getWidth(): number;
}
export interface BufferLineLike {
  readonly isWrapped: boolean;
  readonly length: number;
  translateToString(trimRight?: boolean): string;
  getCell(x: number): BufferCellLike | undefined;
}
export interface BufferLike {
  readonly length: number;
  getLine(y: number): BufferLineLike | undefined;
}

/** A point in the terminal's buffer. `row` is absolute (scrollback included), both are 0-based. */
export interface CellPoint {
  col: number;
  row: number;
}
