import { JSDOM } from "jsdom";

/**
 * A jsdom page that is enough for the real xterm.js to open in. Call it
 * BEFORE importing anything that pulls in xterm (use `await import()` in a
 * `before` hook).
 *
 * jsdom has no layout and no canvas, so: `matchMedia` and the canvas 2D
 * context are stubbed, and sizes (`clientWidth`, `getBoundingClientRect`) have
 * to be set per element by the test (see `giveSize`).
 */
export function installXtermDom(): Window & typeof globalThis {
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    pretendToBeVisual: true,
    url: "http://localhost/",
  });
  const w = dom.window as unknown as Window & typeof globalThis;
  (w as unknown as Record<string, unknown>).matchMedia = (q: string) => ({
    matches: false,
    media: q,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => false,
  });
  const ctx = new Proxy(
    {},
    {
      get: (_t, p) =>
        p === "canvas"
          ? {}
          : p === "measureText"
            ? () => ({ width: 8 })
            : p === "getImageData"
              ? () => ({ data: new Uint8ClampedArray(4) })
              : () => undefined,
      set: () => true,
    },
  );
  (
    w.HTMLCanvasElement.prototype as unknown as { getContext: () => unknown }
  ).getContext = () => ctx;
  Object.assign(globalThis, {
    window: w,
    self: w,
    document: w.document,
    Node: w.Node,
    Element: w.Element,
    HTMLElement: w.HTMLElement,
    KeyboardEvent: w.KeyboardEvent,
    MouseEvent: w.MouseEvent,
    Event: w.Event,
    MutationObserver: w.MutationObserver,
    getComputedStyle: w.getComputedStyle.bind(w),
    requestAnimationFrame: w.requestAnimationFrame.bind(w),
    cancelAnimationFrame: w.cancelAnimationFrame.bind(w),
  });
  return w;
}

/** Makes `el` report a size (jsdom reports 0 for everything). */
export function giveSize(el: Element, width: number, height: number): void {
  Object.defineProperty(el, "clientWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(el, "clientHeight", {
    value: height,
    configurable: true,
  });
  (el as HTMLElement).getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: width,
      bottom: height,
      width,
      height,
      toJSON() {},
    }) as DOMRect;
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
