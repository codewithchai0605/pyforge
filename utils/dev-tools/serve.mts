/**
 * Static server for www/ plus the desktop Python bridge, on a fixed port.
 * Used by snap.sh for screenshots; `npm run dev` is the everyday equivalent.
 *   PYFORGE_PYTHON=python3 npx tsx utils/dev-tools/serve.mts [port] [workDir]
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { createBridge } from '../dev-bridge/bridge';

const port = Number(process.argv[2] ?? 4177);
const www = path.resolve('www');
const TYPES: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const bridge = createBridge({ workDir: process.argv[3] ?? '/tmp/pyforge-shot-work' });

createServer((req, res) => {
  void bridge(req, res).then((handled) => {
    if (handled) return;
    const file = path.join(www, new URL(req.url ?? '/', 'http://x').pathname.replace(/^\/$/, '/index.html'));
    if (!file.startsWith(www) || !existsSync(file)) return void res.writeHead(404).end();
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream' }).end(readFileSync(file));
  });
}).listen(port, '127.0.0.1', () => console.log(`serving http://127.0.0.1:${port}`));
