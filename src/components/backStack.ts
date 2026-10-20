/**
 * Android's hardware/gesture Back should dismiss the top-most transient UI
 * (dialog, menu, sheet, drawer) before it does anything else, and only exit
 * the app when nothing is open. Every such surface registers a closer here
 * while it is open.
 */
type Closer = () => void;

const stack: Closer[] = [];

/** Registers `close` as the thing Back should do next. Returns an unregister function. */
export function pushBack(close: Closer): () => void {
  stack.push(close);
  return () => {
    const i = stack.lastIndexOf(close);
    if (i !== -1) stack.splice(i, 1);
  };
}

/** Handles one Back press. Returns true if something was closed. */
export function handleBack(): boolean {
  const close = stack.pop();
  if (!close) return false;
  close();
  return true;
}

export function backDepth(): number {
  return stack.length;
}
