import {
    ConsoleView,
    type ConsoleCallbacks,
    type ConsoleLike,
} from "./consoleView";

export interface ConsoleSwitchOptions {
    callbacks: ConsoleCallbacks;
    /** Builds the terminal-style console. May throw if xterm.js cannot start. */
    createTerminal(callbacks: ConsoleCallbacks): ConsoleLike & { applyAppearance?(): void };
    /** Told when the terminal console could not be created and the classic one is used instead. */
    onFallback?(error: unknown): void;
}

/**
 * One console the rest of the app talks to, backed by either the terminal
 * console or the classic one, switchable while the app runs (Settings ->
 * "Terminal-style console"). Switching starts the new console empty.
 *
 * The terminal console is built the first time it is wanted. If that fails
 * (a WebView without what xterm.js needs) the classic console stays in place,
 * so a problem in the new code can never leave the app without a console.
 */
export class ConsoleSwitch implements ConsoleLike {
    readonly el: HTMLElement;
    private classic: ConsoleView | null = null;
    private terminal: (ConsoleLike & { applyAppearance?(): void }) | null = null;
    private terminalFailed = false;
    private current: ConsoleLike;

    constructor(private readonly o: ConsoleSwitchOptions) {
        this.el = document.createElement("div");
        this.el.className = "console-switch";
        this.current = this.ensureClassic();
        this.el.append(this.current.el);
    }

    private ensureClassic(): ConsoleView {
        return (this.classic ??= new ConsoleView(this.o.callbacks));
    }

    /** Which console is showing. */
    get style(): "terminal" | "classic" {
        return this.current === this.terminal ? "terminal" : "classic";
    }

    /** Picks the console. Returns the style actually in use (the terminal one may be unavailable). */
    use(wanted: "terminal" | "classic"): "terminal" | "classic" {
        let next: ConsoleLike = this.ensureClassic();
        if (wanted === "terminal" && !this.terminalFailed) {
            try {
                this.terminal ??= this.o.createTerminal(this.o.callbacks);
                next = this.terminal;
            } catch (e) {
                this.terminalFailed = true;
                this.o.onFallback?.(e);
            }
        }
        if (next !== this.current) {
            this.current.hideInput();
            this.current = next;
            this.el.replaceChildren(next.el);
            next.clear();
        }
        return this.style;
    }

    /** The terminal console reads text size / renderer from settings. */
    applyAppearance(): void {
        this.terminal?.applyAppearance?.();
    }

    write(kind: "out" | "err", text: string): void {
        this.current.write(kind, text);
    }
    system(text: string, tone?: "info" | "ok" | "error"): void {
        this.current.system(text, tone);
    }
    clear(): void {
        this.current.clear();
    }
    finish(): void {
        this.current.finish();
    }
    text(): string {
        return this.current.text();
    }
    showInput(prompt?: string): void {
        this.current.showInput(prompt);
    }
    hideInput(): void {
        this.current.hideInput();
    }
    get waitingForInput(): boolean {
        return this.current.waitingForInput;
    }
}