import { computed } from "xtags";
import {
  undo,
  redo,
  indentMore,
  indentLess,
  cursorLineUp,
  cursorLineDown,
  selectLineUp,
  selectLineDown,
  moveLineUp,
  moveLineDown,
  cursorCharLeft,
  cursorCharRight,
  selectCharLeft,
  selectCharRight,
  cursorGroupLeft,
  cursorGroupRight,
  selectGroupLeft,
  selectGroupRight,
  cursorLineBoundaryBackward,
  cursorLineBoundaryForward,
  selectLineBoundaryBackward,
  selectLineBoundaryForward,
  selectAll,
  toggleComment,
} from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import type { EditorManager } from "@/editorManager";
import { openInFileSearch } from "@/editor/createEditor";
import { pasteIntoSelection } from "@/editor/clipboard";
import {
  keyModifiers,
  typeKey,
  type KeyModifiers,
  type ModifierName,
} from "@/editor/modifiers";
import { icon, type IconName } from "./icons";

/**
 * The strip above the on-screen keyboard. A phone keyboard buries the
 * characters Python needs (`: ( ) [ ] { } _ # = "`), and has no Tab, Ctrl or
 * arrow keys, so this provides:
 *   row 1: a scrollable row of Python symbols, typed exactly like the keyboard
 *          would type them (so `(` gives `()` and `)` steps over one)
 *   row 2: navigation/editing, with SHFT/CTRL/ALT as sticky modifiers.
 *
 * SHFT / CTRL / ALT: tap = applies to the next key and releases; double-tap =
 * stays on until tapped again. They apply to the bar's own arrows AND to what
 * you type on the phone keyboard (tap CTRL, then `a` = select all), which is
 * registered with the editor in src/editor/modifiers.ts.
 */
