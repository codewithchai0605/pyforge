# xtags

Hyperscript + fine-grained signals for DOM UI. A tiny in-house replacement
for `html-tag-js`: instead of building a DOM subtree once and mutating it
by hand afterward, a signal passed as a prop or child keeps the relevant
node/attribute updating itself for as long as it's mounted.

```ts
import { h, signal, render } from 'xtags';

const count = signal(0);

const App = () =>
  h('button', { onClick: () => count.update((n) => n + 1) }, 'clicked ', count, ' times');

render(() => h(App, null), document.getElementById('app')!);
```

Or the same thing in JSX (see `examples/app` for a full esbuild setup):

```tsx
const App = () => (
  <button onClick={() => count.update((n) => n + 1)}>clicked {count} times</button>
);
```

## Core API

- `h(type, props, ...children)` — build a DOM node, or call a component
  function. `type` is either a tag name string or a `(props) => Node`
  function.
- `signal(initial)` — a reactive value. Call it to read (`count()`),
  `.set(next)` to write, `.update(fn)` for `set(fn(current))`, `.peek()` to
  read without subscribing the active effect.
- `effect(fn)` — runs `fn` immediately and again whenever a signal it read
  changes. Returns a `dispose()` function. If `fn` returns a function,
  that's cleanup, run before every re-run and on dispose.
- `computed(fn)` — a read-only signal derived from other signals.
- `Fragment`, `Show`, `Switch`/`Match`, `For`, `Portal` — see below.
- `createContext`/`useContext` — see below.
- `onMount(fn)` — see below.
- `render(app, container)` — mount `app()`'s result into `container` and
  get back an `unmount()` that tears down every effect/listener created for
  that tree.

## Control flow

**`Show`** toggles between two pre-built branches without rebuilding them:

```tsx
<Show when={() => user() !== null} fallback="Please log in">
  Welcome back, {() => user()!.name}
</Show>
```

`when` accepts any zero-arg function — a `Signal`, a `computed()`, or a
plain closure like the one above; you don't need to wrap a derived boolean
in `computed()` just to satisfy the type.

**`For`** does keyed list rendering — the item this project's original
README listed under "not implemented yet":

```tsx
<For each={todos} key={(todo) => todo.id}>
  {(todo, index) => <li>{index}. {todo.text}</li>}
</For>
```

Items are matched by `key` (defaulting to the item itself) across renders,
so an item that only *moved* gets moved in the DOM, not rebuilt — state,
focus, and CSS transitions on an unaffected row survive a list update.

> **Calling `For` directly (no JSX)?** Write `h(For<Item>, {...})`, not
> `h(For, {...})`. `For` has its own type parameter (`<T>(props:
> ForProps<T>) => Node`), and JSX's `<For>` only type-checks it correctly
> because TypeScript's JSX checker validates a tag against the component's
> own signature directly, bypassing `h()`'s declared type entirely. A
> plain `h(For, {...})` call goes through `h()`'s actual overload instead,
> and TypeScript can't infer a generic function's own type parameter
> through a second, unrelated generic that way — `item`/`index` silently
> become `unknown` with no error at the `h()` call site itself, only where
> you go on to use them. Naming the type argument explicitly (a
> TypeScript 4.7+ *instantiation expression*) sidesteps the inference
> gap entirely. This only matters for `For`, or any other component
> that's itself generic — `h(Show, {...})` etc. need no such workaround.

**`Switch`/`Match`** is an N-way `Show`, for more than two mutually
exclusive branches:

```tsx
<Switch fallback={<p>Unknown status</p>}>
  <Match when={() => status() === 'loading'}><Spinner /></Match>
  <Match when={() => status() === 'error'}><ErrorBanner /></Match>
  <Match when={() => status() === 'ready'}><Results /></Match>
</Switch>
```

Same "pre-built, toggled, not rebuilt" behavior as `Show`. `Match` only
makes sense as a direct child of `Switch` — on its own it doesn't build any
DOM at all.

**`Portal`** renders its children into a different container (e.g.
`document.body`, for a modal that needs to escape an `overflow: hidden`
ancestor) while staying owned by wherever it was declared, so it's cleaned
up when that owner unmounts:

```tsx
<Portal mount={document.body}>
  <div class="modal">{...}</div>
</Portal>
```

