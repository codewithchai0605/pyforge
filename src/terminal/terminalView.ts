import { Terminal, type IDisposable, type ILinkProvider } from "@xterm/xterm";
import { ClipboardAddon } from "@xterm/addon-clipboard";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { Unicode11Addon } from "@xterm/addon-unicode11";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { KeyModifiers } from "@/editor/modifiers";
import {
  defaultClipboardBackend,
  type ClipboardBackend,
} from "@/native/device";
import { applyModifiers } from "./keys";
import {
  URL_RE,
  createLinkProvider,
  linkAt,
  type FoundLink,
  type LinkKind,
} from "./links";
import { terminalTheme } from "./theme";
import { TouchSelection } from "./touchSelection";
import type { BufferLike, CellPoint, Disposable } from "./types";
import { bufferText } from "./text";

/**
 * One xterm.js terminal, set up for a phone. Used for the shell sessions on
 * the Terminal page and for the program-output console.
 *
 * What it adds on top of bare xterm.js:
 *
 *   addons       fit (rows/cols follow the container), unicode11 (emoji and
 *                CJK widths), web-links (URLs), search, clipboard (OSC 52, so
 *                a program can set the clipboard), and optionally WebGL
 *   clipboard    Copy / Paste go through the native clipboard, because the
 *                web clipboard API cannot read inside an Android WebView
 *   keyboard     Ctrl+Shift+C/V, Ctrl+Insert / Shift+Insert, Ctrl+C copies
 *                when something is selected (and is an interrupt otherwise),
 *                Ctrl+V pastes; sticky Ctrl/Alt from the key bar apply to
 *                characters typed on the soft keyboard
 *   touch        long-press selection with handles and a Copy/Paste bar
 *                (touchSelection.ts), tap on a link to open it
 *   layout       xterm is only opened once its container has a size (a
 *                terminal opened while hidden measures its font as 0 wide)
 *                and re-fitted whenever the container changes size
 */

export interface TerminalViewOptions {
  fontSize: number;
  scrollback?: number;
  /** Treat a bare "\n" as "\r\n". Right for program output, wrong for a PTY (which already sends "\r\n"). */
  convertEol?: boolean;
  cursorBlink?: boolean;
  webgl?: boolean;
  clipboard?: ClipboardBackend;
  /** Where "Copied" / "Clipboard is empty" go (the app wires this to a toast). */
  notify?: (message: string, kind: "info" | "error" | "success") => void;
  /** Open a web link. */
  openUrl?: (url: string) => void;
  /** Set to make `File "x.py", line N` lines tappable. */
  onTraceback?: (path: string, line: number) => void;
  /** Called on a tap that did not hit a link (the owner decides about the keyboard). */
  onTap?: () => void;
  /** Line height multiplier. */
  lineHeight?: number;
}

const FONT_FAMILY =
  '"JetBrains Mono", "Roboto Mono", "Cascadia Mono", "Noto Sans Mono", Menlo, Consolas, monospace';

export class TerminalView {
  readonly el: HTMLElement;
  readonly term: Terminal;
  readonly search = new SearchAddon();
  /** Sticky Ctrl / Alt for characters typed on the soft keyboard. Shared with this view's key bar. */
  readonly modifiers = new KeyModifiers();

  private readonly host: HTMLElement;
  private readonly fit = new FitAddon();
  private readonly clipboard: ClipboardBackend;
  private touch: TouchSelection | null = null;
  private webgl: WebglAddon | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private fitQueued = false;
  private opened = false;
  private disposed = false;
  private inputEnabled = true;
  private resolveReady!: (size: { cols: number; rows: number }) => void;
  private readonly ready = new Promise<{ cols: number; rows: number }>(
    (resolve) => (this.resolveReady = resolve),
  );
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly linkKinds = new Set<LinkKind>(["url"]);
  private readonly lastUrlTap = { at: 0 };

