import { signal, type Signal } from "xtags";
import type { Settings } from "@/settings";
import { TerminalView } from "./terminalView";
import type {
  TerminalBackend,
  TerminalSession,
} from "./types";

/**
 * The open shells. They live here, not in the Terminal page, so leaving the
 * page (Back) does not kill what is running in them: the page is just a
 * window onto this list.
 *
 * Each tab pairs one TerminalView (what you see) with one TerminalSession
 * (the shell on a PTY). The glue is small:
 *
 *   shell output  -> view.write      (raw bytes: xterm decodes UTF-8 itself)
 *   keystrokes    -> session.write
 *   view resized  -> session.resize  (debounced: the keyboard animating in
 *                                     would otherwise send a resize per frame)
 *   shell exits   -> a note in the terminal; Enter starts a new shell
 */

export type TabStatus = "starting" | "running" | "exited";

export interface ShellTab {
  readonly id: number;
  readonly title: Signal<string>;
  readonly status: Signal<TabStatus>;
  readonly exitCode: Signal<number | null>;
  readonly view: TerminalView;
}

export interface TerminalManagerOptions {
  backend: TerminalBackend;
  settings: Pick<Settings, "terminalFontSize" | "terminalWebgl">;
  notify(message: string, kind: "info" | "error" | "success"): void;
  openUrl(url: string): void;
  /** Where new shells start. */
  cwd?: string;
  /** A `File "x.py", line N` line was tapped in a shell. */
  onTraceback?(path: string, line: number): void;
}

const GREY = "\x1b[90m";
const RED = "\x1b[91m";
const RESET = "\x1b[0m";
const RESIZE_DELAY_MS = 80;

interface Live {
  session: TerminalSession;
  stop(): void;
}

export class TerminalManager {
  readonly tabs = signal<ShellTab[]>([]);
  readonly active = signal<ShellTab | null>(null);
  private nextId = 1;
  private readonly live = new Map<number, Live>();
  /** Tabs the user has named: the shell's own window title (OSC 0/2) no longer overrides them. */
  private readonly renamed = new Set<number>();

  constructor(private readonly o: TerminalManagerOptions) { }

  get backend(): TerminalBackend {
    return this.o.backend;
  }

  /** Makes sure at least one shell exists (the Terminal page calls this when it opens). */
  ensureOne(): ShellTab | null {
    if (!this.o.backend.available) return null;
    return this.active.peek() ?? this.create();
  }

  create(): ShellTab {
    const id = this.nextId++;
    const view = new TerminalView({
      fontSize: this.o.settings.terminalFontSize.peek(),
      scrollback: 10000,
      convertEol: false, // a PTY already sends CR LF
      webgl: this.o.settings.terminalWebgl.peek(),
      onFontSize: (size) => this.o.settings.terminalFontSize.set(size),
      notify: this.o.notify,
      openUrl: this.o.openUrl,
      onTraceback: this.o.onTraceback,
    });
    const tab: ShellTab = {
      id,
      title: signal(`Shell ${id}`),
      status: signal<TabStatus>("starting"),
      exitCode: signal<number | null>(null),
      view,
    };
    view.onTitle((t) => {
      if (this.renamed.has(id)) return;
      const clean = t.trim();
      tab.title.set(clean ? clean.slice(0, 40) : `Shell ${id}`);
    });
    // Enter after the shell has ended starts a new one.
    view.onData((data) => {
      if (tab.status.peek() === "exited" && /^[\r\n]/.test(data)) this.restart(tab);
    });
    this.tabs.update((all) => [...all, tab]);
    this.active.set(tab);
    // Only start the shell once the terminal knows how big it is: the shell
    // reads its size at startup and some programs never ask again.
    void view.whenReady().then(({ cols, rows }) => this.start(tab, cols, rows));
    return tab;
  }

