import path from "node:path";
import postcss from "postcss";
import postcssImport from "postcss-import";
import {
  transform as lightningTransform,
  browserslistToTargets,
} from "lightningcss";
import browserslist from "browserslist";
import type { Plugin, PluginContext } from "rolldown";

export interface CssPluginOptions {
  /** Minify + drop sourcemaps in production builds. */
  isProd?: boolean;
}

/**
 * Two-stage pipeline for any `import "./whatever.css"` in the app:
 *
 *  1. PostCSS + postcss-import — resolves `@import` statements, so CSS can
 *     be split into partials (src/styles/variables.css, base.css, ...) the
 *     same organizational benefit Sass partials give you, without needing
 *     Sass. This is PostCSS's *only* job here.
 *  2. LightningCSS — vendor prefixing (driven by this project's
 *     `browserslist` field in package.json), modern-syntax lowering, and
 *     minification in production. It's dramatically faster than a
 *     PostCSS-plugin-based minifier (cssnano), which is why it runs
 *     *after* PostCSS rather than PostCSS doing everything itself: PostCSS
 *     covers the one thing its plugin ecosystem is uniquely good at here
 *     (`@import` resolution), LightningCSS covers the fast final pass.
 *
 * Structurally this mirrors the reference project's scssPlugin (Sass +
 * PostCSS + autoprefixer, emitting a rolldown asset rather than inlining
 * into the JS bundle) — same shape, swapped for this project's actual
 * needs: no Sass, and LightningCSS instead of autoprefixer since it also
 * covers minification.
 */
export function cssPlugin(options: CssPluginOptions = {}): Plugin {
  const { isProd = false } = options;

  // Resolved once per build, not per file — browserslist() re-reads
  // package.json's "browserslist" field and the system browserslist
  // database each time otherwise, which is pure overhead per CSS module.
  const targets = browserslistToTargets(browserslist());

  return {
    name: "css",

    async transform(this: PluginContext, code, id) {
      if (!id.endsWith(".css")) return null;

      const imported = await postcss([postcssImport()]).process(code, {
        from: id,
        map: false,
      });

      // Rebuild when an @import-ed partial changes, not just the entry file.
      for (const message of imported.messages) {
        if (message.type === "dependency" && typeof message.file === "string") {
          this.addWatchFile?.(message.file);
        }
      }

      const { code: transformedCss } = lightningTransform({
        filename: id,
        code: Buffer.from(imported.css),
        minify: isProd,
        targets,
      });

      this.emitFile({
        type: "asset",
        // A `name`, not a `fileName` — the final path/hash is controlled by
        // output.assetFileNames in utils/build/config.ts, same as JS chunks
        // are controlled by output.entryFileNames/chunkFileNames.
        name: `${path.basename(id, path.extname(id))}.css`,
        source: transformedCss.toString(),
      });

      // The .css module contributes no JS of its own — its only job was
      // the emitted asset above. An empty module keeps `import "./app.css"`
      // valid without shipping CSS text into the JS bundle.
      return { code: "export default undefined;", map: null };
    },
  };
}
