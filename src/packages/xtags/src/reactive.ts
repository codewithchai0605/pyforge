/**
 * A small, from-scratch fine-grained reactive core (signals + effects),
 * in the SolidJS/@preact/signals lineage but written independently for this
 * project. This is the part that makes xtags a genuine step up from
 * html-tag-js: html-tag-js's `tag()` builds a DOM subtree once, from
 * whatever values you hand it, and never touches it again — updating
 * anything later means you keep your own reference and mutate it by hand.
 * xtags lets a signal be passed directly as a prop or child, and the
 * relevant DOM node/attribute updates itself whenever the signal changes.
 *
 * Correctness note: a naive version of this (signal keeps a Set of
 * subscribers, effect adds itself, never removes itself) leaks stale
 * subscriptions the moment an effect's dependencies change across runs
 * (e.g. a conditional that reads signal A on one run and signal B on the
 * next). This implementation clears each effect's previous dependency set
 * before every re-run, so it only ever depends on what it *actually* read
 * last time — see the automated tests in ../test/reactive.test.ts.
 *
 * Ownership/disposal: every effect created while some `createRoot()` (or
 * an outer effect) is active auto-registers its own dispose() with that
 * enclosing scope, via the same `onCleanup()` mechanism a user can call
 * directly. This is what lets `render()` (see render.ts) hand back a
 * single `unmount()` that actually tears down every effect and event
 * listener created for a tree, instead of leaking all of it forever —
 * the original version had no such mechanism at all: nothing created by
 * `h()`/`Show()` could ever be disposed once built.
 */

export interface Signal<T> {
  (): T;
  readonly __isSignal: true;
  /** Replaces the value. No-ops (and doesn't notify) if `Object.is` says it's unchanged. */
  set(next: T): void;
  /** Convenience for `set(fn(current))`. */
  update(fn: (current: T) => T): void;
  /** Reads the current value without subscribing the active effect. */
  peek(): T;
}

interface Subscriber {
  execute(): void;
  /** Every signal's subscriber-set that this run added itself to, so the
   *  next run can remove itself cleanly before re-subscribing. */
  deps: Set<Set<Subscriber>>;
}

let activeSubscriber: Subscriber | null = null;

/**
 * Re-runs one subscriber from a notification pass. A throwing binding is
 * reported and skipped so it can't stop the *other* subscribers of the same
 * signal (or the code that called `set()`) from running — one broken view
 * shouldn't freeze the rest of the UI. Errors from an effect's *first* run
 * (construction time) still propagate to the caller as usual.
 */
function run(sub: Subscriber): void {
  try {
    sub.execute();
  } catch (err) {
    console.error("[xtags] error in reactive update", err);
  }
}

// --- batching --------------------------------------------------------------

let batchDepth = 0;
const pendingNotifications = new Set<Subscriber>();

/**
 * Runs `fn`, deferring every signal notification triggered inside it until
 * `fn` returns, and coalescing repeat notifications to the same subscriber
 * into a single re-run. Without this, setting three signals that a single
 * effect depends on runs that effect three times in a row; wrapped in
 * `batch()`, it runs once, after all three writes have landed.
 *
 * Nesting is supported: only the outermost `batch()` call actually flushes.
 *
 * This is a simple flush (insertion order, no dependency-graph topological
 * sort) — good enough for a tiny library, but a diamond-shaped dependency
 * graph can still see a brief inconsistent intermediate read inside the
 * batch itself, same as the unbatched behavior.
 */
export function batch(fn: () => void): void {
  batchDepth++;
  try {
    fn();
  } finally {
    batchDepth--;
    if (batchDepth === 0 && pendingNotifications.size > 0) {
      const subs = [...pendingNotifications];
      pendingNotifications.clear();
      for (const sub of subs) run(sub);
    }
  }
}

/**
 * Runs `fn` without subscribing the currently-active effect to any signal
 * `fn` reads. `Signal.peek()` is the single-signal shorthand for this; use
 * `untrack()` when you need to read several signals, or arbitrary code that
 * happens to read signals, without creating a dependency (e.g. inside an
 * event handler, or an effect that should re-run on A but only *read* B).
 */
export function untrack<T>(fn: () => T): T {
  const previous = activeSubscriber;
  activeSubscriber = null;
  try {
    return fn();
  } finally {
    activeSubscriber = previous;
  }
}

