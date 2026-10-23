import { computed, signal, type Signal } from "xtags";
import { selectAll, toggleComment } from "@codemirror/commands";
import type { EditorView } from "@codemirror/view";
import type { EditorManager } from "@/editorManager";
import {
  copiedText,
  copySelection,
  cutSelection,
  pasteIntoSelection,
} from "@/editor/clipboard";
import { pushBack } from "./backStack";
import { icon, type IconName } from "./icons";

/**
 * The floating bar of actions that appears over selected text.
 *
 * It replaces the Cut / Copy / Paste bar Android draws itself (which cannot be
 * styled or extended from a web page, and is switched off natively while the
 * editor has focus; see src/native/device.ts). Everything on it goes through
 * the same public API, so the built-in buttons and anything you add are
 * treated alike:
 *
 *   const remove = selectionMenu.add({
 *     id: 'upper',
 *     label: 'UPPERCASE',
 *     icon: 'edit',                       // an IconName, or leave it out to show the label as text
 *     mode: 'selection',                  // 'selection' | 'cursor' | 'always'
 *     run: ({ view, text }) => view.dispatch(view.state.replaceSelection(text.toUpperCase())),
 *   });
 *   remove();                             // or selectionMenu.remove('upper')
 *
 * Adding an item with an existing id replaces it.
 */

/** When an item is offered: with text selected, with only a caret, or in both cases. */
export type SelectionMenuMode = "selection" | "cursor" | "always";

export interface SelectionMenuContext {
  readonly view: EditorView;
  readonly hasSelection: boolean;
  /** The selected text (every range, joined by line breaks); the empty string with only a caret. */
  readonly text: string;
  /** Closes the menu. Items close it themselves unless `keepOpen` is set. */
  hide(): void;
}

export interface SelectionMenuItem {
  /** Unique key: what `remove()` takes, and what an item added later with the same id replaces. */
  id: string;
  /** Tooltip and accessible name; shown as the button text when there is no `icon`. */
  label: string;
  icon?: IconName;
  /** Default `'selection'`. */
  mode?: SelectionMenuMode;
  /** Lower comes first; items with equal `order` keep the order they were added in. Default 100. */
  order?: number;
  /** Return false to leave the item out right now (called every time the menu opens). */
  visible?(ctx: SelectionMenuContext): boolean;
  /** Keep the menu open after the item runs. */
  keepOpen?: boolean;
  run(ctx: SelectionMenuContext): void | Promise<void>;
}

export interface SelectionMenuOptions {
  editorManager: EditorManager;
  /** Told `true` while the editor has focus and `false` when it doesn't: switch the OS selection bar off/on. */
  systemBar?: (suppress: boolean) => void;
  /** How long the selection must hold still before the menu appears (ms). The OS bar hides while you drag the handles too. Default 220. */
  showDelay?: number;
}

// -------------------------------------------------------------- geometry

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Where to put a menu of `size` for text occupying `anchor`: centred above it,
 * flipped below (clear of the selection handles) when there is no room above,
 * and kept inside `bounds` either way. Pure, so it can be tested without a layout engine.
 */
export function placeMenu(
  anchor: Box,
  size: { width: number; height: number },
  bounds: Box,
  {
    gap = 10,
    handleClearance = 30,
    margin = 8,
  }: { gap?: number; handleClearance?: number; margin?: number } = {},
): { left: number; top: number; placement: "above" | "below" } {
  const centre = (anchor.left + anchor.right) / 2;
  const minLeft = bounds.left + margin;
  const maxLeft = Math.max(minLeft, bounds.right - size.width - margin);
  const left = Math.min(maxLeft, Math.max(minLeft, centre - size.width / 2));

  const above = anchor.top - size.height - gap;
  if (above >= bounds.top + margin)
    return { left, top: above, placement: "above" };

  const below = anchor.bottom + handleClearance;
  const lowest = bounds.bottom - size.height - margin;
  if (below <= lowest) return { left, top: below, placement: "below" };

  // Neither fits (a selection that fills the view): float over the top of it.
  return {
    left,
    top: Math.max(bounds.top + margin, Math.min(lowest, above)),
    placement: "above",
  };
}

// ------------------------------------------------------------------ menu

export class SelectionMenu {
  readonly el: HTMLElement;
  /** True while the menu is showing. */
  readonly open: Signal<boolean> = signal(false);

