// Deliberately plain JavaScript, not TypeScript: this file is meant to be
// `import`-ed directly by a consumer's own build script (an ordinary Node
// ESM file, e.g. `esbuild.config.mjs`), which has no TypeScript loader of
// its own. Every other module in this package is raw `.ts` because it's
// only ever read *by* esbuild/tsc, which understand TypeScript natively —
// this one is read by plain Node itself, so it has to already be JS.
//
// See the "JSX without .jsx/.tsx files" section of README.md for the
// full write-up, including what this trades away with `tsc`.

import { fileURLToPath } from 'node:url';

/**
 * Per-extension esbuild loader overrides that make JSX syntax parse in
 * plain `.js`/`.ts`/`.mjs`/`.mts` files too, not just `.jsx`/`.tsx`.
 *
 * `.js`/`.mjs` -> `'jsx'` is uncontroversial: esbuild (like Babel) never
 * treated JSX-in-`.js` as ambiguous with anything else, so this just turns
 * on parsing esbuild already knows how to do.
 *
 * `.ts`/`.mts` -> `'tsx'` is the one worth knowing about: TypeScript's own
 * compiler refuses `<div>` in a `.ts` file on purpose, because `<Foo>bar`
 * is *also* valid TS as an old-style type assertion, and the two can't be
 * told apart from a `.ts` file's syntax alone — so tsc bans JSX there
 * entirely rather than guess. esbuild has the same ambiguity, but instead
 * of banning it, it just lets *you* pick which reading applies, per
 * extension, via `loader`. Forcing `.ts` through the `tsx` loader answers
 * that ambiguity in JSX's favor for every `.ts` file esbuild bundles.
 *
 * The real cost: `tsc --noEmit` (run standalone, the way this repo's own
 * `npm run typecheck` does) still refuses to *parse* a `.ts` file
 * containing JSX — that restriction lives in tsc itself and nothing in an
 * esbuild config can change it. A `.ts` file using this trick needs to be
 * excluded from tsc's `include`/`files` (see tsconfig.json's `exclude` in
 * examples/app), which means it also loses tsc's type-checking, not just
 * its JSX-parsing ban. Keep files that lean on real generics/overloads/
 * strict prop-shape checking as ordinary `.ts`/`.tsx`; reach for this on
 * simple view files where losing that safety net is a fine trade for not
 * having to name the file `.tsx`.
 */
export const xtagsLoaders = {
  '.js': 'jsx',
  '.jsx': 'jsx',
  '.mjs': 'jsx',
  '.ts': 'tsx',
  '.tsx': 'tsx',
  '.mts': 'tsx',
};

/**
 * Filesystem path to jsx-shim.ts, next to this file — the module
 * `xtagsEsbuildOptions()` injects so `h`/`Fragment` are available in every
 * bundled file with no explicit import. Exported mainly so you can compose
 * your own esbuild options from scratch instead of using
 * `xtagsEsbuildOptions()`; most consumers won't need this directly.
 */
export const xtagsJsxShimPath = fileURLToPath(new URL('./jsx-shim.ts', import.meta.url));

/**
 * Spreadable esbuild `BuildOptions` (a plain object — this module never
 * imports the `esbuild` package itself, so using it doesn't add a
 * dependency beyond whatever version of esbuild you already have) that:
 *
 *  - targets xtags' `h`/`Fragment` as esbuild's classic JSX factory/
 *    fragment, so `<div>`/`<>` compile to calls into xtags;
 *  - extends JSX parsing to plain `.js`/`.ts` files via `xtagsLoaders`
 *    above, not just `.jsx`/`.tsx`;
 *  - `inject`s jsx-shim.ts, so files using JSX don't need
 *    `import { h, Fragment } from 'xtags'` at the top at all.
 *
 * ```js
 * // esbuild.config.mjs
 * import * as esbuild from 'esbuild';
 * import { xtagsEsbuildOptions } from 'xtags/esbuild';
 *
 * await esbuild.build({
 *   entryPoints: ['src/main.js'],   // a .js file, no JSX pragma comment,
 *   outfile: 'public/bundle.js',    // no import of h/Fragment — see below
 *   bundle: true,
 *   ...xtagsEsbuildOptions(),
 * });
 * ```
 *
 * ```js
 * // src/main.js — plain .js, nothing imported from 'xtags' at all
 * const el = <div>Hello</div>;
 * document.body.append(el);
 * ```
 *
 * Pass `overrides` to merge in your own `loader`/`inject` entries (both
 * merge rather than replace) or override anything else (e.g. `jsxFactory`,
 * if you're aliasing `h` to something else — replaces, since there's only
 * one factory).
 *
 * @param {{ loader?: Record<string, string>, inject?: string[], [key: string]: unknown }} [overrides]
 * @returns {Record<string, unknown>}
 */
export function xtagsEsbuildOptions(overrides = {}) {
  const { loader, inject, ...rest } = overrides;
  return {
    jsx: 'transform',
    jsxFactory: 'h',
    jsxFragment: 'Fragment',
    loader: { ...xtagsLoaders, ...loader },
    inject: [xtagsJsxShimPath, ...(inject ?? [])],
    ...rest,
  };
}
