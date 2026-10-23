import { clearRange, collectNodes, type Child } from "./dom";
import { createRoot, onCleanup, untrack } from "./reactive";

/**
 * Mounts `app()`'s result into `container` and returns `unmount()`.
 *
 * This is the piece the original version was missing entirely: `h()` gives
 * you a `Node`, but nothing ever "installed" a tree with a matching way to
 * take it back down again. Every `effect()` (signal-bound text/attributes/
 * class/style), every event listener, and every `Show`/`For`/`Portal`
 * created while building `app()`'s tree gets registered — via the same
 * ownership mechanism `createRoot()`/`onCleanup()` use — as this call's
 * responsibility, so `unmount()` actually disposes all of it instead of
 * leaving it running forever against nodes that are no longer on the page.
 *
 * The mounted content is delimited by two comment markers, and `unmount()`
 * removes everything between them — including nodes that reactive children
 * added *after* mounting, which a snapshot of the initial nodes would miss.
 *
 * ```ts
 * const unmount = render(() => h(App, null), document.getElementById('app')!);
 * // ...later, e.g. in a test, or a single-page app tearing down a route...
 * unmount();
 * ```
 */
export function render(app: () => Child, container: Element): () => void {
  return createRoot((dispose) => {
    const start = document.createComment("");
    const end = document.createComment("");
    const fragment = document.createDocumentFragment();
    fragment.append(start, ...collectNodes(untrack(app)), end);
    container.append(fragment);

    onCleanup(() => {
      clearRange(start, end);
      start.parentNode?.removeChild(start);
      end.parentNode?.removeChild(end);
    });

    return dispose;
  });
}
