import type { ConsoleCallbacks, ConsoleLike } from "@/components/consoleView";
import { openExternal } from "@/native/device";
import type { Settings } from "@/settings";
import { createKeyBar } from "./keyBar";
import { TerminalConsole } from "./terminalConsole";
import { TerminalView } from "./terminalView";

export interface TerminalConsoleDeps {
    settings: Pick<Settings, "terminalFontSize" | "terminalWebgl">;
    notify(message: string, kind: "info" | "error" | "success"): void;
}

/**
 * The program-output console as a terminal: an xterm.js view (with the same
 * long-press selection, Copy/Paste and tappable links as the shell) plus the
 * line editor that handles `input()`. Throws if xterm.js cannot start in this
 * WebView; the caller falls back to the classic console.
 */
export function createTerminalConsole(
    callbacks: ConsoleCallbacks,
    deps: TerminalConsoleDeps,
): ConsoleLike & { applyAppearance(): void } {
    const view = new TerminalView({
        fontSize: deps.settings.terminalFontSize.peek(),
        scrollback: 4000,
        convertEol: true, // programs print "\n", terminals want "\r\n"
        cursorBlink: true,
        webgl: deps.settings.terminalWebgl.peek(),
        notify: deps.notify,
        openUrl: openExternal,
        onTraceback: callbacks.onJump,
    });
    const keyRow = createKeyBar({
        layout: "console",
        modifiers: view.modifiers,
        send: (data) => view.send(data),
        onPaste: () => void view.paste(),
    });
    const console = new TerminalConsole(callbacks, view, { keyRow });
    return Object.assign(console, {
        applyAppearance() {
            view.setFontSize(deps.settings.terminalFontSize.peek());
            view.setWebgl(deps.settings.terminalWebgl.peek());
        },
    });
}