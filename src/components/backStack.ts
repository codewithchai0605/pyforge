/**
 * Android's Back button, as one ordered chain of "who handles it":
 *
 *   1. transient surfaces (dialog, menu, drawer, output sheet): the most
 *      recently opened one closes. They register with `pushBack()` while open.
 *   2. the root handler, set once by the app: pops a page off the navigation
 *      stack, or, on Home, starts the exit flow (unsaved files, confirmation).
 *
 * So Back never skips a layer: dialog → sheet/drawer → page → Home → exit.
 */
type Closer = () => void;

const stack: Closer[] = [];
let root: () => void = () => {};

/** Registers `close` as the thing Back should do next. Returns an unregister function. */
export function pushBack(close: Closer): () => void {
  stack.push(close);
  return () => {
    const i = stack.lastIndexOf(close);
    if (i !== -1) stack.splice(i, 1);
  };
}

/** What Back does when no transient surface is open. */
export function setRootBackHandler(handler: () => void): void {
  root = handler;
}

/** Handles one Back press. Returns true if a transient surface was closed (the root handler is not involved). */
export function handleBack(): boolean {
  const close = stack.pop();
  if (!close) return false;
  close();
  return true;
}

/** The full chain: a transient surface if one is open, otherwise the root handler. */
export function dispatchBack(): void {
  if (!handleBack()) root();
}

export function backDepth(): number {
  return stack.length;
}