export function signal<T>(initial: T): Signal<T> {
  let value = initial;
  const subscribers = new Set<Subscriber>();

  const read = (() => {
    if (activeSubscriber) {
      subscribers.add(activeSubscriber);
      activeSubscriber.deps.add(subscribers);
    }
    return value;
  }) as Signal<T>;

  Object.defineProperty(read, "__isSignal", { value: true });

  read.set = (next: T) => {
    if (Object.is(next, value)) return;
    value = next;
    if (batchDepth > 0) {
      for (const sub of subscribers) pendingNotifications.add(sub);
      return;
    }
    // Snapshot first: an effect's own execute() may resubscribe (add itself
    // back to `subscribers`) while we're in the middle of iterating it.
    for (const sub of [...subscribers]) run(sub);
  };

  read.update = (fn) => read.set(fn(value));
  read.peek = () => value;

  return read;
}

function clearDeps(sub: Subscriber) {
  for (const depSet of sub.deps) depSet.delete(sub);
  sub.deps.clear();
}

// --- ownership / cleanup scopes ---------------------------------------------

/**
 * A cleanup scope is just "something `onCleanup()` can push a function
 * onto". Both `createRoot()` and every individual effect run push one of
 * these while they're active, so `onCleanup()` always attaches to whichever
 * is innermost: called from inside a running effect body, it attaches to
 * that run (fires before the next re-run, and on dispose); called from
 * component-construction code with no enclosing effect but an enclosing
 * `createRoot()`/`render()`, it attaches to that root instead (fires once,
 * on unmount).
 */
interface CleanupScope {
  push(fn: () => void): void;
}

const scopeStack: CleanupScope[] = [];

/**
 * Registers `fn` to run when the innermost enclosing scope is torn down:
 * the current effect's next re-run/dispose if called from inside a running
 * effect, or the current `createRoot()`/`render()` root if called from
 * plain component-construction code. A no-op if nothing is currently
 * active — e.g. at module top level — since there's no scope to attach to.
 */
export function onCleanup(fn: () => void): void {
  scopeStack[scopeStack.length - 1]?.push(fn);
}

/**
 * Opens a disposal scope: `fn` runs immediately, receiving a `dispose()`
 * function that — when called — runs every cleanup registered (directly or
 * via a nested effect) while `fn` was running, in reverse order. This is
 * the building block `render()` uses to hand back a working `unmount()`;
 * reach for it directly when you're building your own component helpers
 * and want the same "one dispose() tears down everything" guarantee.
 */
export function createRoot<T>(fn: (dispose: () => void) => T): T {
  const cleanups: Array<() => void> = [];
  let disposed = false;

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    const fns = cleanups.splice(0);
    for (const cleanupFn of fns.reverse()) cleanupFn();
  };

  const scope: CleanupScope = { push: (cleanupFn) => cleanups.push(cleanupFn) };
  scopeStack.push(scope);
  try {
    return fn(dispose);
  } finally {
    scopeStack.pop();
  }
}

/**
 * Runs `fn` immediately, tracking every signal it reads, and re-runs it
 * whenever any of those signals change. If `fn` returns a function, that's
 * treated as cleanup and run before every re-run and on dispose — the same
 * convention React effects use, for the same reason (e.g. removing a native
 * event listener you added last run). `onCleanup()` calls made *during*
 * `fn`'s execution do the same thing, and can be more convenient when a
 * single run needs to register more than one cleanup.
 *
 * `fn`'s return type is deliberately typed as `unknown`, not
 * `void | (() => void)`: an expression-bodied arrow like
 * `() => array.push(x)` returns a number, not void, and forcing every
 * effect body to be block-bodied just to dodge that would be worse
 * ergonomics than just checking `typeof result === 'function'` at runtime
 * (see execute() below) — which is what actually decides whether a
 * returned value is treated as cleanup.
 *
 * If an enclosing `createRoot()` (or another effect) is active when
 * `effect()` is called, this effect's own dispose() is automatically
 * registered with it — so disposing the root also disposes every effect
 * created while building the tree underneath it. Returns that same
 * dispose function too, for manual/standalone use (as all existing calls
 * in this codebase do — no enclosing root required).
 */