  private readonly em: EditorManager;
  private readonly entries: SelectionMenuItem[] = [];
  private readonly showDelay: number;
  private readonly cleanups: Array<() => void> = [];
  private releaseBack: (() => void) | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private frame = 0;
  private lastDoc: unknown = null;
  private lastSelection: unknown = null;
  private pointerDown = false;
  private pointerDownAt = 0;
  private pointerType = "touch";
  /** A selection change is waiting for the finger to lift before the menu may appear. */
  private waitingForRelease = false;

  constructor(options: SelectionMenuOptions) {
    this.em = options.editorManager;
    this.showDelay = options.showDelay ?? 220;
    this.el = (
      <div
        class={computed(() => ({ "selection-menu": true, open: this.open() }))}
        role="menu"
        aria-label="Selection actions"
      />
    ) as HTMLElement;
    // The menu is a toolbar over the text: tapping it must not move focus out of the editor (that would close the keyboard).
    const keepFocus = (e: Event): void => e.preventDefault();
    this.el.addEventListener("pointerdown", keepFocus);
    this.el.addEventListener("mousedown", keepFocus);

    const view = this.em.editor;
    this.lastDoc = view.state.doc;
    this.lastSelection = view.state.selection;
    this.cleanups.push(this.em.onUpdate(() => this.onEditorUpdate()));

    const listen = (
      target: EventTarget,
      type: string,
      handler: (e: Event) => void,
      capture = false,
    ): void => {
      target.addEventListener(type, handler, capture);
      this.cleanups.push(() =>
        target.removeEventListener(type, handler, capture),
      );
    };

    // Focus: switch the OS selection bar off while typing in the editor (and only then: dialogs and
    // text fields elsewhere still need theirs, e.g. to paste a file name).
    listen(view.dom, "focusin", (e) => {
      if (e.target === view.contentDOM) options.systemBar?.(true);
    });
    listen(view.dom, "focusout", (e) => {
      if (e.target !== view.contentDOM) return;
      options.systemBar?.(false);
      this.hide();
    });

    // Pointer: remember touch vs mouse, and hold the menu back until the finger lifts (a long-press selects a
    // word while the finger is still down; showing the bar under it would be in the way).
    listen(
      document,
      "pointerdown",
      (e) => {
        const p = e as PointerEvent;
        this.pointerType = p.pointerType || "touch";
        if (view.dom.contains(p.target as Node)) {
          this.pointerDown = true;
          this.pointerDownAt = Date.now();
        } else if (!this.el.contains(p.target as Node)) this.hide(); // a tap anywhere else dismisses it
      },
      true,
    );
    const release = (): void => {
      this.pointerDown = false;
      if (this.waitingForRelease) {
        this.waitingForRelease = false;
        this.scheduleShow(false);
      }
    };
    listen(document, "pointerup", release, true);
    listen(document, "pointercancel", release, true);

    // Long-press (touch) or right-click (mouse) opens it, with a caret too ("Paste / Select all").
    listen(view.dom, "contextmenu", (e) => {
      e.preventDefault();
      this.scheduleShow(true);
    });

    listen(view.scrollDOM, "scroll", () => this.scheduleReposition());
    // The keyboard opening (often right after a long-press) resizes the page, and again on every frame of its
    // animation: keep the menu attached to the text rather than dropping it.
    listen(window, "resize", () => this.scheduleReposition());
  }

  // ---------------------------------------------------------------- API

  /** Adds an item (or replaces the one with the same id). Returns a function that removes it again. */
  add(item: SelectionMenuItem): () => void {
    const existing = this.entries.findIndex((i) => i.id === item.id);
    if (existing === -1) this.entries.push(item);
    else this.entries[existing] = item;
    this.refresh();
    return () => {
      // Only remove this exact item: a later replacement with the same id must survive an old disposer.
      const i = this.entries.indexOf(item);
      if (i !== -1) {
        this.entries.splice(i, 1);
        this.refresh();
      }
    };
  }

  /** Removes the item with this id. Returns false if there was none. */
  remove(id: string): boolean {
    const i = this.entries.findIndex((item) => item.id === id);
    if (i === -1) return false;
    this.entries.splice(i, 1);
    this.refresh();
    return true;
  }

  has(id: string): boolean {
    return this.entries.some((item) => item.id === id);
  }

