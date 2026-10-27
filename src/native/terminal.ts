/**
 * Where a terminal's shell comes from. The rest of the app only sees the
 * TerminalBackend / TerminalSession interfaces in ../terminal/types.ts.
 *
 *  - android : a real shell on a pseudo-terminal, from the native plugin
 *              (PyTerminal: TerminalPlugin.kt + pty_*.c)
 *  - dev     : your desktop shell on a PTY, behind `npm run dev`'s bridge
 *              (utils/dev-bridge/pty_host.py), so the whole terminal can be
 *              developed and tested in a normal browser
 *  - none    : a plain static page: the terminal page explains why it can't run
 *
 * Output travels as raw bytes (not strings) so xterm.js decodes UTF-8 itself;
 * a character split across two chunks is then not corrupted.
 */
import type {
  TerminalBackend,
  TerminalExit,
  TerminalOpenOptions,
  TerminalSession,
} from "@/terminal/types";
import { postJson, readLines } from "./pyruntime";

/** The listener plumbing shared by every backend's session. */
class Session implements TerminalSession {
  private readonly dataCbs = new Set<(d: Uint8Array) => void>();
  private readonly exitCbs = new Set<(e: TerminalExit) => void>();
  /** Output that arrived before anyone listened (the shell prints its prompt immediately). */
  private early: Uint8Array[] = [];
  private _exited = false;
  private exitInfo: TerminalExit | null = null;
  readonly done: Promise<TerminalExit>;
  private resolveDone!: (e: TerminalExit) => void;

  constructor(
    private readonly io: {
      write(data: string): void;
      resize(cols: number, rows: number): void;
      close(): void;
    },
  ) {
    this.done = new Promise((resolve) => (this.resolveDone = resolve));
  }

  get exited(): boolean {
    return this._exited;
  }

  emitData(bytes: Uint8Array): void {
    if (this._exited && !this.dataCbs.size) return;
    if (this.dataCbs.size === 0) this.early.push(bytes);
    else for (const cb of this.dataCbs) cb(bytes);
  }

  emitExit(code: number): void {
    if (this._exited) return;
    this._exited = true;
    this.exitInfo = { code };
    for (const cb of this.exitCbs) cb(this.exitInfo);
    this.resolveDone(this.exitInfo);
  }

  onData(cb: (data: Uint8Array) => void): () => void {
    this.dataCbs.add(cb);
    if (this.early.length) {
      const pending = this.early;
      this.early = [];
      for (const chunk of pending) cb(chunk);
    }
    return () => void this.dataCbs.delete(cb);
  }

  onExit(cb: (exit: TerminalExit) => void): () => void {
    this.exitCbs.add(cb);
    if (this.exitInfo) cb(this.exitInfo);
    return () => void this.exitCbs.delete(cb);
  }

  write(data: string): void {
    if (!this._exited && data) this.io.write(data);
  }
  resize(cols: number, rows: number): void {
    if (!this._exited) this.io.resize(cols, rows);
  }
  close(): void {
    if (!this._exited) this.io.close();
  }
}

// ----------------------------------------------------------------- cordova

function exec<T>(action: string, args: unknown[]): Promise<T> {
  return new Promise((resolve, reject) =>
    cordova.exec<T>(resolve, reject, "PyTerminal", action, args),
  );
}

export function cordovaTerminalBackend(): TerminalBackend {
  return {
    kind: "android",
    shell: "/system/bin/sh",
    available: true,
    open(options: TerminalOpenOptions): TerminalSession {
      let id: string | null = null;
      const queued: Array<(id: string) => void> = [];
      const whenOpen = (fn: (id: string) => void): void => {
        if (id) fn(id);
        else queued.push(fn);
      };
      const session: Session = new Session({
        write: (d) =>
          whenOpen((i) => void exec("write", [i, d]).catch(() => {})),
        resize: (c, r) =>
          whenOpen((i) => void exec("resize", [i, c, r]).catch(() => {})),
        close: () => whenOpen((i) => void exec("close", [i]).catch(() => {})),
      });
      // One exec, many results: strings are control events, ArrayBuffers are output.
      cordova.exec<string | ArrayBuffer>(
        (msg) => {
          if (typeof msg === "string") {
            const ev = JSON.parse(msg) as {
              t: string;
              id?: string;
              code?: number;
            };
            if (ev.t === "open" && ev.id) {
              id = ev.id;
              for (const fn of queued.splice(0)) fn(ev.id);
            } else if (ev.t === "exit") session.emitExit(ev.code ?? 0);
          } else {
            session.emitData(new Uint8Array(msg));
          }
        },
        (err) => {
          const text = typeof err === "string" ? err : JSON.stringify(err);
          session.emitData(
            new TextEncoder().encode(
              `\r\n[could not start the shell: ${text}]\r\n`,
            ),
          );
          session.emitExit(-1);
        },
        "PyTerminal",
        "open",
        [JSON.stringify(options)],
      );
      return session;
    },
  };
}

// --------------------------------------------------------------------- dev

const BRIDGE = "/__py";

function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function devTerminalBackend(base = ""): TerminalBackend {
  const url = (p: string): string => `${base}${BRIDGE}${p}`;
  return {
    kind: "dev",
    shell: "your computer's shell",
    available: true,
    open(options: TerminalOpenOptions): TerminalSession {
      let id: string | null = null;
      const queued: Array<(id: string) => void> = [];
      const whenOpen = (fn: (id: string) => void): void => {
        if (id) fn(id);
        else queued.push(fn);
      };
      const post = (path: string, body: unknown): void =>
        whenOpen(
          (i) => void postJson(url(`/term/${i}/${path}`), body).catch(() => {}),
        );
      const session: Session = new Session({
        write: (d) => post("in", { d }),
        resize: (cols, rows) => post("resize", { cols, rows }),
        close: () => post("close", {}),
      });
      postJson(url("/term/open"), options)
        .then((res) =>
          readLines(res, (line) => {
            let ev: { t: string; id?: string; b?: string; code?: number };
            try {
              ev = JSON.parse(line);
            } catch {
              return;
            }
            if (ev.t === "open" && ev.id) {
              id = ev.id;
              for (const fn of queued.splice(0)) fn(ev.id);
            } else if (ev.t === "out" && ev.b)
              session.emitData(fromBase64(ev.b));
            else if (ev.t === "exit") session.emitExit(ev.code ?? 0);
          }),
        )
        .then(() => session.emitExit(137)) // stream closed without an exit event: the shell was killed
        .catch((err: Error) => {
          session.emitData(
            new TextEncoder().encode(
              `\r\n[terminal bridge error: ${err.message}]\r\n`,
            ),
          );
          session.emitExit(-1);
        });
      return session;
    },
  };
}

// -------------------------------------------------------------------- none

export function noneTerminalBackend(): TerminalBackend {
  return {
    kind: "none",
    shell: "",
    available: false,
    reason:
      "The terminal runs a shell on your device, so it is only available inside the PyForge Android app, or in a desktop browser started with `npm run dev` (which gives you a shell on your computer).",
    open(): TerminalSession {
      throw new Error("No terminal is available here.");
    },
  };
}

export function createTerminalBackend(
  runtimeKind: "android" | "dev" | "none",
): TerminalBackend {
  if (runtimeKind === "android") return cordovaTerminalBackend();
  if (runtimeKind === "dev") return devTerminalBackend();
  return noneTerminalBackend();
}
