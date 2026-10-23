import { signal, type Signal } from "xtags";
import { EditorView } from "@codemirror/view";
import { Prec, type Extension } from "@codemirror/state";
import { openSearchPanel } from "@codemirror/search";
import { copySelection, cutSelection, pasteIntoSelection } from "./clipboard";

/**
 * SHFT / CTRL / ALT on the quick-tools bar behave like the "sticky keys" of a
 * phone keyboard, and, this is the part that was missing, they now apply to
 * what you TYPE, not just to the bar's own arrow buttons:
 *
 *   tap CTRL, then tap `a` on the phone keyboard  ->  Ctrl+A  ->  select all.
 *
 * The state machine lives in KeyModifiers (no DOM, easy to test); the
 * extension below registers it with the editor on every input path a key can
 * take on Android:
 *
 *   1. `keydown`      hardware keyboards, and the few soft keyboards that send
 *                     real key events (also CodeMirror's own synthetic Enter /
 *                     Backspace, which is how it reports those on Android).
 *   2. `beforeinput`  soft keyboards typing a single character outside an IME
 *                     composition. Cancelable, so nothing reaches the document.
 *   3. inputHandler   soft keyboards that compose text (Gboard): the character
 *                     is already in the DOM when CodeMirror reports it. The
 *                     handler swallows it and CodeMirror redraws the DOM from
 *                     its state, so the stray letter disappears.
 *
 * All three end in `runKey`, which re-dispatches the key as a real, bubbling
 * `keydown` with the modifier flags set. That way the chord reaches the
 * editor's whole keymap (Mod-a, Mod-z, Mod-/, Alt-ArrowUp, ...) AND the app's
 * document-level shortcuts (Ctrl+S, Ctrl+Enter) with no second table to keep
 * in sync. The few chords the browser would normally handle itself (copy, cut,
 * paste) cannot be triggered by a synthetic event, so those are mapped here.
 */

export type ModifierName = "shift" | "ctrl" | "alt";
/** `once`: applies to the next key, then releases. `locked`: stays on until tapped again. */
export type ModifierState = "off" | "once" | "locked";
export interface HeldModifiers {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
}

export class KeyModifiers {
  readonly shift: Signal<ModifierState> = signal<ModifierState>("off");
  readonly ctrl: Signal<ModifierState> = signal<ModifierState>("off");
  readonly alt: Signal<ModifierState> = signal<ModifierState>("off");
  private lastTap: Record<ModifierName, number> = { shift: 0, ctrl: 0, alt: 0 };

  /** `now` and `doubleTapMs` are injectable so tests don't have to wait. */
  constructor(
    private readonly now: () => number = Date.now,
    private readonly doubleTapMs = 350,
  ) {}

  state(name: ModifierName): Signal<ModifierState> {
    return this[name];
  }

  /** A tap on the button: off -> once; a quick second tap -> locked; any later tap -> off. */
  tap(name: ModifierName): void {
    const sig = this[name];
    const t = this.now();
    const current = sig.peek();
    if (current === "off") sig.set("once");
    else if (current === "once" && t - this.lastTap[name] < this.doubleTapMs)
      sig.set("locked");
    else sig.set("off");
    this.lastTap[name] = t;
  }

  /** True if any modifier would change the next key. */
  any(): boolean {
    return (
      this.shift.peek() !== "off" ||
      this.ctrl.peek() !== "off" ||
      this.alt.peek() !== "off"
    );
  }

  /** The modifiers for the key being handled right now; releases the ones that were `once`. */
  take(): HeldModifiers {
    const held = {
      shift: this.shift.peek() !== "off",
      ctrl: this.ctrl.peek() !== "off",
      alt: this.alt.peek() !== "off",
    };
    for (const name of ["shift", "ctrl", "alt"] as const)
      if (this[name].peek() === "once") this[name].set("off");
    return held;
  }

  /** Releases everything, including locked ones (used when the editor loses focus). */
  clear(): void {
    this.shift.set("off");
    this.ctrl.set("off");
    this.alt.set("off");
  }
}

/** The one keyboard there is: shared by the quick-tools bar and every editor. */
export const keyModifiers = new KeyModifiers();

// ---------------------------------------------------------------- typing

let typing = false;

/**
 * Types `text` at the cursor exactly as the keyboard would: through the same
 * input handlers CodeMirror runs for real typing. That matters because
 * `closeBrackets` lives there: typing `(` gives `()` with the caret inside,
 * and typing `)` just before an existing `)` steps over it instead of adding
 * a second one. A plain `dispatch({changes})` bypasses all of that.
 */
export function typeText(view: EditorView, text: string): void {
  const { from, to } = view.state.selection.main;
  const insert = () =>
    view.state.update(view.state.replaceSelection(text), {
      scrollIntoView: true,
      userEvent: "input.type",
    });
  typing = true;
  try {
    if (
      !view.state
        .facet(EditorView.inputHandler)
        .some((handler) => handler(view, from, to, text, insert))
    )
      view.dispatch(insert());
  } finally {
    typing = false;
  }
}

/** Taps a key on the quick-tools bar: typed with whichever modifiers are armed (and releases the one-shot ones). */
export function typeKey(
  view: EditorView,
  text: string,
  mods: KeyModifiers = keyModifiers,
): void {
  runKey(view, text, mods.take());
}

