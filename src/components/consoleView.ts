import { AnsiParser, type AnsiStyle, type AnsiToken } from "@/python/ansi";

export interface ConsoleCallbacks {
  /** A line the user submitted at the input row (includes the trailing "\n"), or null for EOF. */
  onInput(text: string | null): void;
  /** A traceback location was tapped. */
  onJump(path: string, line: number): void;
  /** Ctrl+C in the terminal-style console: stop the running program. */
  onInterrupt?(): void;
}

/**
 * What the run panel and main.ts need from a console. Two implementations:
 * ConsoleView below (the classic DOM console) and TerminalConsole
 * (src/terminal/terminalConsole.ts, xterm.js).
 */
export interface ConsoleLike {
  readonly el: HTMLElement;
  /** Append program output. `kind` selects stdout vs stderr styling. */
  write(kind: "out" | "err", text: string): void;
  /** A line from PyForge itself (not the program): "Running main.py", exit status, etc. */
  system(text: string, tone?: "info" | "ok" | "error"): void;
  clear(): void;
  /** End of program: release held-back characters and hide the input. */
  finish(): void;
  /** Plain text of everything shown (for tests). */
  text(): string;
  /** Show the input row / start reading a line: the program is blocked on stdin. */
  showInput(prompt?: string): void;
  hideInput(): void;
  readonly waitingForInput: boolean;
}

const MAX_LINES = 4000;
const TRACEBACK = /File "(.+?)", line (\d+)/;

/**
 * The console's text surface. Imperative DOM on purpose: a script printing
 * 20,000 lines must not go through a reactive framework per character.
 *
 * Model: a column of `.cl` line elements; `current` is the line being
 * written. "\r" arms an overwrite, so the *next* text wipes the line first
 * (progress bars); "\n" closes the line and starts a new one.
 */
export class ConsoleView implements ConsoleLike {
  readonly el: HTMLElement;
  private readonly log: HTMLElement;
  private readonly inputRow: HTMLFormElement;
  private readonly input: HTMLInputElement;
  private readonly promptLabel: HTMLElement;
  private readonly parsers = { out: new AnsiParser(), err: new AnsiParser() };
  private current!: HTMLElement;
  private overwrite = false;
  private stickToBottom = true;
  private scrollQueued = false;

  constructor(private readonly callbacks: ConsoleCallbacks) {
    this.log = document.createElement("div");
    this.log.className = "console-log";
    this.log.setAttribute("role", "log");
    this.log.setAttribute("aria-live", "off"); // announcing every printed line would drown a screen reader
    this.log.tabIndex = 0;

    this.promptLabel = document.createElement("span");
    this.promptLabel.className = "console-prompt";
    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.className = "console-input";
    this.input.setAttribute("autocapitalize", "off");
    this.input.setAttribute("autocomplete", "off");
    this.input.setAttribute("autocorrect", "off");
    this.input.setAttribute("spellcheck", "false");
    this.input.setAttribute("enterkeyhint", "send");
    this.input.setAttribute("aria-label", "Program input");

    const send = document.createElement("button");
    send.type = "submit";
    send.className = "btn btn-small btn-primary";
    send.textContent = "Send";
    const eof = document.createElement("button");
    eof.type = "button";
    eof.className = "btn btn-small";
    eof.textContent = "EOF";
    eof.title = "Send end-of-input (Ctrl+D)";
    eof.addEventListener("click", () => this.submit(null));

    this.inputRow = document.createElement("form");
    this.inputRow.className = "console-input-row";
    this.inputRow.hidden = true;
    this.inputRow.append(this.promptLabel, this.input, send, eof);
    this.inputRow.addEventListener("submit", (e) => {
      e.preventDefault();
      this.submit(this.input.value);
    });

    this.el = document.createElement("div");
    this.el.className = "console";
    this.el.append(this.log, this.inputRow);

    this.log.addEventListener("scroll", () => {
      this.stickToBottom =
        this.log.scrollTop + this.log.clientHeight >=
        this.log.scrollHeight - 24;
    });
    this.log.addEventListener("click", (e) => {
      const link = (e.target as HTMLElement).closest<HTMLElement>(".tb-link");
      if (link?.dataset.path)
        this.callbacks.onJump(link.dataset.path, Number(link.dataset.line));
    });
    this.clear();
  }

  // ------------------------------------------------------------ output

  /** Append program output. `kind` selects stdout vs stderr styling. */
  write(kind: "out" | "err", text: string): void {
    this.apply(this.parsers[kind].push(text), kind);
    this.scheduleScroll();
  }

