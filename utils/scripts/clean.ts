import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';

const TARGETS = ['www/js', 'www/css'];

/** Recreates a single build-output directory empty. Exported so build.ts/dev.ts can reuse it. */
export async function cleanDir(relPath: string): Promise<void> {
  const full = path.resolve(process.cwd(), relPath);
  await rm(full, { recursive: true, force: true });
  await mkdir(full, { recursive: true });
}

async function cleanAll(): Promise<void> {
  for (const target of TARGETS) {
    await cleanDir(target);
  }
  console.log(`Cleaned: ${TARGETS.join(', ')}`);
}

// Runs cleanAll() only when invoked directly (`tsx utils/scripts/clean.ts`),
// not when build.ts/dev.ts import cleanDir from this file.
if (import.meta.url === `file://${process.argv[1]}`) {
  cleanAll();
}
