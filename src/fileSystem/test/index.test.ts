import { test, before } from "node:test";
import assert from "node:assert/strict";

/**
 * Doesn't test either backend's real behavior (internal.test.ts and
 * external.test.ts already do) — just that fsOperation() sends a
 * `content://` url to the SAF backend and everything else to the local
 * one, by checking which underlying transport actually got called.
 */

let execCalls: { service: string; action: string }[] = [];
let resolveLocalCalls: string[] = [];

before(() => {
  const g = globalThis as unknown as {
    cordova: unknown;
    window: { resolveLocalFileSystemURL: unknown };
  };
  g.cordova = {
    exec(
      success: (result: unknown) => void,
      _error: unknown,
      service: string,
      action: string,
    ) {
      execCalls.push({ service, action });
      success(
        action === "listDir"
          ? []
          : {
              name: "x",
              isDirectory: false,
              size: 0,
              lastModified: 0,
              mimeType: null,
              canWrite: true,
            },
      );
    },
  };
  g.window = {
    resolveLocalFileSystemURL(url: string, success: (entry: unknown) => void) {
      resolveLocalCalls.push(url);
      success({
        isFile: true,
        isDirectory: false,
        name: "x",
        toURL: () => url,
        getMetadata: (s: (m: unknown) => void) =>
          s({ size: 0, modificationTime: new Date(0) }),
      });
    },
  } as unknown as typeof g.window;
});

const { fsOperation } = await import("../index");

test("a content:// url dispatches to the SAF (external) backend", async () => {
  execCalls = [];
  resolveLocalCalls = [];

  await fsOperation(
    "content://com.android.externalstorage.documents/tree/foo",
  ).stat();

  assert.equal(execCalls.length, 1);
  assert.equal(execCalls[0].service, "SAF");
  assert.equal(resolveLocalCalls.length, 0);
});

test("a plain path dispatches to the internal (cordova-plugin-file) backend", async () => {
  execCalls = [];
  resolveLocalCalls = [];

  await fsOperation("file:///storage/emulated/0/Download/notes.txt").stat();

  assert.equal(resolveLocalCalls.length, 1);
  assert.equal(execCalls.length, 0);
});

test("the returned FsOperation exposes the original url", () => {
  const url = "content://com.android.externalstorage.documents/tree/foo";
  assert.equal(fsOperation(url).url, url);
});