export function effect(fn: () => unknown): () => void {
  let teardown: Array<() => void> = [];
  // `signal.set` notifies from a *snapshot* of subscribers. If an earlier
  // subscriber in the same pass tears down a region, effects it just disposed
  // are still in that snapshot; without this flag they would run once more
  // (reading state the region's condition already ruled out) and re-subscribe.
  let disposed = false;

  function runTeardown() {
    const fns = teardown;
    teardown = [];
    for (const cleanupFn of fns.reverse()) cleanupFn();
  }

  const sub: Subscriber = {
    deps: new Set(),
    execute() {
      if (disposed) return;
      clearDeps(sub);
      runTeardown();
      const previousSubscriber = activeSubscriber;
      activeSubscriber = sub;
      const scope: CleanupScope = {
        push: (cleanupFn) => teardown.push(cleanupFn),
      };
      scopeStack.push(scope);
      try {
        const result = fn();
        // Only treat the return value as cleanup if it's actually callable —
        // an effect body is free to return anything (or nothing) incidentally
        // (e.g. `() => array.push(x)` returns a number), and that must not
        // be invoked as if it were teardown.
        if (typeof result === "function") teardown.push(result as () => void);
      } finally {
        scopeStack.pop();
        activeSubscriber = previousSubscriber;
      }
    },
  };

  sub.execute();

  const dispose = () => {
    disposed = true;
    clearDeps(sub);
    runTeardown();
  };

  // Register with whatever scope was active when effect() was *called*
  // (note: sub.execute() above already pushed/popped its own scope, so by
  // this point the stack is back to the caller's scope, not this effect's
  // own run) — this is what makes nested effects/roots dispose together.
  onCleanup(dispose);

  return dispose;
}

/** A read-only signal derived from other signals, recomputed on the fly. */
export function computed<T>(fn: () => T): Signal<T> {
  const result = signal<T>(undefined as unknown as T);
  effect(() => {
    result.set(fn());
  });
  return result;
}

/**
 * Unwraps a value that may be given plainly or as an accessor/Signal
 * (`T | (() => T)`). For props that are never themselves functions.
 */
export function read<T>(value: T | (() => T)): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

export function isSignal(value: unknown): value is Signal<unknown> {
  return (
    typeof value === "function" &&
    (value as Partial<Signal<unknown>>).__isSignal === true
  );
}

/**
 * Runs `fn` once, deferred to the next microtask. Everything in this
 * library mounts synchronously — `h()` builds a real `Node` immediately,
 * `render()`/`document.body.append(el)`/etc. attach it immediately — so by
 * the time a microtask fires, whatever synchronous mounting step the
 * caller was going to do has always already happened. That makes "next
 * microtask" a reliable stand-in for "after this node is actually in
 * `document`", useful for anything that needs a *live* node rather than
 * just a constructed one: focusing an input, measuring layout, handing a
 * `<canvas>` to a third-party library.
 *
 * If the enclosing scope (an effect's next run, or a `render()`/
 * `createRoot()`'s `dispose()`) tears down before the microtask fires,
 * `fn` is skipped instead of running against an already-torn-down tree.
 * `fn` runs inside its own root, so a function it returns — or any
 * `onCleanup()` it registers, or effect it creates — is torn down when the
 * enclosing scope is (the equivalent of `useEffect(() => { …; return cleanup }, [])`).
 */
export function onMount(fn: () => unknown): void {
  let disposed = false;
  let teardown: (() => void) | undefined;
  onCleanup(() => {
    disposed = true;
    teardown?.();
  });
  queueMicrotask(() => {
    if (disposed) return;
    // Run inside its own root: effects/onCleanup() created by `fn` are owned
    // by the mount, and a returned function is registered as its cleanup.
    teardown = createRoot((dispose) => {
      const result = fn();
      if (typeof result === "function") onCleanup(result as () => void);
      return dispose;
    });
  });
}

/**
 * Explicit-dependency effect — the signal-model equivalent of
 * `useEffect(fn, [deps])`.
 *
 * `source` is tracked; `fn` is **not** (anything it reads is untracked), and
 * it runs again only when `source`'s value changes (`Object.is`; an array
 * returned from `source` counts as changed whenever any dependency changed,
 * like a fresh deps array). `fn` receives the new and previous value, and a
 * function it returns (or `onCleanup()` calls it makes) runs before the next
 * call and when the owner is disposed.
 *
 * Runs once immediately, synchronously, at construction — before the node is
 * attached. Use `onMount` for anything that needs a live node. Pass
 * `{ defer: true }` to skip that first run.
 *
 * ```ts
 * watch(() => [tab().id, active()], ([id, on]) => { if (on) subscribe(id); });
 * ```
 */
export function watch<T>(
  source: () => T,
  fn: (value: T, previous: T | undefined) => unknown,
  options: { defer?: boolean } = {},
): () => void {
  const value$ = computed(source);
  let first = true;
  let previous: T | undefined;
  return effect(() => {
    const value = value$();
    const prev = previous;
    const isFirst = first;
    first = false;
    previous = value;
    if (isFirst && options.defer) return undefined;
    return untrack(() => fn(value, prev));
  });
}
