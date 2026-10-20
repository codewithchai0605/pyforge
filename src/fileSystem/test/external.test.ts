import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

/**
 * SafPlugin.java can't run outside a real Android device — what IS worth
 * verifying here is externalFs's half of the contract: does it call
 * cordova.exec with the right service/action/argument shape for each
 * FsOperation method, and does it map SafEntry fields to FileEntry/
 * FileStats correctly.
 */

interface ExecCall {
  service: string;
  action: string;
  args: unknown[];
}

let calls: ExecCall[] = [];
let nextResult: unknown;

before(() => {
  (globalThis as unknown as { cordova: unknown }).cordova = {
    exec(success: (result: unknown) => void, _error: unknown, service: string, action: string, args: unknown[]) {
      calls.push({ service, action, args });
      success(nextResult);
    },
  };
});

beforeEach(() => {
  calls = [];
  nextResult = undefined;
});

const { externalFs } = await import('../backends/external');

const SAMPLE_ENTRY = {
  url: 'content://com.android.externalstorage.documents/document/primary%3ADownload%2Fa.txt',
  name: 'a.txt',
  isDirectory: false,
  size: 42,
  lastModified: 1_700_000_000_000,
  mimeType: 'text/plain',
  canWrite: true,
};

test('stat() calls the SAF plugin and maps fields to FileStats', async () => {
  nextResult = SAMPLE_ENTRY;
  const stats = await externalFs(SAMPLE_ENTRY.url).stat();

  assert.deepEqual(calls[0], { service: 'SAF', action: 'stat', args: [SAMPLE_ENTRY.url] });
  assert.deepEqual(stats, {
    name: 'a.txt',
    isDirectory: false,
    size: 42,
    lastModified: 1_700_000_000_000,
    mimeType: 'text/plain',
    canWrite: true,
  });
});

test('listDir() maps each entry to FileEntry, including the url', async () => {
  nextResult = [SAMPLE_ENTRY];
  const entries = await externalFs('content://tree-root').listDir();

  assert.equal(calls[0].action, 'listDir');
  assert.deepEqual(entries[0], {
    name: 'a.txt',
    isDirectory: false,
    url: SAMPLE_ENTRY.url,
    size: 42,
    lastModified: 1_700_000_000_000,
    mimeType: 'text/plain',
  });
});

test('readFile() passes the encoding argument through, defaulting to utf8', async () => {
  nextResult = 'file contents';
  await externalFs(SAMPLE_ENTRY.url).readFile();
  assert.deepEqual(calls[0], { service: 'SAF', action: 'readFile', args: [SAMPLE_ENTRY.url, 'utf8'] });

  await externalFs(SAMPLE_ENTRY.url).readFile('base64');
  assert.deepEqual(calls[1], { service: 'SAF', action: 'readFile', args: [SAMPLE_ENTRY.url, 'base64'] });
});

test('writeFile() passes content and encoding through in order', async () => {
  await externalFs(SAMPLE_ENTRY.url).writeFile('hello', 'base64');
  assert.deepEqual(calls[0], { service: 'SAF', action: 'writeFile', args: [SAMPLE_ENTRY.url, 'hello', 'base64'] });
});

test('createFile()/createDirectory() pass the parent url and name, and map the created entry', async () => {
  nextResult = SAMPLE_ENTRY;
  const created = await externalFs('content://tree-root').createFile('a.txt', 'text/plain');
  assert.deepEqual(calls[0], { service: 'SAF', action: 'createFile', args: ['content://tree-root', 'a.txt', 'text/plain'] });
  assert.equal(created.name, 'a.txt');

  await externalFs('content://tree-root').createDirectory('sub');
  assert.deepEqual(calls[1], { service: 'SAF', action: 'createDirectory', args: ['content://tree-root', 'sub'] });
});

test('delete() and rename() call the right actions', async () => {
  await externalFs(SAMPLE_ENTRY.url).delete();
  assert.deepEqual(calls[0], { service: 'SAF', action: 'delete', args: [SAMPLE_ENTRY.url] });

  nextResult = { ...SAMPLE_ENTRY, name: 'b.txt' };
  const renamed = await externalFs(SAMPLE_ENTRY.url).rename('b.txt');
  assert.deepEqual(calls[1], { service: 'SAF', action: 'rename', args: [SAMPLE_ENTRY.url, 'b.txt'] });
  assert.equal(renamed.name, 'b.txt');
});

test('exists() is true when stat() succeeds and false when it rejects', async () => {
  nextResult = SAMPLE_ENTRY;
  assert.equal(await externalFs(SAMPLE_ENTRY.url).exists(), true);

  (globalThis as unknown as { cordova: { exec: (success: unknown, error: (err: unknown) => void) => void } }).cordova.exec = (
    _success: unknown,
    error: (err: unknown) => void,
  ) => error('not found');
  assert.equal(await externalFs(SAMPLE_ENTRY.url).exists(), false);

  // restore the working mock for any tests that run after this one
  (globalThis as unknown as { cordova: unknown }).cordova = {
    exec(success: (result: unknown) => void, _error: unknown, service: string, action: string, args: unknown[]) {
      calls.push({ service, action, args });
      success(nextResult);
    },
  };
});