export function createQuickTools(
  editorManager: EditorManager,
  mods: KeyModifiers = keyModifiers,
): HTMLElement {
  const view = (): EditorView => editorManager.editor;

  const run = (command: (v: EditorView) => boolean): void => {
    command(view());
    view().focus();
  };

  const horizontal = (dir: "left" | "right"): void => {
    const { shift: s, ctrl, alt } = mods.take();
    if (alt)
      run(
        dir === "left"
          ? s
            ? selectLineBoundaryBackward
            : cursorLineBoundaryBackward
          : s
            ? selectLineBoundaryForward
            : cursorLineBoundaryForward,
      );
    else if (ctrl)
      run(
        dir === "left"
          ? s
            ? selectGroupLeft
            : cursorGroupLeft
          : s
            ? selectGroupRight
            : cursorGroupRight,
      );
    else
      run(
        dir === "left"
          ? s
            ? selectCharLeft
            : cursorCharLeft
          : s
            ? selectCharRight
            : cursorCharRight,
      );
  };

  const vertical = (dir: "up" | "down"): void => {
    const { shift: s, alt } = mods.take();
    if (alt) return run(dir === "up" ? moveLineUp : moveLineDown);
    run(
      dir === "up"
        ? s
          ? selectLineUp
          : cursorLineUp
        : s
          ? selectLineDown
          : cursorLineDown,
    );
  };

  /** Tab indents; with SHFT armed it dedents, like Shift+Tab. */
  const tab = (): void => {
    const { shift } = mods.take();
    run(shift ? indentLess : indentMore);
  };

  /** A key from the symbol row, typed with whatever modifiers are armed. */
  const symbol = (text: string): void => {
    typeKey(view(), text, mods);
    view().focus();
  };

  /** Any other button: it uses up a one-shot modifier like every other key would. */
  const action = (fn: () => void): void => {
    mods.take();
    fn();
  };

  // `pointerdown` + preventDefault keeps focus (and the keyboard) in the editor
  // instead of blurring it on every tap, which is what makes this usable.
  const keepFocus = (e: Event): void => e.preventDefault();

  const textBtn = (
    label: string,
    title: string,
    onClick: () => void,
    cls = "",
  ): HTMLElement =>
    (
      <button
        type="button"
        class={`qt-btn ${cls}`}
        title={title}
        aria-label={title}
        onPointerDown={keepFocus}
        onClick={onClick}
      >
        {label}
      </button>
    ) as HTMLElement;
  const iconBtn = (
    name: IconName,
    title: string,
    onClick: () => void,
  ): HTMLElement =>
    (
      <button
        type="button"
        class="qt-btn"
        title={title}
        aria-label={title}
        onPointerDown={keepFocus}
        onClick={onClick}
      >
        {icon(name, 18)}
      </button>
    ) as HTMLElement;
  const toggleBtn = (
    label: string,
    name: ModifierName,
    title: string,
  ): HTMLElement => {
    const state = mods.state(name);
    return (
      <button
        type="button"
        class={computed(() => ({
          "qt-btn": true,
          "qt-toggle": true,
          active: state() !== "off",
          locked: state() === "locked",
        }))}
        title={title}
        aria-label={title}
        aria-pressed={computed(() => String(state() !== "off"))}
        onPointerDown={keepFocus}
        onClick={() => mods.tap(name)}
      >
        {label}
      </button>
    ) as HTMLElement;
  };

  const symbols = [
    "Tab",
    ":",
    "(",
    ")",
    "[",
    "]",
    "{",
    "}",
    '"',
    "'",
    "=",
    "_",
    "#",
    ",",
    ".",
    "+",
    "-",
    "*",
    "/",
    "%",
    "<",
    ">",
    "!",
    "&",
    "|",
    "\\",
    "~",
    "@",
    "$",
  ];

  const row1 = (
    <div class="qt-row qt-symbols" role="toolbar" aria-label="Symbols">
      {symbols.map((label) =>
        label === "Tab"
          ? textBtn("Tab", "Indent (Shift: dedent)", tab, "qt-wide")
          : textBtn(label, `Insert ${label}`, () => symbol(label)),
      )}
    </div>
  ) as HTMLElement;

  const row2 = (
    <div class="qt-row" role="toolbar" aria-label="Editing">
      {textBtn("‹", "Cursor left", () => horizontal("left"))}
      {textBtn("›", "Cursor right", () => horizontal("right"))}
      {iconBtn("chevronUp", "Cursor up", () => vertical("up"))}
      {iconBtn("chevronDown", "Cursor down", () => vertical("down"))}
      {toggleBtn(
        "SHFT",
        "shift",
        "Shift: select while moving, or capitalise the next letter. Double-tap to lock.",
      )}
      {toggleBtn(
        "CTRL",
        "ctrl",
        "Ctrl: word jumps, or a shortcut with the next key (CTRL then A selects all). Double-tap to lock.",
      )}
      {toggleBtn(
        "ALT",
        "alt",
        "Alt: move the line on up/down; line start/end on left/right. Double-tap to lock.",
      )}
      {iconBtn("undo", "Undo", () => action(() => run(undo)))}
      {iconBtn("redo", "Redo", () => action(() => run(redo)))}
      {iconBtn("selectAll", "Select all", () => action(() => run(selectAll)))}
      {iconBtn("paste", "Paste", () =>
        action(
          () => void pasteIntoSelection(view()).then(() => view().focus()),
        ),
      )}
      {iconBtn("hash", "Comment / uncomment line", () =>
        action(() => run(toggleComment)),
      )}
      {iconBtn("search", "Find in this file", () =>
        action(() => openInFileSearch(view())),
      )}
      {textBtn("⇤", "Dedent", () => action(() => run(indentLess)))}
      {iconBtn("keyboardDown", "Hide keyboard", () =>
        action(() => view().contentDOM.blur()),
      )}
    </div>
  ) as HTMLElement;

  return (
    <div id="quick-tools">
      {row1}
      {row2}
    </div>
  ) as HTMLElement;
}
