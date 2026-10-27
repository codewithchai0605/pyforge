/**
 * Byte sequences for the keys a phone keyboard doesn't have (Esc, Tab, arrows,
 * Home/End, Page Up/Down...) and the effect of the sticky Ctrl / Alt buttons
 * on a character typed on the soft keyboard. Pure functions, no DOM.
 */

export interface Mods {
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
}

export const NO_MODS: Mods = { ctrl: false, alt: false, shift: false };

export type NamedKey =
  | "Escape"
  | "Tab"
  | "ArrowUp"
  | "ArrowDown"
  | "ArrowRight"
  | "ArrowLeft"
  | "Home"
  | "End"
  | "PageUp"
  | "PageDown"
  | "Delete"
  | "Insert"
  | "Enter"
  | "Backspace";

/** xterm's modifier parameter: 1 + shift(1) + alt(2) + ctrl(4). */
const modParam = (m: Mods): number =>
  1 + (m.shift ? 1 : 0) + (m.alt ? 2 : 0) + (m.ctrl ? 4 : 0);

const hasMods = (m: Mods): boolean => m.ctrl || m.alt || m.shift;

const CURSOR: Partial<Record<NamedKey, string>> = {
  ArrowUp: "A",
  ArrowDown: "B",
  ArrowRight: "C",
  ArrowLeft: "D",
  Home: "H",
  End: "F",
};

const TILDE: Partial<Record<NamedKey, number>> = {
  Insert: 2,
  Delete: 3,
  PageUp: 5,
  PageDown: 6,
};

/**
 * What the key sends. `applicationCursor` is the terminal's DECCKM mode (set
 * by full-screen programs such as vi and less): the arrows then use SS3
 * (`ESC O A`) instead of CSI (`ESC [ A`).
 */
export function encodeKey(
  key: NamedKey,
  mods: Mods = NO_MODS,
  applicationCursor = false,
): string {
  switch (key) {
    case "Escape":
      return "\x1b";
    case "Enter":
      return mods.alt ? "\x1b\r" : "\r";
    case "Backspace":
      return (mods.alt ? "\x1b" : "") + (mods.ctrl ? "\x08" : "\x7f");
    case "Tab":
      if (mods.shift) return "\x1b[Z";
      return mods.alt ? "\x1b\t" : "\t";
    default:
      break;
  }
  const letter = CURSOR[key];
  if (letter) {
    if (hasMods(mods)) return `\x1b[1;${modParam(mods)}${letter}`;
    return (applicationCursor ? "\x1bO" : "\x1b[") + letter;
  }
  const n = TILDE[key];
  if (n !== undefined)
    return hasMods(mods) ? `\x1b[${n};${modParam(mods)}~` : `\x1b[${n}~`;
  return "";
}

const CTRL_PUNCT: Record<string, string> = {
  " ": "\x00",
  "@": "\x00",
  "[": "\x1b",
  "\\": "\x1c",
  "]": "\x1d",
  "^": "\x1e",
  "6": "\x1e",
  _: "\x1f",
  "-": "\x1f",
  "?": "\x7f",
  "/": "\x1f",
};

/**
 * A character typed on the soft keyboard while Ctrl and/or Alt are armed:
 * Ctrl+C -> 0x03, Alt+x -> ESC x. Anything that is not a single printable
 * character (a pasted block, an IME composition, an escape sequence from a
 * hardware key) goes through untouched, since the terminal already encoded it.
 */
export function applyModifiers(data: string, mods: Mods): string {
  if (!mods.ctrl && !mods.alt) return data;
  if ([...data].length !== 1) return data;
  const code = data.codePointAt(0)!;
  if (code < 0x20 || code === 0x7f) return data; // already a control key
  let out = data;
  if (mods.ctrl) {
    const lower = data.toLowerCase();
    if (lower >= "a" && lower <= "z")
      out = String.fromCharCode(lower.charCodeAt(0) - 96);
    else if (CTRL_PUNCT[data] !== undefined) out = CTRL_PUNCT[data]!;
  }
  return mods.alt ? "\x1b" + out : out;
}