  /**
   * Gives a tab a name of the user's choosing. Naming it "Shell N" (its own
   * default) or clearing the name gives control of the title back to the shell.
   */
  rename(tab: ShellTab, title: string | null): void {
    const name = (title ?? "").trim().slice(0, 40);
    if (name && name !== `Shell ${tab.id}`) {
      this.renamed.add(tab.id);
      tab.title.set(name);
    } else {
      this.renamed.delete(tab.id);
      tab.title.set(`Shell ${tab.id}`);
    }
  }

  select(id: number): void {
    const tab = this.tabs.peek().find((t) => t.id === id);
    if (!tab) return;
    this.active.set(tab);
    // A tab that was hidden may have been resized meanwhile.
    tab.view.fitNow();
  }

  /** Ends the shell and removes the tab. Closing the last tab opens a fresh one. */
  close(id: number): void {
    const all = this.tabs.peek();
    const index = all.findIndex((t) => t.id === id);
    if (index < 0) return;
    const tab = all[index]!;
    this.renamed.delete(id);
    this.stop(tab);
    tab.view.dispose();
    const rest = all.filter((t) => t.id !== id);
    this.tabs.set(rest);
    if (this.active.peek() === tab) this.active.set(rest[Math.min(index, rest.length - 1)] ?? null);
    if (rest.length === 0 && this.o.backend.available) this.create();
  }

  /** Starts a new shell in the same terminal (after the old one ended, or to replace a stuck one). */
  restart(tab: ShellTab): void {
    this.stop(tab);
    tab.view.write("\x1bc");
    tab.status.set("starting");
    tab.exitCode.set(null);
    void tab.view.whenReady().then(() => this.start(tab, tab.view.cols, tab.view.rows));
  }

  closeAll(): void {
    for (const tab of [...this.tabs.peek()]) {
      this.stop(tab);
      tab.view.dispose();
    }
    this.tabs.set([]);
    this.active.set(null);
  }

  /** Applies a settings change to every open terminal. */
  applyAppearance(): void {
    for (const tab of this.tabs.peek()) {
      tab.view.setFontSize(this.o.settings.terminalFontSize.peek());
      tab.view.setWebgl(this.o.settings.terminalWebgl.peek());
    }
  }

  // ----------------------------------------------------------------- internals

  private start(tab: ShellTab, cols: number, rows: number): void {
    // The tab may have been closed while waiting for its size.
    if (!this.tabs.peek().includes(tab)) return;
    let session: TerminalSession;
    try {
      session = this.o.backend.open({ cols, rows, cwd: this.o.cwd });
    } catch (e) {
      tab.status.set("exited");
      tab.exitCode.set(-1);
      tab.view.write(
        `${RED}Could not start a shell: ${e instanceof Error ? e.message : String(e)}${RESET}\r\n`,
      );
      return;
    }
    const typed = tab.view.onData((data) => session.write(data));
    const subscriptions: Array<() => void> = [
      session.onData((bytes) => tab.view.write(bytes)),
      () => typed.dispose(),
    ];
    let timer: ReturnType<typeof setTimeout> | undefined;
    const resize = tab.view.onResize(({ cols: c, rows: r }) => {
      clearTimeout(timer);
      timer = setTimeout(() => session.resize(c, r), RESIZE_DELAY_MS);
    });
    this.live.set(tab.id, {
      session,
      stop: () => {
        clearTimeout(timer);
        for (const s of subscriptions) s();
        resize.dispose();
      },
    });
    tab.status.set("running");
    subscriptions.push(
      session.onExit(({ code }) => {
        // Release the listeners now; the session itself is already gone.
        this.live.get(tab.id)?.stop();
        this.live.delete(tab.id);
        tab.status.set("exited");
        tab.exitCode.set(code);
        tab.view.write(
          `\r\n${GREY}[Shell ended (exit ${code}). Press Enter to start a new one.]${RESET}\r\n`,
        );
      }),
    );
  }

  private stop(tab: ShellTab): void {
    const live = this.live.get(tab.id);
    if (!live) return;
    this.live.delete(tab.id);
    live.stop();
    live.session.close();
  }
}