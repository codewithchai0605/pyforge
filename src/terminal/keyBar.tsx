import { computed } from "xtags";
import type { KeyModifiers, ModifierName } from "@/editor/modifiers";
import { icon, type IconName } from "@/components/icons";
import { encodeKey, type NamedKey } from "./keys";

/**
 * The row of keys a phone keyboard doesn't have, above the on-screen
 * keyboard: Esc, Tab, sticky Ctrl / Alt, arrows, Home / End, Page Up / Down,
 * and the shell's favourite punctuation. Same look and the same sticky
 * behaviour (tap = next key only, double-tap = locked) as the editor's quick
 * tools bar.
 *
 * It never takes focus from the terminal (`pointerdown` is cancelled), so the
 * soft keyboard stays up while you tap it.
 */

export interface KeyBarOptions {
  /** "full" for a shell, "console" for a program waiting in input(). */
  layout: "full" | "console";
  modifiers: KeyModifiers;
  /** Types text as if it came from the keyboard (goes through the sticky modifiers). */
  send(data: string): void;
  /** Whether arrows should use application-cursor encoding (a full-screen program asked for it). */
  applicationCursor?(): boolean;
  onPaste?(): void;
}

export function createKeyBar(o: KeyBarOptions): HTMLElement {
  const keepFocus = (e: Event): void => e.preventDefault();

  const sendKey = (key: NamedKey): void => {
    // Modifier state is consumed by the terminal's own data path, so the
    // sequence is encoded with the modifiers that are armed right now.
    const m = o.modifiers;
    const held = {
      ctrl: m.ctrl.peek() !== "off",
      alt: m.alt.peek() !== "off",
      shift: m.shift.peek() !== "off",
    };
    m.take();
    o.send(encodeKey(key, held, o.applicationCursor?.() ?? false));
  };

  const text = (label: string, title: string, onClick: () => void, wide = false): HTMLElement =>
    (
      <button
        type="button"
        class={wide ? "qt-btn qt-wide" : "qt-btn"}
        title={title}
        aria-label={title}
        onPointerDown={keepFocus}
        onClick={onClick}
      >
        {label}
      </button>
    ) as HTMLElement;

  const glyph = (name: IconName, title: string, onClick: () => void): HTMLElement =>
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

  const toggle = (label: string, name: ModifierName, title: string): HTMLElement => {
    const state = o.modifiers.state(name);
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
        onClick={() => o.modifiers.tap(name)}
      >
        {label}
      </button>
    ) as HTMLElement;
  };

  const arrows = [
    glyph("chevronUp", "Up", () => sendKey("ArrowUp")),
    glyph("chevronDown", "Down", () => sendKey("ArrowDown")),
    text("←", "Left", () => sendKey("ArrowLeft")),
    text("→", "Right", () => sendKey("ArrowRight")),
  ];
  const paste = o.onPaste ? [glyph("paste", "Paste", o.onPaste)] : [];

  const keys: HTMLElement[] =
    o.layout === "console"
      ? [
        text("^C", "Stop the program (Ctrl+C)", () => o.send("\x03"), true),
        text("^D", "End of input (Ctrl+D)", () => o.send("\x04"), true),
        ...arrows,
        text("Home", "Home", () => sendKey("Home"), true),
        text("End", "End", () => sendKey("End"), true),
        text("Tab", "Tab", () => sendKey("Tab"), true),
        ...paste,
      ]
      : [
        text("Esc", "Escape", () => sendKey("Escape"), true),
        text("Tab", "Tab", () => sendKey("Tab"), true),
        toggle("CTRL", "ctrl", "Control (tap: next key; double-tap: lock)"),
        toggle("ALT", "alt", "Alt (tap: next key; double-tap: lock)"),
        // One tap instead of CTRL then C: the key you reach for most often in a shell.
        text("^C", "Interrupt the running command (Ctrl+C)", () => o.send("\x03"), true),
        text("^D", "End of input / log out (Ctrl+D)", () => o.send("\x04"), true),
        ...arrows,
        text("Home", "Home", () => sendKey("Home"), true),
        text("End", "End", () => sendKey("End"), true),
        text("PgUp", "Page up", () => sendKey("PageUp"), true),
        text("PgDn", "Page down", () => sendKey("PageDown"), true),
        ...["|", "/", "-", "~", "_", "$", "&", ":", '"', "'", "\\"].map((c) =>
          text(c, c, () => {
            o.send(c);
          }),
        ),
        ...paste,
      ];

  return (
    <div class={`term-keys term-keys-${o.layout}`} role="toolbar" aria-label="Terminal keys">
      <div class="qt-row">{keys}</div>
    </div>
  ) as HTMLElement;
}