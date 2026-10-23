// Companion declaration file for esbuild.mjs (which is deliberately plain
// JS, not TS — see its top comment). Kept in sync by hand since it's a
// small, stable surface.

/**
 * Per-extension esbuild loader overrides that make JSX syntax parse in
 * plain `.js`/`.ts`/`.mjs`/`.mts` files too, not just `.jsx`/`.tsx`. See
 * esbuild.mjs for the full explanation.
 */
export const xtagsLoaders: {
  ".js": "jsx";
  ".jsx": "jsx";
  ".mjs": "jsx";
  ".ts": "tsx";
  ".tsx": "tsx";
  ".mts": "tsx";
};

/** Filesystem path to jsx-shim.ts, next to esbuild.mjs. */
export const xtagsJsxShimPath: string;

export interface XtagsEsbuildOverrides {
  loader?: Record<string, string>;
  inject?: string[];
  [key: string]: unknown;
}

/**
 * Spreadable esbuild `BuildOptions` (returned as a plain object) wiring
 * xtags' `h`/`Fragment` up as esbuild's classic JSX factory/fragment,
 * extending JSX parsing to plain `.js`/`.ts` files, and auto-injecting
 * `h`/`Fragment` so files using JSX don't need to import them. See
 * esbuild.mjs for the full explanation and a usage example.
 */
export function xtagsEsbuildOptions(
  overrides?: XtagsEsbuildOverrides,
): Record<string, unknown>;