  /** Every registered item, in display order. */
  items(): readonly SelectionMenuItem[] {
    // Array.prototype.sort is stable, so equal `order` keeps insertion order.
    return [...this.entries].sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100),
    );
  }

  /** The items that would be offered right now for `mode` (default: whatever the current selection calls for). */
  visibleItems(
    mode: "selection" | "cursor" = this.currentMode(),
  ): SelectionMenuItem[] {
    const ctx = this.context();
    return this.items().filter((item) => {
      const when = item.mode ?? "selection";
      return (
        (when === "always" || when === mode) && (item.visible?.(ctx) ?? true)
      );
    });
  }

  /** Shows the menu now, at the selection. Does nothing if no item applies. */
  show(): void {
    this.clearTimer();
    const items = this.visibleItems();
    if (items.length === 0) {
      this.hide();
      return;
    }
    this.el.replaceChildren(...items.map((item) => this.button(item)));
    if (!this.reposition()) {
      this.hide();
      return;
    }
    this.open.set(true);
    this.releaseBack ??= pushBack(() => this.hide());
  }

  hide(): void {
    this.clearTimer();
    this.waitingForRelease = false;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.releaseBack?.();
    this.releaseBack = null;
    if (this.open.peek()) this.open.set(false);
  }

  /** Re-reads the item list into the open menu (called after add/remove). */
  refresh(): void {
    if (this.open.peek()) this.show();
  }

  /** Removes every listener. The menu element stays in the page; remove it yourself if you are done with it. */
  destroy(): void {
    this.hide();
    this.cleanups.splice(0).forEach((fn) => fn());
  }

  // ------------------------------------------------------------ internals

  private currentMode(): "selection" | "cursor" {
    return this.em.editor.state.selection.ranges.some((r) => !r.empty)
      ? "selection"
      : "cursor";
  }

  private context(): SelectionMenuContext {
    const view = this.em.editor;
    const hasSelection = this.currentMode() === "selection";
    return {
      view,
      hasSelection,
      get text() {
        return hasSelection ? copiedText(view.state).text : "";
      },
      hide: () => this.hide(),
    };
  }

  private button(item: SelectionMenuItem): HTMLElement {
    return (
      <button
        type="button"
        class="sm-btn"
        role="menuitem"
        title={item.label}
        aria-label={item.label}
        onClick={() => this.activate(item)}
      >
        {item.icon ? (
          icon(item.icon, 20)
        ) : (
          <span class="sm-text">{item.label}</span>
        )}
      </button>
    ) as HTMLElement;
  }

  private activate(item: SelectionMenuItem): void {
    const ctx = this.context();
    if (!item.keepOpen) this.hide();
    const report = (error: unknown): void =>
      console.error(`Selection menu item "${item.id}" failed:`, error);
    try {
      const result = item.run(ctx);
      if (result && typeof (result as Promise<void>).catch === "function")
        (result as Promise<void>).catch(report);
    } catch (error) {
      report(error);
    }
    this.em.editor.focus();
  }

  private onEditorUpdate(): void {
    const { doc, selection } = this.em.editor.state;
    const docChanged = doc !== this.lastDoc;
    const selectionChanged = !selection.eq(
      this.lastSelection as typeof selection,
    );
    this.lastDoc = doc;
    this.lastSelection = selection;
    if (!docChanged && !selectionChanged) return;
    // Anything that edits or moves the selection takes the menu away; a settled non-empty selection brings it back.
    this.hide();
    if (!docChanged && selection.ranges.some((r) => !r.empty))
      this.scheduleShow(false);
  }

  /**
   * @param forced  from a long-press / right-click: show even for a bare caret or a mouse user.
   */
  private scheduleShow(forced: boolean): void {
    this.clearTimer();
    if (!forced && this.fingerIsDown()) {
      this.waitingForRelease = true;
      return;
    }
    this.timer = setTimeout(
      () => {
        this.timer = null;
        if (
          !forced &&
          (!this.editorIsActive() ||
            this.pointerType === "mouse" ||
            this.currentMode() !== "selection")
        )
          return;
        this.show();
      },
      forced ? Math.min(this.showDelay, 60) : this.showDelay,
    );
  }

  /** True while a pointer pressed in the editor hasn't lifted. A press that never reports its end (the OS took the touch over) stops counting after a while. */
  private fingerIsDown(): boolean {
    return this.pointerDown && Date.now() - this.pointerDownAt < 8000;
  }

  /** The editor is the focused element. (Not `view.hasFocus`, which also needs the whole window focused: not true while a system overlay is up.) */
  private editorIsActive(): boolean {
    const view = this.em.editor;
    return view.root.activeElement === view.contentDOM;
  }

  private clearTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private scheduleReposition(): void {
    if (!this.open.peek() || this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (this.open.peek() && !this.reposition()) this.hide();
    });
  }

  /** Puts the menu next to the selection. Returns false when the selection is scrolled out of view. */
  private reposition(): boolean {
    const view = this.em.editor;
    const sel = view.state.selection.main;
    // `visibleRanges` is what CodeMirror has *rendered* (it draws well past the screen), so it only rules out the
    // far-away case; whether the selection is on screen is decided from its coordinates below.
    if (!view.visibleRanges.some((r) => r.from <= sel.to && r.to >= sel.from))
      return false;

    const scroller = view.scrollDOM.getBoundingClientRect();
    const bounds: Box = {
      left: scroller.left,
      top: scroller.top,
      right: scroller.right,
      bottom: scroller.bottom,
    };

    const at = (
      pos: number,
      side: 1 | -1,
    ): { left: number; right: number; top: number; bottom: number } | null => {
      try {
        return view.coordsAtPos(pos, side);
      } catch {
        return null; // no layout (tests), or the position isn't drawn
      }
    };
    const start = at(sel.from, 1);
    const end = at(sel.to, -1);

    // Entirely above or below the editor's visible area (scrolled away): there is nothing to attach to.
    const selTop = Math.min(start?.top ?? Infinity, end?.top ?? Infinity);
    const selBottom = Math.max(
      start?.bottom ?? -Infinity,
      end?.bottom ?? -Infinity,
    );
    if ((start || end) && (selBottom < bounds.top || selTop > bounds.bottom))
      return false;

    let anchor: Box;
    if (!start && !end) {
      anchor = {
        left: bounds.left,
        right: bounds.right,
        top: bounds.top,
        bottom: bounds.top,
      };
    } else {
      const a = start ?? {
        left: bounds.left,
        right: bounds.left,
        top: bounds.top,
        bottom: bounds.top,
      };
      const b = end ?? {
        left: bounds.right,
        right: bounds.right,
        top: bounds.bottom,
        bottom: bounds.bottom,
      };
      const sameLine = Math.abs(a.top - b.top) < 2;
      anchor = {
        left: a.left,
        right: sameLine ? Math.max(a.left, b.right) : bounds.right, // several lines: centre on the editor, like the OS bar
        top: Math.max(bounds.top, Math.min(a.top, b.top)),
        bottom: Math.min(bounds.bottom, Math.max(a.bottom, b.bottom)),
      };
    }

    const placed = placeMenu(
      anchor,
      { width: this.el.offsetWidth, height: this.el.offsetHeight },
      bounds,
    );
    const parent = (
      this.el.offsetParent ?? this.el.parentElement
    )?.getBoundingClientRect();
    this.el.style.left = `${Math.round(placed.left - (parent?.left ?? 0))}px`;
    this.el.style.top = `${Math.round(placed.top - (parent?.top ?? 0))}px`;
    this.el.dataset.placement = placed.placement;
    return true;
  }
}