  constructor(private readonly opts: TerminalViewOptions) {
    this.clipboard = opts.clipboard ?? defaultClipboardBackend();
    if (opts.onTraceback) this.linkKinds.add("traceback");

    this.host = document.createElement("div");
    this.host.className = "pf-term-host";
    this.el = document.createElement("div");
    this.el.className = "pf-term";
    this.el.append(this.host);

    this.term = new Terminal({
      allowProposedApi: true, // unicode11 and search decorations
      fontFamily: FONT_FAMILY,
      fontSize: opts.fontSize,
      lineHeight: opts.lineHeight ?? 1.18,
      scrollback: opts.scrollback ?? 5000,
      convertEol: opts.convertEol ?? false,
      cursorBlink: opts.cursorBlink ?? true,
      cursorStyle: "block",
      smoothScrollDuration: 0,
      macOptionIsMeta: true,
      rightClickSelectsWord: true,
      theme: terminalTheme(),
    });

    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = "11";
    this.term.loadAddon(
      new WebLinksAddon((_event, uri) => this.openUrl(uri), {
        urlRegex: URL_RE,
      }),
    );
    this.term.loadAddon(
      new ClipboardAddon(undefined, {
        readText: () => this.clipboard.read(),
        writeText: (_selection, text) => this.clipboard.write(text),
      }),
    );
    if (opts.onTraceback)
      this.term.registerLinkProvider(
        createLinkProvider(this.term, new Set<LinkKind>(["traceback"]), (l) =>
          this.activate(l),
        ),
      );

    this.term.onData((data) => {
      // Sticky Ctrl/Alt turn one typed character into a control code.
      const out = applyModifiers(data, this.modifiers.take());
      this.touch?.dismiss();
      for (const cb of this.dataListeners) cb(out);
    });
    this.term.attachCustomKeyEventHandler((e) => this.handleKey(e));

    // The element must have a size before xterm can measure its font.
    if (typeof ResizeObserver === "function") {
      this.resizeObserver = new ResizeObserver(() => this.scheduleFit());
      this.resizeObserver.observe(this.host);
    }
    this.scheduleFit();
  }

  // --------------------------------------------------------- lifecycle

  private openNow(): void {
    if (this.opened || this.disposed) return;
    this.opened = true;
    this.term.open(this.host);
    this.setWebgl(this.opts.webgl ?? false);

    const ta = this.term.textarea;
    if (ta) {
      // A terminal wants raw keys, not a phone keyboard's help.
      ta.setAttribute("autocapitalize", "off");
      ta.setAttribute("autocomplete", "off");
      ta.setAttribute("autocorrect", "off");
      ta.setAttribute("spellcheck", "false");
      ta.setAttribute("enterkeyhint", "send");
      ta.inputMode = this.inputEnabled ? "text" : "none";
    }
    if (this.term.element) {
      this.touch = new TouchSelection({
        term: this.term,
        target: this.term.element,
        overlay: this.el,
        actions: {
          copy: () => void this.copy(),
          paste: () => void this.paste(),
          selectAll: () => this.selectAll(),
        },
        onTap: (cell) => this.tap(cell),
      });
    }
  }

  private scheduleFit(): void {
    if (this.fitQueued || this.disposed) return;
    this.fitQueued = true;
    const run = (): void => {
      this.fitQueued = false;
      this.fitNow();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 0);
  }

  /** Opens (first time) and resizes the terminal to its container. Returns false while the container has no size. */
  fitNow(): boolean {
    if (this.disposed) return false;
    if (this.host.clientWidth < 24 || this.host.clientHeight < 24) return false;
    if (!this.opened) this.openNow();
    const dims = this.fit.proposeDimensions();
    if (
      !dims ||
      !Number.isFinite(dims.cols) ||
      !Number.isFinite(dims.rows) ||
      dims.cols < 2 ||
      dims.rows < 1
    )
      return false;
    if (dims.cols !== this.term.cols || dims.rows !== this.term.rows)
      this.term.resize(dims.cols, dims.rows);
    this.resolveReady({ cols: this.term.cols, rows: this.term.rows });
    return true;
  }

  /** Resolves with the first size the terminal really had on screen. */
  whenReady(): Promise<{ cols: number; rows: number }> {
    return this.ready;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.resizeObserver?.disconnect();
    this.touch?.dispose();
    this.term.dispose();
    this.el.remove();
  }

  // ----------------------------------------------------------- surface

  get cols(): number {
    return this.term.cols;
  }
  get rows(): number {
    return this.term.rows;
  }
  get buffer(): BufferLike {
    return this.term.buffer.active as unknown as BufferLike;
  }

  write(data: string | Uint8Array, done?: () => void): void {
    this.term.write(data, done);
  }

  cursorX(): number {
    return this.term.buffer.active.cursorX;
  }

  text(): string {
    return bufferText(this.buffer);
  }

  /** Erase the screen and the scrollback. Ordered with earlier writes. */
  clear(): void {
    this.term.write("\x1bc\x1b[3J");
  }

  onData(cb: (data: string) => void): Disposable {
    this.dataListeners.add(cb);
    return { dispose: () => void this.dataListeners.delete(cb) };
  }

  onResize(cb: (size: { cols: number; rows: number }) => void): IDisposable {
    return this.term.onResize(cb);
  }

  onTitle(cb: (title: string) => void): IDisposable {
    return this.term.onTitleChange(cb);
  }

  registerLinkProvider(provider: ILinkProvider): IDisposable {
    return this.term.registerLinkProvider(provider);
  }

  /** Types `data` as the user would (key bar buttons, programmatic input). */
  send(data: string): void {
    this.term.input(data, true);
  }

  /** Arrow keys etc. depend on whether a full-screen program asked for application mode. */
  get applicationCursor(): boolean {
    return this.term.modes.applicationCursorKeysMode;
  }

  focus(): void {
    if (this.opened) this.term.focus();
  }

  blur(): void {
    this.term.blur();
  }