  /** A line from PyForge itself (not the program): "Running main.py", exit status, etc. */
  system(text: string, tone: "info" | "ok" | "error" = "info"): void {
    // Reuse the current line if it's empty; otherwise the program left an
    // unterminated line (e.g. a prompt) and the message starts on a fresh one.
    if (this.current.textContent) this.current = this.newLine();
    const line = this.current;
    line.classList.add("sys", `sys-${tone}`);
    line.textContent = text;
    this.current = this.newLine();
    this.scheduleScroll();
  }

  clear(): void {
    this.log.replaceChildren();
    this.parsers.out = new AnsiParser();
    this.parsers.err = new AnsiParser();
    this.overwrite = false;
    this.stickToBottom = true;
    this.current = this.newLine();
  }

  /** End of program: release held-back characters. */
  finish(): void {
    for (const kind of ["out", "err"] as const)
      this.apply(this.parsers[kind].flush(), kind);
    this.hideInput();
  }

  /** Plain text of the log (for "copy"/tests). */
  text(): string {
    return [...this.log.children]
      .map((l) => l.textContent ?? "")
      .join("\n")
      .replace(/\n+$/, "");
  }

  // ------------------------------------------------------------- input

  /** Show the input row: the program is blocked on stdin. */
  showInput(prompt = ""): void {
    this.promptLabel.textContent = "";
    this.promptLabel.hidden = true;
    this.input.placeholder = prompt.trim()
      ? prompt.trim()
      : "Type here and press Enter";
    this.inputRow.hidden = false;
    this.input.value = "";
    // Defer: the row has just become visible, and focusing raises the keyboard.
    setTimeout(() => this.input.focus(), 30);
    this.scheduleScroll();
  }

  hideInput(): void {
    this.inputRow.hidden = true;
    this.input.blur();
  }

  get waitingForInput(): boolean {
    return !this.inputRow.hidden;
  }

  private submit(text: string | null): void {
    if (text === null) {
      this.hideInput();
      this.callbacks.onInput(null);
      return;
    }
    // Echo what was typed onto the line the program's prompt is on, as a terminal does.
    this.appendText(
      text,
      {
        fg: null,
        bg: null,
        bold: false,
        dim: false,
        italic: false,
        underline: false,
      },
      "in",
    );
    this.current = this.newLine();
    this.hideInput();
    this.callbacks.onInput(text + "\n");
    this.scheduleScroll();
  }

  // --------------------------------------------------------- internals

  private newLine(): HTMLElement {
    const line = document.createElement("div");
    line.className = "cl";
    this.log.appendChild(line);
    while (this.log.childElementCount > MAX_LINES)
      this.log.firstElementChild?.remove();
    return line;
  }

  private apply(tokens: AnsiToken[], kind: "out" | "err" | "in"): void {
    for (const token of tokens) {
      switch (token.type) {
        case "text":
          this.appendText(token.text, token.style, kind);
          break;
        case "lf":
          this.closeLine();
          break;
        case "cr":
          this.overwrite = true;
          break;
        case "clear-line":
          this.current.replaceChildren();
          break;
      }
    }
  }

  private closeLine(): void {
    this.overwrite = false;
    this.linkify(this.current);
    this.current = this.newLine();
  }

  private appendText(
    text: string,
    style: AnsiStyle,
    kind: "out" | "err" | "in",
  ): void {
    if (this.overwrite) {
      this.current.replaceChildren();
      this.overwrite = false;
    }
    const span = document.createElement("span");
    if (kind !== "out") span.className = kind === "err" ? "err" : "echo";
    if (style.fg) span.style.color = style.fg;
    if (style.bg) span.style.backgroundColor = style.bg;
    if (style.bold) span.style.fontWeight = "700";
    if (style.dim) span.style.opacity = "0.65";
    if (style.italic) span.style.fontStyle = "italic";
    if (style.underline) span.style.textDecoration = "underline";
    span.textContent = text;
    this.current.appendChild(span);
  }

  /** Make `File "x.py", line 3` lines tappable. */
  private linkify(line: HTMLElement): void {
    const m = TRACEBACK.exec(line.textContent ?? "");
    if (!m) return;
    line.classList.add("tb-link");
    line.dataset.path = m[1]!;
    line.dataset.line = m[2]!;
    line.title = "Open in editor";
  }

  private scheduleScroll(): void {
    if (this.scrollQueued || !this.stickToBottom) return;
    this.scrollQueued = true;
    const go = (): void => {
      this.scrollQueued = false;
      this.log.scrollTop = this.log.scrollHeight;
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(go);
    else go();
  }
}