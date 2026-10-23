import { rolldown } from "rolldown";
import {
  ENTRIES,
  createInputOptions,
  createOutputOptions,
} from "../build/config.js";
import { cleanDir } from "./clean.js";

/**
 * Each entry (boot, main) is built as its own completely independent
 * rolldown() call — see config.ts's comments for why (iife + multiple
 * entries isn't supported by rolldown at all, confirmed directly).
 *
 * www/index.html is NOT touched here — it's static, hand-written, and
 * committed (see its own comments); only www/js/ and www/css/ are build
 * output.
 */
async function build(): Promise<void> {
  process.env.NODE_ENV = "production";

  console.log("Cleaning previous build output...");
  await cleanDir("www/js");
  await cleanDir("www/css");

  for (const entry of ENTRIES) {
    console.log(`Bundling ${entry}...`);
    const bundle = await rolldown(createInputOptions(entry, { isProd: true }));
    try {
      const { output } = await bundle.write(
        createOutputOptions(entry, { isProd: true }),
      );
      for (const item of output) {
        console.log(
          `  ${item.type === "chunk" ? "js  " : "css "} ${item.fileName}`,
        );
      }
    } finally {
      await bundle.close();
    }
  }

  console.log("Build complete -> www/js, www/css");
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