  /** Whether the keyboard should come up on tap. When false the terminal can still be scrolled and selected. */
  setInputEnabled(on: boolean): void {
    this.inputEnabled = on;
    const ta = this.term.textarea;
    if (ta) ta.inputMode = on ? "text" : "none";
    if (!on) this.term.blur();
  }

  setFontSize(size: number): void {
    this.term.options.fontSize = size;
    this.scheduleFit();
  }

  setWebgl(on: boolean): void {
    if (on === (this.webgl !== null)) return;
    if (!on) {
      this.webgl?.dispose();
      this.webgl = null;
      return;
    }
    if (!this.opened) return; // applied when the terminal is opened
    try {
      const addon = new WebglAddon();
      // A lost GL context leaves a blank terminal; fall back to the DOM renderer.
      addon.onContextLoss(() => {
        addon.dispose();
        if (this.webgl === addon) this.webgl = null;
      });
      this.term.loadAddon(addon);
      this.webgl = addon;
    } catch {
      this.webgl = null; // no WebGL here: the default renderer stays
    }
  }

  // --------------------------------------------------------- clipboard

  hasSelection(): boolean {
    return this.term.hasSelection();
  }

  getSelection(): string {
    return this.term.getSelection();
  }

  selectAll(): void {
    this.term.selectAll();
  }

  clearSelection(): void {
    this.touch?.dismiss();
    this.term.clearSelection();
  }

  private notify(message: string, kind: "info" | "error" | "success"): void {
    this.opts.notify?.(message, kind);
  }

  /** Copies the selection. Resolves false if there was nothing to copy or the clipboard refused. */
  async copy(clearAfter = true): Promise<boolean> {
    const text = this.term.getSelection();
    if (!text) {
      this.notify("Nothing selected.", "info");
      return false;
    }
    try {
      await this.clipboard.write(text);
    } catch (e) {
      this.notify(e instanceof Error ? e.message : "Could not copy.", "error");
      return false;
    }
    this.notify("Copied", "success");
    if (clearAfter) this.clearSelection();
    return true;
  }

  /** Pastes the clipboard as typed input (bracketed if the program asked for it, newlines as Enter). */
  async paste(): Promise<boolean> {
    let text: string;
    try {
      text = await this.clipboard.read();
    } catch (e) {
      this.notify(e instanceof Error ? e.message : "Could not paste.", "error");
      return false;
    }
    if (!text) {
      this.notify("The clipboard is empty.", "info");
      return false;
    }
    this.touch?.dismiss();
    this.term.paste(text);
    if (this.inputEnabled) this.focus();
    return true;
  }

  // ------------------------------------------------------------- keys

  private handleKey(e: KeyboardEvent): boolean {
    if (e.type !== "keydown") return true;
    const key = e.key.toLowerCase();
    const mod = e.ctrlKey || e.metaKey;
    const handled = (run: () => void): false => {
      e.preventDefault();
      run();
      return false; // xterm must not also send it to the shell
    };

    if (mod && e.shiftKey && key === "c")
      return handled(() => void this.copy(false));
    if (mod && e.shiftKey && key === "v")
      return handled(() => void this.paste());
    if (mod && e.shiftKey && key === "a")
      return handled(() => this.selectAll());
    if (e.ctrlKey && !e.shiftKey && e.key === "Insert")
      return handled(() => void this.copy(false));
    if (e.shiftKey && !e.ctrlKey && e.key === "Insert")
      return handled(() => void this.paste());
    // Ctrl+C is "interrupt" for a shell, but with text selected it is almost
    // surely "copy" (as in VS Code's terminal). Cmd+C/V on a Mac keyboard.
    if (
      !e.shiftKey &&
      !e.altKey &&
      key === "c" &&
      mod &&
      this.term.hasSelection()
    )
      return handled(() => void this.copy());
    if (!e.shiftKey && !e.altKey && key === "v" && mod)
      return handled(() => void this.paste());
    return true;
  }

  // -------------------------------------------------------------- links

  private openUrl(uri: string): void {
    // The web-links addon and our own tap handler can both see the same tap.
    const now = Date.now();
    if (now - this.lastUrlTap.at < 400) return;
    this.lastUrlTap.at = now;
    if (this.opts.openUrl) this.opts.openUrl(uri);
    else window.open(uri, "_blank", "noopener");
  }

  private activate(link: FoundLink): void {
    if (link.kind === "url" && link.url) this.openUrl(link.url);
    else if (link.kind === "traceback" && link.path && link.line)
      this.opts.onTraceback?.(link.path, link.line);
  }

  /** A touch that was a tap: open the link under it, otherwise let the owner decide (usually: show the keyboard). */
  private tap(cell: CellPoint): void {
    const link = linkAt(this.buffer, cell, this.term.cols);
    if (link && this.linkKinds.has(link.kind)) return this.activate(link);
    this.opts.onTap?.();
    if (this.inputEnabled) this.focus();
  }
}