## Context

`createContext`/`useContext` — a way to pass a value down to any depth of
descendant without threading it through every component's props:

```tsx
const ThemeContext = createContext<Signal<'light' | 'dark'>>(theme);

const App = () => (
  <ThemeContext.Provider value={theme}>
    {() => <Toolbar />}
  </ThemeContext.Provider>
);

const Toolbar = () => {
  const theme = useContext(ThemeContext); // the Signal itself
  return <div class={theme}>...</div>;    // still reactive from here down
};
```

`Provider`'s `children` has to be a *function* (`{() => <Toolbar />}`), not
a `<Toolbar />` passed directly — `h()` evaluates JSX children before
calling the component they're passed to, so a directly-nested `<Toolbar/>`
would already have run (and already called `useContext` too early to see
`value`) by the time `Provider` gets a chance to make it visible. Passing
it as a thunk defers that call until `Provider` is the one invoking it.
`Provider` throws a clear error at runtime if you get this wrong, rather
than silently reading the outer/default value.

`useContext` is a plain, one-time lookup done while a descendant is being
built — same as reading any other prop. Passing a `Signal` (rather than a
plain value) as `value`, like the example above, is what makes a context
stay live as it changes; `useContext` itself doesn't add any reactivity of
its own.

## onMount

Runs a callback once, deferred to the next microtask — after whatever
synchronous mounting step (`document.body.append(el)`, `render()`, ...) the
caller was about to do has actually happened. Useful for anything that
needs a *live* node, not just a constructed one: focusing an input,
measuring layout, handing a `<canvas>` to a third-party library.

```tsx
const Input = () => {
  let el!: HTMLInputElement;
  onMount(() => el.focus());
  return <input ref={(node: HTMLInputElement) => (el = node)} />;
};
```

If the enclosing scope is disposed before the microtask fires, the
callback is skipped instead of running against an already-torn-down tree.

## Forms

Every element's `value`/`checked`/`selected`/`indeterminate` are bound as
live DOM *properties* when given a signal, not just attributes — so
`value={someSignal}` keeps a text input "controlled" even after the user
has typed in it (a plain `setAttribute('value', ...)` stops affecting a
field's displayed value the moment the user edits it; the property doesn't
have that problem).

For two-way binding, use `model`:

```tsx
<input model={name} />                          {/* string signal <-> .value  */}
<input type="checkbox" model={agreedToTerms} /> {/* boolean signal <-> .checked */}
```

Event props accept a plain handler (`onClick={fn}`) or a
`[handler, options]` tuple for `capture`/`once`/`passive`:

```tsx
<div onClick={[handleClick, { capture: true }]} />
```

## SVG

`h('svg', ...)` and every standard SVG tag (`circle`, `path`, `g`, ...) are
created in the SVG namespace automatically — this didn't work at all in the
original version, since every element was created with plain
`document.createElement`, which produces an inert, non-rendering element
for SVG tag names.

## Reactivity internals

- `batch(fn)` — coalesce multiple signal writes into a single notification
  pass, so an effect depending on several of them re-runs once instead of
  once per write.
- `untrack(fn)` — read signals inside `fn` without subscribing the active
  effect. `Signal.peek()` is the one-signal shorthand for the same thing.
- `onCleanup(fn)` / `createRoot(fn)` — the ownership/disposal system.
  `onCleanup` registers a teardown with whichever scope is currently
  active (the current effect's run, or the current `createRoot()`/
  `render()`); `createRoot` opens one of those scopes and hands you a
  `dispose()` that runs every cleanup registered while it was open. Every
  `effect()` auto-registers its own disposal with the ambient scope this
  way — it's what makes `render()`'s `unmount()` actually work, instead of
  every signal-bound attribute/listener/`Show`/`For` created while building
  a tree running forever even after that tree is gone from the page.

## What's still not here

On purpose, for a tiny library:

- Server-side rendering / hydration.
- Async/Suspense-style data-fetching integration.
- A minimal-moves list diff (`For`'s reordering is correct for any
  add/remove/move, but isn't LIS-optimized — fine for typical list sizes,
  not tuned for very large ones).

## JSX without `.jsx`/`.tsx` files

