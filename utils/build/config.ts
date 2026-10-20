import path from 'node:path';
import type { InputOptions, OutputOptions } from 'rolldown';
import { cssPlugin } from './plugins/css.js';

const ROOT = process.cwd();

export interface BuildFlags {
  isProd: boolean;
}

/**
 * Two entry points, each built entirely independently — see ENTRIES below
 * for why this can't just be one multi-entry build. Add another key here
 * (and to ENTRIES) if the app grows further independently-loaded entries.
 */
export type EntryName = 'main' | 'boot';

export const ENTRIES: EntryName[] = ['boot', 'main'];

/**
 * `boot` (src/boot.ts, tiny, loaded directly by the static www/index.html)
 * and `main` (src/main.ts, the real app, loaded dynamically BY boot.js —
 * see boot.ts's own comments for why).
 *
 * These are built as two SEPARATE rolldown() invocations (see
 * utils/scripts/build.ts/dev.ts), not one multi-entry build with two
 * `input` keys, because of what they load as: plain classic <script> tags,
 * not type="module" (see createOutputOptions below for why that matters).
 * `format: 'iife'` is what makes that safe, and rolldown doesn't support
 * iife for a code-splitting (multi-entry) build at all — confirmed
 * directly (INVALID_OPTION error), not assumed — so each entry needs its
 * own single-input build with codeSplitting disabled.
 */
export function createInputOptions(entry: EntryName, { isProd }: BuildFlags): InputOptions {
  return {
    input: path.resolve(ROOT, `src/${entry}.ts`),
    resolve: {
      alias: {
        // Matches tsconfig.json's "paths" — Rolldown doesn't read tsconfig
        // paths automatically, so both have to be kept in sync by hand.
        '@': path.resolve(ROOT, 'src'),
        xtags: path.resolve(ROOT, 'src/packages/xtags/src/index.ts'),
      },
    },
    plugins: [cssPlugin({ isProd })],
    platform: 'browser',
    moduleTypes: {
      // Rolldown has its own built-in .css handling based on file extension,
      // which runs *before* module-level plugin hooks and — as of the
      // installed version — hard-errors ("Bundling CSS is no longer
      // supported") rather than doing anything with it. Remapping .css to
      // the generic "empty" module type sidesteps that built-in handling
      // entirely; our own cssPlugin's transform() hook still receives the
      // raw CSS content and runs normally (verified directly against the
      // installed rolldown version, not assumed from docs).
      '.css': 'empty',
      // Forces JSX parsing in plain .js files too, not just .jsx — verified
      // directly (a standalone repro producing correct h(...) calls from a
      // .js file) rather than assumed. This does NOT extend to .ts: oxc's
      // transform can be told to do this for .ts too (moduleTypes: {'.ts':
      // 'tsx'} genuinely works at the bundler level, also verified), but
      // tsc's own PARSER cannot read JSX syntax inside a .ts file under any
      // configuration — that's a TypeScript language-grammar constraint
      // (the exact ambiguity .tsx's ban on `<Type>value` casts exists to
      // resolve), not a bundler limitation, so enabling it here would make
      // `npm run typecheck` fail with real syntax errors on any .ts file
      // that used it. TS+JSX files should stay .tsx, as everywhere else in
      // this project.
      '.js': 'jsx',
    },
    // JSX settings come from tsconfig.json. Keeping the factory in one place
    // prevents Rolldown from overriding it and emitting configuration warnings.
  };
}

/**
 * Output goes straight into www/ (js/ + css/ subfolders), which is also
 * the Cordova `www` webroot. Filenames are fixed, never content-hashed —
 * boot.ts hard-codes `js/main.js`/`css/app.css`, and www/index.html is
 * meant to be written once and never regenerated (see its own comments),
 * so there's nothing left to gain from hashing the way a web app deployed
 * behind an HTTP cache would.
 */
export function createOutputOptions(entry: EntryName, { isProd }: BuildFlags): OutputOptions {
  return {
    dir: path.resolve(ROOT, 'www'),
    // iife, not es: boot.js and main.js are loaded as plain classic
    // <script> tags (see www/index.html / boot.ts), not type="module" —
    // real Android WebView Chromium handles ESM scripts fine, but classic
    // scripts all share ONE global scope, and two independently-bundled,
    // independently-minified chunks WILL eventually collide on internal
    // variable names (verified this the hard way: a real build produced
    // "Identifier 'e' has already been declared" once both entries
    // actually got exercised together, not a hypothetical). iife wraps
    // each bundle in its own closure, eliminating that collision — the
    // standard, correct fix for "multiple independent classic scripts on
    // one page", not an ESM-specific workaround.
    format: 'iife',
    codeSplitting: false,
    entryFileNames: `js/${entry}.js`,
    assetFileNames: 'css/[name][extname]',
    sourcemap: !isProd,
    minify: isProd,
  };
}