export function createSelectionMenu(
  options: SelectionMenuOptions,
): SelectionMenu {
  return new SelectionMenu(options);
}

/** The built-in buttons: Cut, Copy, Paste, Select all, Comment. Registered through the public `add`, like any other. */
export function registerDefaultSelectionItems(menu: SelectionMenu): void {
  menu.add({
    id: "cut",
    label: "Cut",
    icon: "cut",
    order: 10,
    run: ({ view }) => void cutSelection(view),
  });
  menu.add({
    id: "copy",
    label: "Copy",
    icon: "copy",
    order: 20,
    run: ({ view }) => void copySelection(view),
  });
  menu.add({
    id: "paste",
    label: "Paste",
    icon: "paste",
    order: 30,
    mode: "always",
    run: ({ view }) => void pasteIntoSelection(view),
  });
  menu.add({
    id: "select-all",
    label: "Select all",
    icon: "selectAll",
    order: 40,
    mode: "always",
    // Pointless once everything is selected, and an empty file has nothing to select.
    visible: ({ view }) => {
      const { doc, selection } = view.state;
      return (
        doc.length > 0 &&
        !(selection.main.from === 0 && selection.main.to === doc.length)
      );
    },
    run: ({ view }) => void selectAll(view),
  });
  menu.add({
    id: "comment",
    label: "Comment",
    icon: "hash",
    order: 50,
    run: ({ view }) => void toggleComment(view),
  });
}
