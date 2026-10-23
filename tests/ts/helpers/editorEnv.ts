import { JSDOM } from "jsdom";

/**
 * A jsdom page with everything CodeMirror reaches for, installed as globals.
 * Call it BEFORE importing anything from src/ (use `await import()` in a
 * `before` hook): CodeMirror sniffs the browser when it loads.
 *
 * jsdom has no layout, so Range geometry is stubbed to "nothing"; the editor
 * then falls back to its no-measurement paths, which is what these tests want.
 */
export function installDom(): Window & typeof globalThis {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
  });
  const w = dom.window as unknown as Window & typeof globalThis;
  const range = w.Range.prototype as unknown as Record<string, unknown>;
  range.getClientRects = () => [];
  range.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    width: 0,
    height: 0,
  });
  Object.assign(globalThis, {
    window: w,
    document: w.document,
    Window: w.Window,
    Node: w.Node,
    Text: w.Text,
    Element: w.Element,
    HTMLElement: w.HTMLElement,
    DocumentFragment: w.DocumentFragment,
    Range: w.Range,
    Event: w.Event,
    KeyboardEvent: w.KeyboardEvent,
    InputEvent: w.InputEvent,
    MouseEvent: w.MouseEvent,
    MutationObserver: w.MutationObserver,
    getComputedStyle: w.getComputedStyle.bind(w),
    requestAnimationFrame: w.requestAnimationFrame.bind(w),
    cancelAnimationFrame: w.cancelAnimationFrame.bind(w),
  });
  return w;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
