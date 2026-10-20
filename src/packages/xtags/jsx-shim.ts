// Injected into every bundled file by `xtagsEsbuildOptions()` (see
// esbuild.mjs, next to this file) via esbuild's `inject` option. `inject`
// makes whatever a file exports by name available as a free variable
// everywhere in the bundle that doesn't already define/import that name
// itself — so `h`/`Fragment`, the two names esbuild's classic JSX
// transform compiles `<div>...</div>`/`<>...</>` down to, are available in
// every file being bundled without an explicit
// `import { h, Fragment } from 'xtags'` at the top of each one.
//
// A file that *does* still write that import explicitly is unaffected:
// its own local `h`/`Fragment` bindings shadow the injected ones, same as
// any other local declaration would.
export { h, Fragment } from './src/dom';
