import type { ConsoleCallbacks, ConsoleLike } from "@/components/consoleView";
import { LineEditor } from "./lineEditor";
import type { Disposable } from "./types";

/**
 * The program-output console, drawn by xterm.js instead of by hand.
 *
 * Output gets the real terminal treatment for free: colours, `\r` progress
 * bars, cursor movement, wrapping, scrollback, selection, links. Reading
 * (`input()`, `sys.stdin`, the REPL) is the part a terminal would normally get
 * from a PTY and the Python runner does not have, so it is done here by a
 * LineEditor: type in the terminal itself, with editing and history, and the
 * line goes to the program when you press Enter.
 *
 *   Ctrl+C   while the program is running: stops it (like the Stop button)
 *   Ctrl+D   at an empty prompt: end of input (EOF)
 *
 * It implements the same ConsoleLike interface as the classic ConsoleView, so
 * the rest of the app does not know which one it is talking to.
 */

/** The part of TerminalView this class uses (so tests can use a bare xterm engine). */
export interface ConsoleSurface {
  readonly el: HTMLElement;
  readonly cols: number;
  write(data: string, done?: () => void): void;
  cursorX(): number;
  clear(): void;
  text(): string;
  onData(cb: (data: string) => void): Disposable;
  setInputEnabled(on: boolean): void;
  focus(): void;
}

export interface TerminalConsoleOptions {
  /** A row of extra keys (^C, ^D, arrows...) shown only while the program waits for input. */
  keyRow?: HTMLElement;
}

// Colours for stderr and PyForge's own lines. These are SGR codes on purpose:
// the terminal's theme (src/terminal/theme.ts) decides the actual colour.
const RED = "\x1b[91m";
const GREEN = "\x1b[32m";
const GREY = "\x1b[90m";
const RESET = "\x1b[0m";

const CSI_AT_END = /(?:\x1b\[[0-?]*[ -/]*[@-~])+$/;

/** Does the cursor end up at the start of a line after `text` was printed? */
export function endsAtLineStart(text: string, before: boolean): boolean {
  const visible = text.replace(CSI_AT_END, "");
  if (visible === "") return before;
  const last = visible[visible.length - 1];
  return last === "\n" || last === "\r";
}

export class TerminalConsole implements ConsoleLike {
  readonly el: HTMLElement;
  private readonly editor: LineEditor;
  private readonly history: string[] = [];
  private waiting = false;
  /** Between showInput() and the moment the prompt has really been drawn. */
  private starting = false;
  private queuedKeys: string[] = [];
  /** Typed ahead or pasted past the first line: replayed at the next prompt. */
  private pending = "";
  private atLineStart = true;
  private readonly keyRow: HTMLElement | undefined;

  constructor(
    private readonly callbacks: ConsoleCallbacks,
    private readonly surface: ConsoleSurface,
    options: TerminalConsoleOptions = {},
  ) {
    this.keyRow = options.keyRow;
    if (this.keyRow) this.keyRow.hidden = true;
    this.el = document.createElement("div");
    this.el.className = "term-console";
    this.el.append(surface.el);
    if (this.keyRow) this.el.append(this.keyRow);
    this.editor = new LineEditor(surface, { history: this.history });
    surface.setInputEnabled(false);
    surface.onData((data) => this.onKeys(data));
  }

  // ------------------------------------------------------------ output

  write(kind: "out" | "err", text: string): void {
    if (!text) return;
    if (kind === "err") {
      // A program's own colour resets (`\x1b[0m`) must not turn the rest of
      // the error text white again.
      const body = text.replace(/\x1b\[0?m/g, `${RESET}${RED}`);
      this.surface.write(`${RED}${body}${RESET}`);
    } else {
      this.surface.write(text);
    }
    this.atLineStart = endsAtLineStart(text, this.atLineStart);
  }

  system(text: string, tone: "info" | "ok" | "error" = "info"): void {
    const color = tone === "ok" ? GREEN : tone === "error" ? RED : GREY;
    // A program that stopped mid-line (a prompt, say) must not run into the message.
    const lead = this.atLineStart ? "" : "\r\n";
    this.surface.write(`${lead}${RESET}${color}${text}${RESET}\r\n`);
    this.atLineStart = true;
  }

  clear(): void {
    this.surface.clear();
    this.atLineStart = true;
    if (this.waiting) {
      // The prompt is gone with everything else; keep what was typed.
      const typed = this.editor.text;
      this.editor.start(0, typed);
    }
  }

  finish(): void {
    this.hideInput();
  }

  text(): string {
    return this.surface.text();
  }

  // ------------------------------------------------------------- input

  get waitingForInput(): boolean {
    return this.waiting;
  }

  showInput(_prompt = ""): void {
    this.waiting = true;
    this.starting = true;
    this.surface.setInputEnabled(true);
    if (this.keyRow) this.keyRow.hidden = false;
    // The prompt was written just before this call but xterm parses writes
    // later; wait until it has, so the cursor column is the real one.
    this.surface.write("", () => {
      if (!this.waiting) return; // the program ended in the meantime
      this.starting = false;
      this.editor.start(this.surface.cursorX());
      this.surface.focus();
      const keys = this.queuedKeys.splice(0).join("");
      const replay = this.pending + keys;
      this.pending = "";
      if (replay) this.handle(replay);
    });
  }

  hideInput(): void {
    this.waiting = false;
    this.starting = false;
    this.queuedKeys = [];
    this.pending = "";
    this.editor.stop();
    this.surface.setInputEnabled(false);
    if (this.keyRow) this.keyRow.hidden = true;
  }

  private onKeys(data: string): void {
    if (!this.waiting) {
      // Nobody is reading. Ctrl+C still means "stop the program".
      if (data.includes("\x03")) this.callbacks.onInterrupt?.();
      return;
    }
    if (this.starting) this.queuedKeys.push(data);
    else this.handle(data);
  }

  private handle(data: string): void {
    const { event, rest } = this.editor.feed(data);
    if (!event) return;
    this.atLineStart = true; // the editor ended the line with a line break
    if (event.type === "submit") {
      this.waiting = false;
      this.surface.setInputEnabled(false);
      if (this.keyRow) this.keyRow.hidden = true;
      this.pending = rest; // the next prompt picks it up
      this.callbacks.onInput(event.text + "\n");
    } else if (event.type === "eof") {
      this.hideInput();
      this.callbacks.onInput(null);
    } else {
      this.hideInput();
      this.callbacks.onInterrupt?.();
    }
  }
}
