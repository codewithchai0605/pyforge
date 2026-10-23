import { refreshSelect } from "./dom";
import {
  createRoot,
  effect,
  onCleanup,
  signal,
  untrack,
  type Signal,
} from "./reactive";

export interface ForProps<T> {
  /** The list to render. Any zero-arg accessor works — a `Signal<T[]>`,
   *  a `computed()`, or a plain function — since only the call matters. */
  each: () => T[];
  /**
   * Identifies which output node an item corresponds to across renders, so
   * an item that just moved gets *moved* in the DOM instead of being torn
   * down and rebuilt. Defaults to the item itself (`Object.is` identity via
   * `Map` keying), which is fine for a list of objects but almost always
   * wrong for a list of plain strings/numbers with duplicates — pass an id
   * function in that case.
   */
  key?: (item: T, index: number) => unknown;
  /** Builds the node for one item. `index` is a live `Signal<number>` (not
   *  a plain number) because an item's position can change as the list
   *  changes even when the item itself doesn't — that's also what makes it
   *  usable directly as a reactive JSX child (`{index}`), not just via a
   *  call like `index()`.
   *
   *  `item$` is a live `Signal<T>` holding the *latest* item for this key.
   *  With immutable updates (`rows.map(r => r.id === id ? { ...r, v } : r)`)
   *  the row keeps its DOM node (same key) but `item` — the value passed on
   *  first build — goes stale; read `item$()` inside bindings instead
   *  (`value={() => item$().text}`) so editable rows stay in sync without
   *  being rebuilt (which would drop focus). Must return a single Node, not a
   *  Fragment. */
  children: (item: T, index: Signal<number>, item$: Signal<T>) => Node;
}

interface Entry {
  node: Node;
  dispose: () => void;
  indexSignal: Signal<number>;
  itemSignal: Signal<unknown>;
}

/**
 * Keyed list rendering — the one item explicitly called out as "not
 * implemented yet" in the original README. Rebuilding a list by hand inside
 * an `effect()` (the documented workaround) throws away and recreates every
 * row on every change, along with any state, focus, or CSS transition that
 * row had. `For` instead keeps one DOM node and one disposal scope per item,
 * keyed by identity (or your own `key` function), and only creates/removes/
 * moves the ones that actually changed.
 *
 * The reordering pass is a simple "walk backwards, insert before the last
 * node we placed" — correct for any change (add/remove/move/shuffle) and
 * a no-op for items that are already in the right spot, but it isn't a
 * minimal-moves diff (no LIS-based reordering) — good enough for a tiny
 * library's typical list sizes, not tuned for huge (1000+ row) lists.
 */
export function For<T>(props: ForProps<T>): Node {
  const anchor = document.createComment("for");
  const frag = document.createDocumentFragment();
  frag.appendChild(anchor);

  const keyFn = props.key ?? ((item: T) => item as unknown);
  let entries = new Map<unknown, Entry>();

  effect(() => {
    const items = props.each();
    const nextEntries = new Map<unknown, Entry>();
    const nextNodes: Node[] = [];

    items.forEach((item, i) => {
      const k = keyFn(item, i);
      const existing = entries.get(k);
      if (existing) {
        existing.indexSignal.set(i);
        existing.itemSignal.set(item);
        nextEntries.set(k, existing);
        nextNodes.push(existing.node);
        return;
      }

      let entry!: Entry;
      createRoot((dispose) => {
        const indexSignal = signal(i);
        const itemSignal = signal<unknown>(item);
        // Untracked: building a row must not subscribe this list's effect to
        // whatever signals the row's own body happens to read.
        const node = untrack(() =>
          props.children(item, indexSignal, itemSignal as Signal<T>),
        );
        entry = { node, dispose, indexSignal, itemSignal };
      });
      nextEntries.set(k, entry);
      nextNodes.push(entry.node);
    });

    // Dispose and detach anything that dropped out of the list.
    for (const [k, entry] of entries) {
      if (!nextEntries.has(k)) {
        entry.node.parentNode?.removeChild(entry.node);
        entry.dispose();
      }
    }

    // Walking backwards and inserting before the last-placed node handles
    // add/remove/move/shuffle uniformly, and the nextSibling check skips
    // the DOM write entirely for items that are already positioned right.
    const parent = anchor.parentNode;
    if (parent) {
      let ref: Node = anchor;
      for (let i = nextNodes.length - 1; i >= 0; i--) {
        const node = nextNodes[i];
        if (!node) continue; // unreachable given the loop bounds above; keeps this safe under noUncheckedIndexedAccess
        if (node.nextSibling !== ref) parent.insertBefore(node, ref);
        ref = node;
      }
      refreshSelect(parent);
    }

    entries = nextEntries;
  });

  onCleanup(() => {
    for (const entry of entries.values()) entry.dispose();
  });

  return frag;
}
