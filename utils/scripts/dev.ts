import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import chokidar from 'chokidar';
import { rolldown } from 'rolldown';
import { ENTRIES, createInputOptions, createOutputOptions } from '../build/config.js';
import { cleanDir } from './clean.js';
import { createBridge } from '../dev-bridge/bridge.js';

// `npm run dev` vs `npm run dev:android` — redeploy to a connected
// device/emulator on every rebuild instead of (or alongside) browser preview.
const target = process.argv[2];

let building = false;
let queued = false;

async function rebuild(): Promise<void> {
  if (building) {
    queued = true;
    return;
  }
  building = true;

  try {
    console.log('Rebuilding...');
    for (const entry of ENTRIES) {
      const bundle = await rolldown(createInputOptions(entry, { isProd: false }));
      try {
        await bundle.write(createOutputOptions(entry, { isProd: false }));
      } finally {
        await bundle.close();
      }
    }
    console.log('Rebuild done.');

    if (target === 'android') deployToAndroid();
  } catch (err) {
    console.error('Rebuild failed:', err);
  } finally {
    building = false;
    if (queued) {
      queued = false;
      void rebuild();
    }
  }
}

function deployToAndroid(): void {
  // Requires the Cordova CLI plus a connected device/emulator with the
  // android platform already added (`cordova platform add android`).
  const cordova = spawn('cordova', ['run', 'android', '--nobuild'], {
    stdio: 'inherit',
    shell: true,
  });
  cordova.on('error', (err) => {
    console.warn('Could not run `cordova run android` — is the Cordova CLI installed?', err.message);
  });
}

// Minimal static file server for www/ — no HMR, no dependency beyond
// Node's own http module. Refresh your browser after a rebuild finishes.
const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

function serve(port: number): void {
  const root = path.resolve(process.cwd(), 'www');
  // Desktop Python behind /__py/* so the browser preview can really run code.
  const bridge = createBridge();

  const server = createServer(async (req, res) => {
    if (await bridge(req, res)) return;
    try {
      const requestedPath = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname);
      let filePath = path.join(root, requestedPath);

      const stats = await stat(filePath).catch(() => null);
      if (!stats || stats.isDirectory()) filePath = path.join(root, 'index.html');

      const body = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME_TYPES[path.extname(filePath)] ?? 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
    }
  });

  server.listen(port, () => {
    console.log(`[serve] http://localhost:${port} (serving www/ + Python bridge at /__py; no HMR — refresh manually after rebuilds)`);
  });
}

async function main(): Promise<void> {
  await cleanDir('www/js');
  await cleanDir('www/css');
  await rebuild();

  if (target !== 'android') {
    serve(Number(process.env.PORT ?? 5173));
  }

  const watcher = chokidar.watch([path.resolve('src')], { ignoreInitial: true });
  watcher.on('all', (event, file) => {
    console.log(`[watch] ${event}: ${file}`);
    void rebuild();
  });

  console.log('Watching src/ for changes. Press Ctrl+C to stop.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
