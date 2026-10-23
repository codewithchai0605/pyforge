import type { EditorState } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import {
  defaultClipboardBackend,
  type ClipboardBackend,
} from "@/native/device";

/**
 * Copy / cut / paste for the editor selection.
 *
 * These exist because the system's own Cut/Copy/Paste bar is replaced by the
 * app's selection menu (components/selectionMenu.tsx), and because a synthetic
 * Ctrl+C from the quick-tools bar cannot trigger the browser's clipboard.
 * Every command resolves to an outcome instead of throwing, so callers (menu
 * buttons, key chords) can all report problems the same way.
 */

export type ClipboardOutcome = "ok" | "empty" | "failed";

let backend: ClipboardBackend | null = null;
let notifier: (message: string, kind: "info" | "error") => void = () => {};

/** Swaps the clipboard implementation (tests, or a different host). `null` restores the default. */
export function setClipboardBackend(next: ClipboardBackend | null): void {
  backend = next;
}

/** Where problems like "clipboard unavailable" are shown (the app wires this to a toast). */
export function setClipboardNotifier(
  fn: (message: string, kind: "info" | "error") => void,
): void {
  notifier = fn;
}

const current = (): ClipboardBackend => backend ?? defaultClipboardBackend();

/** What Copy/Cut put on the clipboard: the selected text, or, with only a caret, the whole current line (like VS Code). */
export function copiedText(state: EditorState): {
  text: string;
  linewise: boolean;
} {
  const parts = state.selection.ranges
    .filter((r) => !r.empty)
    .map((r) => state.sliceDoc(r.from, r.to));
  if (parts.length > 0)
    return { text: parts.join(state.lineBreak), linewise: false };
  const lines = [
    ...new Set(
      state.selection.ranges.map((r) => state.doc.lineAt(r.head).number),
    ),
  ].map((n) => state.doc.line(n).text);
  return {
    text: lines.join(state.lineBreak) + state.lineBreak,
    linewise: true,
  };
}

async function guarded(
  action: () => Promise<ClipboardOutcome>,
  failure: string,
): Promise<ClipboardOutcome> {
  try {
    return await action();
  } catch (error) {
    notifier(
      error instanceof Error && error.message ? error.message : failure,
      "error",
    );
    return "failed";
  }
}

export function copySelection(view: EditorView): Promise<ClipboardOutcome> {
  return guarded(async () => {
    const { text } = copiedText(view.state);
    await current().write(text);
    return "ok";
  }, "Could not copy.");
}

export function cutSelection(view: EditorView): Promise<ClipboardOutcome> {
  return guarded(async () => {
    const { text, linewise } = copiedText(view.state);
    await current().write(text);
    if (linewise) {
      // Remove the whole line(s) including the line break after each one. The last line of the document has
      // no break after it, so take the one before it instead (unless that line is being removed too).
      const doc = view.state.doc;
      const numbers = [
        ...new Set(
          view.state.selection.ranges.map((r) => doc.lineAt(r.head).number),
        ),
      ];
      const changes = numbers.map((n) => {
        const line = doc.line(n);
        if (line.to < doc.length) return { from: line.from, to: line.to + 1 };
        return numbers.includes(n - 1) || line.from === 0
          ? { from: line.from, to: line.to }
          : { from: line.from - 1, to: line.to };
      });
      view.dispatch({ changes, scrollIntoView: true, userEvent: "delete.cut" });
    } else {
      view.dispatch(view.state.replaceSelection(""), {
        scrollIntoView: true,
        userEvent: "delete.cut",
      });
    }
    return "ok";
  }, "Could not cut.");
}

export function pasteIntoSelection(
  view: EditorView,
): Promise<ClipboardOutcome> {
  return guarded(async () => {
    const text = await current().read();
    if (!text) {
      notifier("The clipboard is empty.", "info");
      return "empty";
    }
    view.dispatch(view.state.replaceSelection(text), {
      scrollIntoView: true,
      userEvent: "input.paste",
    });
    return "ok";
  }, "Could not paste.");
}