// ---------------------------------------------------------------- chords

const isPrintable = (key: string): boolean => [...key].length === 1;

const NAMED_KEYS = new Set([
  "Enter",
  "Backspace",
  "Delete",
  "Tab",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/** Named keys Shift changes the meaning of (extend selection, dedent). For the rest, Shift alone is a no-op. */
const SHIFT_AWARE_KEYS = new Set([
  "Tab",
  "ArrowLeft",
  "ArrowRight",
  "ArrowUp",
  "ArrowDown",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/** Ctrl chords the browser would handle natively; a synthetic key event can't trigger those, so run them here. */
const APP_CHORDS: Record<string, (view: EditorView) => void> = {
  c: (view) => void copySelection(view),
  x: (view) => void cutSelection(view),
  v: (view) => void pasteIntoSelection(view),
  f: (view) => void openSearchPanel(view),
};

let dispatching = false;

function dispatchKey(
  view: EditorView,
  key: string,
  held: HeldModifiers,
): boolean {
  const win = view.dom.ownerDocument.defaultView;
  const KeyEventCtor = win?.KeyboardEvent ?? KeyboardEvent;
  // CodeMirror's keymap matches `Mod-Shift-z` against key "z" plus the shift flag; an upper-case "Z" is only
  // matched through keyCode, which a synthetic event doesn't have. So letters go out lower-case.
  const event = new KeyEventCtor("keydown", {
    key: (held.ctrl || held.alt) && isPrintable(key) ? key.toLowerCase() : key,
    ctrlKey: held.ctrl,
    altKey: held.alt,
    shiftKey: held.shift,
    bubbles: true,
    cancelable: true,
  });
  dispatching = true;
  try {
    view.contentDOM.dispatchEvent(event);
  } finally {
    dispatching = false;
  }
  return event.defaultPrevented;
}

/**
 * Performs one key press with `held` modifiers. Returns whether something
 * handled it. A character typed with Ctrl/Alt that nothing is bound to is
 * simply dropped (that's what Ctrl+Q does everywhere), never inserted.
 */
export function runKey(
  view: EditorView,
  key: string,
  held: HeldModifiers,
): boolean {
  if (isPrintable(key) && !held.ctrl && !held.alt) {
    typeText(view, held.shift ? key.toUpperCase() : key);
    return true;
  }
  if (isPrintable(key) && held.ctrl && !held.alt) {
    const chord = APP_CHORDS[key.toLowerCase()];
    if (chord) {
      chord(view);
      return true;
    }
  }
  return dispatchKey(view, key, held);
}

// ------------------------------------------------------------- extension

/**
 * Registers `mods` with an editor. Added to every file's EditorState (see
 * createEditor.ts: each tab has its own state, so a per-view hook would be
 * lost on the first tab switch).
 */
export function keyModifierInput(mods: KeyModifiers = keyModifiers): Extension {
  return Prec.highest([
    EditorView.domEventHandlers({
      keydown(event, view) {
        if (dispatching || !mods.any()) return false;
        // Keyboards that compose (Gboard) report 229 and no usable key: beforeinput / inputHandler deal with those.
        if (event.isComposing || event.keyCode === 229) return false;
        if (!isPrintable(event.key) && !NAMED_KEYS.has(event.key)) return false;
        const held = mods.take();
        const effective = {
          ctrl: held.ctrl || event.ctrlKey,
          alt: held.alt || event.altKey,
          shift: held.shift || event.shiftKey,
        };
        // Shift on Enter / Backspace / Delete changes nothing: let the editor handle the real key (the armed
        // Shift is used up either way).
        if (
          !effective.ctrl &&
          !effective.alt &&
          !isPrintable(event.key) &&
          !SHIFT_AWARE_KEYS.has(event.key)
        )
          return false;
        // This key is replaced by the re-dispatched one below: don't let the original reach the document too.
        event.preventDefault();
        event.stopPropagation();
        runKey(view, event.key, effective);
        return true;
      },

      beforeinput(event, view) {
        if (
          !mods.any() ||
          event.isComposing ||
          !event.cancelable ||
          event.inputType !== "insertText"
        )
          return false;
        const text = event.data ?? "";
        if (!isPrintable(text)) return false;
        event.preventDefault();
        runKey(view, text, mods.take());
        return true;
      },

      // Armed modifiers must not outlive the keyboard: a stray CTRL left on
      // would turn the next thing typed, hours later, into a shortcut.
      blur() {
        mods.clear();
        return false;
      },
    }),

    EditorView.inputHandler.of((view, from, to, text) => {
      if (typing || !mods.any() || view.state.readOnly || !isPrintable(text))
        return false;
      const held = mods.take();
      if (held.ctrl || held.alt) {
        runKey(view, text, held);
        return true; // the letter is already in the DOM; CodeMirror redraws it away
      }
      const upper = held.shift ? text.toUpperCase() : text;
      if (upper === text) return false;
      view.dispatch({
        changes: { from, to, insert: upper },
        selection: { anchor: from + upper.length },
        scrollIntoView: true,
        userEvent: "input.type",
      });
      return true;
    }),
  ]);
}