`h`/`Fragment` are just plain functions — nothing about xtags itself cares
what a file is named. The only reason JSX syntax normally has to live in a
`.jsx`/`.tsx` file is that `.js`/`.ts` files are, by default, parsed
*without* JSX support (tsc actively refuses it in `.ts`, since `<Foo>bar`
is also valid TypeScript as an old-style type assertion, and the two can't
be told apart from a `.ts` file's syntax alone). `xtags/esbuild` turns JSX
parsing on for `.js`/`.ts` files anyway, and throws in auto-injected
`h`/`Fragment` so you don't even need to import them:

```js
// esbuild.config.mjs
import * as esbuild from 'esbuild';
import { xtagsEsbuildOptions } from 'xtags/esbuild';

await esbuild.build({
  entryPoints: ['src/main.js'],
  outfile: 'public/bundle.js',
  bundle: true,
  ...xtagsEsbuildOptions(),
});
```

```js
// src/main.js — a plain .js file. No import of h/Fragment anywhere.
const el = <div>Hello</div>;
document.body.append(el);
```

That works today, as-is — `test/jsx-in-plain-files.test.ts` builds and runs
fixtures just like this one with real esbuild + jsdom as part of this
package's own test suite, and `examples/app/src/plain-js-demo.js` /
`plain-ts-demo.ts` do the same thing as part of the example app.

`xtagsEsbuildOptions(overrides?)` returns a plain, spreadable options
object (it doesn't import the `esbuild` package itself, so using it adds
no dependency beyond whatever version of esbuild you already have) that:

- targets `h`/`Fragment` as esbuild's classic JSX factory/fragment;
- overrides esbuild's per-extension `loader` so `.js`/`.mjs` parse as
  `'jsx'` and `.ts`/`.mts` parse as `'tsx'`, instead of their defaults;
- `inject`s a small shim (`xtags/jsx-shim`) so `h`/`Fragment` are available
  as free variables in every bundled file, without an explicit import. A
  file that *does* still import them explicitly is unaffected — its own
  local binding shadows the injected one, same as any local declaration.

Pass `overrides` to merge in your own `loader`/`inject` entries, or replace
anything else (`jsxFactory`, etc).

### The trade-off with `tsc`

This is a genuine bundler-level trick, not a tsc feature — `tsc --noEmit`,
run standalone (the way `npm run typecheck` does), still refuses to *parse*
a `.ts` file containing JSX. That restriction lives in tsc's parser itself;
nothing in an esbuild config can turn it off. A `.ts` file leaning on this
needs to be kept out of tsc's `include`/`files` (see
`examples/app/tsconfig.json`'s `exclude` for exactly this, applied to
`src/plain-ts-demo.ts`) — which means it also loses tsc's type-checking for
that file, not just the JSX-parsing ban specifically. `.js` files aren't
affected by this at all (they're not typically part of a tsc project's
`include` set in the first place, unless `allowJs` is on).

In practice: keep files that lean on real generics, overloads, or strict
prop-shape checking as ordinary `.ts`/`.tsx`. Reach for this on simple view
files, small scripts, or a codebase that's plain JS already (Babel-style
setups have never had this restriction for `.js` — this only closes the
gap for `.ts`) — anywhere losing tsc's parse-level safety net for that one
file is a fine trade for not having to name it `.tsx`.

One more thing worth knowing: this needs a bundler whose *loader
configuration* you control. It works with esbuild directly (as above), and
the same idea carries over to Vite (which uses esbuild under the hood —
see its `esbuild`/`optimizeDeps.esbuildOptions` config) or any other setup
where you can override the per-extension loader/transform. It does **not**
work with zero-config script runners like plain `tsx`/`ts-node` used to
*run* a file directly (rather than bundle it) — those intentionally mirror
tsc's restriction and don't expose a loader override, so a `.ts` file with
JSX in it will still fail to parse under `node --import tsx some-file.ts`.
This package's own test suite runs that way, which is why its JSX tests
live in `.test.tsx` files and the plain-`.js`/`.ts` JSX fixtures are only
ever built by a real esbuild invocation inside the test, never run
directly through the `tsx`-powered test runner.

## Development

```sh
npm install       # from the repo root — see the root README
npm test          # --workspace=xtags, or just `npm test` from this folder
npm run typecheck
```
