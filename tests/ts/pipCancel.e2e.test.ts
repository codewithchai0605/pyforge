/**
 * Cancelling an install through the real chain (devRuntime -> bridge -> Python
 * host), against a local package index that serves its wheel very slowly.
 */
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createBridge } from '../../utils/dev-bridge/bridge';
import { devRuntime } from '../../src/native/pyruntime';
import { PipError, type PyRuntime } from '../../src/python/protocol';

const python = process.env.PYFORGE_PYTHON ?? 'python3';
let work: string;
let index: Server;
let bridgeServer: Server;
let runtime: PyRuntime;

before(async () => {
  work = mkdtempSync(path.join(tmpdir(), 'pyforge-cancel-'));
  const wheelPath = path.join(work, 'slowpkg-1.0-py3-none-any.whl');
  execFileSync(python, ['-c', `
import zipfile, os, sys
z = zipfile.ZipFile(sys.argv[1], 'w')
z.writestr('slowpkg/__init__.py', '')
z.writestr('slowpkg/blob.bin', os.urandom(300000))
z.writestr('slowpkg-1.0.dist-info/METADATA', 'Metadata-Version: 2.1\\nName: slowpkg\\nVersion: 1.0\\n')
z.writestr('slowpkg-1.0.dist-info/WHEEL', 'Wheel-Version: 1.0\\nRoot-Is-Purelib: true\\n')
z.writestr('slowpkg-1.0.dist-info/RECORD', '')
z.close()
`, wheelPath]);
  const wheel = readFileSync(wheelPath);

  // A fake PyPI whose only file trickles out at ~80 KB/s.
  index = createServer((req, res) => {
    const base = `http://127.0.0.1:${(index.address() as AddressInfo).port}`;
    if (req.url?.startsWith('/simple/slowpkg')) {
      res.writeHead(200, { 'content-type': 'application/vnd.pypi.simple.v1+json' });
      res.end(JSON.stringify({ files: [{ filename: 'slowpkg-1.0-py3-none-any.whl', url: `${base}/files/slowpkg.whl`, hashes: { sha256: createHash('sha256').update(wheel).digest('hex') }, yanked: false, size: wheel.length }] }));
    } else if (req.url?.startsWith('/files/')) {
      res.writeHead(200, { 'content-length': wheel.length });
      let off = 0;
      const timer = setInterval(() => {
        if (off >= wheel.length || res.destroyed) return void (clearInterval(timer), res.end());
        res.write(wheel.subarray(off, off + 8192));
        off += 8192;
      }, 100);
      res.on('close', () => clearInterval(timer));
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => index.listen(0, '127.0.0.1', r));

  process.env.PYFORGE_PYPI_URL = `http://127.0.0.1:${(index.address() as AddressInfo).port}/simple/`;
  const bridge = createBridge({ workDir: path.join(work, 'dev'), python });
  bridgeServer = createServer((req, res) => void bridge(req, res).then((h) => h || res.end()));
  await new Promise<void>((r) => bridgeServer.listen(0, '127.0.0.1', r));
  runtime = devRuntime(`http://127.0.0.1:${(bridgeServer.address() as AddressInfo).port}`);
});

after(() => {
  index.closeAllConnections();
  index.close();
  bridgeServer.close();
  rmSync(work, { recursive: true, force: true });
});

test('cancelling mid-download rejects as cancelled, quickly, and installs nothing', async () => {
  let downloading!: () => void;
  const sawBytes = new Promise<void>((r) => (downloading = r));
  const started = Date.now();

  const install = runtime.pip.install(['slowpkg'], (p) => {
    if (p.t === 'dl' && (p.done ?? 0) > 0) downloading();
  });
  const outcome = install.then(
    () => 'finished',
    (e: unknown) => (e instanceof PipError && e.cancelled ? 'cancelled' : `failed: ${e}`),
  );

  await sawBytes;
  runtime.pip.cancel();

  assert.equal(await outcome, 'cancelled');
  assert.ok(Date.now() - started < 8000, 'cancel should land long before the ~4s slow download completes');
  assert.deepEqual((await runtime.pip.list()).filter((p) => p.name === 'slowpkg'), []);
});

test('a later install works normally after a cancelled one', async () => {
  // Nothing stale (flag, partial file) may affect the next operation.
  const result = await runtime.pip.install(['slowpkg'], () => {});
  assert.deepEqual(result.installed.map((i) => i.name), ['slowpkg']);
  assert.ok((await runtime.pip.list()).some((p) => p.name === 'slowpkg'));
});
