import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

/**
 * cordova-plugin-file's real Entry/DirectoryReader/FileWriter objects only
 * exist on-device — there's no way to run genuinely against them here. What
 * IS real and worth exercising: internal.ts's own logic sitting on top of
 * that API (directory-read pagination, the truncate-then-write sequencing
 * needed to *overwrite* rather than append, and base64/text encoding) — so
 * this test fakes the Cordova-specific objects with a small in-memory tree,
 * but hands internal.ts jsdom's REAL Blob/File/FileReader/atob to do the
 * actual byte-level work, same objects a real WebView would use.
 */

let windowRef: InstanceType<typeof JSDOM>["window"];

before(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  windowRef = dom.window;
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = dom.window;
  g.Blob = dom.window.Blob;
  g.File = dom.window.File;
  g.FileReader = dom.window.FileReader;
  // Deliberately NOT overriding atob/btoa with jsdom's versions — jsdom's
  // own implementation was confirmed (via a standalone repro, not assumed)
  // to throw "invalid characters" on some valid byte sequences that Node's
  // own native atob/btoa (spec-compliant, globally available since Node 16)
  // handle correctly. internal.ts calls the bare global atob/btoa, so in
  // this Node-based test that's Node's own implementation — which is what
  // we want here regardless.
});

const { internalFs } = await import("../backends/internal");

// --- A minimal in-memory stand-in for cordova-plugin-file's Entry family ---

class FakeWriter {
  onwriteend: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(private target: FakeFile) {}

  truncate(_size: number): void {
    this.target.blob = new windowRef.Blob([]);
    queueMicrotask(() => this.onwriteend?.({}));
  }

  write(blob: Blob): void {
    this.target.blob = blob;
    queueMicrotask(() => this.onwriteend?.({}));
  }

  seek(_offset: number): void {}
}

class FakeFile {
  readonly isFile = true;
  readonly isDirectory = false;
  blob: Blob;

  constructor(
    public name: string,
    content: string,
    public parent: FakeDirectory,
  ) {
    this.blob = new windowRef.Blob([content]);
  }

  toURL() {
    return `fake:///${this.name}`;
  }

  getMetadata(
    success: (meta: { size: number; modificationTime: Date }) => void,
  ) {
    success({ size: this.blob.size, modificationTime: new Date(0) });
  }

  getParent(success: (entry: FakeDirectory) => void) {
    success(this.parent);
  }

  remove(success: () => void) {
    this.parent.children = this.parent.children.filter((c) => c !== this);
    success();
  }

  moveTo(
    parent: FakeDirectory,
    newName: string | undefined,
    success: (entry: FakeFile) => void,
  ) {
    this.parent.children = this.parent.children.filter((c) => c !== this);
    if (newName) this.name = newName;
    this.parent = parent;
    parent.children.push(this);
    success(this);
  }

  file(success: (file: File) => void) {
    success(new windowRef.File([this.blob], this.name));
  }

  createWriter(success: (writer: FakeWriter) => void) {
    success(new FakeWriter(this));
  }
}

class FakeDirectory {
  readonly isFile = false;
  readonly isDirectory = true;
  children: (FakeFile | FakeDirectory)[] = [];

  constructor(
    public name: string,
    public parent: FakeDirectory | null = null,
  ) {}

  toURL() {
    return `fake:///${this.name}/`;
  }

  getMetadata(
    success: (meta: { size: number; modificationTime: Date }) => void,
  ) {
    success({ size: 0, modificationTime: new Date(0) });
  }

  getParent(
    success: (entry: FakeDirectory) => void,
    error: (err: unknown) => void,
  ) {
    if (!this.parent) {
      error("no parent");
      return;
    }
    success(this.parent);
  }

  remove(success: () => void) {
    if (this.parent)
      this.parent.children = this.parent.children.filter((c) => c !== this);
    success();
  }

  moveTo(
    parent: FakeDirectory,
    newName: string | undefined,
    success: (entry: FakeDirectory) => void,
  ) {
    if (this.parent)
      this.parent.children = this.parent.children.filter((c) => c !== this);
    if (newName) this.name = newName;
    this.parent = parent;
    parent.children.push(this);
    success(this);
  }

  /** Deliberately hands back one entry per call (never the whole list at
   *  once) — readEntries() is spec'd as paginated, and a backend that only
   *  ever calls it once wouldn't actually prove the pagination loop works. */
  createReader() {
    let index = 0;
    const children = this.children;
    return {
      readEntries(success: (entries: (FakeFile | FakeDirectory)[]) => void) {
        const batch = index < children.length ? [children[index]] : [];
        index++;
        success(batch);
      },
    };
  }

  getFile(
    name: string,
    options: { create?: boolean },
    success: (entry: FakeFile) => void,
    error: (err: unknown) => void,
  ) {
    const existing = this.children.find((c) => c.name === name && c.isFile);
    if (existing) {
      success(existing as FakeFile);
      return;
    }
    if (!options.create) {
      error(`not found: ${name}`);
      return;
    }
    const created = new FakeFile(name, "", this);
    this.children.push(created);
    success(created);
  }

  getDirectory(
    name: string,
    options: { create?: boolean },
    success: (entry: FakeDirectory) => void,
    error: (err: unknown) => void,
  ) {
    const existing = this.children.find(
      (c) => c.name === name && c.isDirectory,
    );
    if (existing) {
      success(existing as FakeDirectory);
      return;
    }
    if (!options.create) {
      error(`not found: ${name}`);
      return;
    }
    const created = new FakeDirectory(name, this);
    this.children.push(created);
    success(created);
  }
}

let root: FakeDirectory;

beforeEach(() => {
  root = new FakeDirectory("root");

  function buildIndex(): Map<string, FakeFile | FakeDirectory> {
    const byUrl = new Map<string, FakeFile | FakeDirectory>();
    byUrl.set(root.toURL(), root);
    (function walk(dir: FakeDirectory) {
      for (const child of dir.children) {
        byUrl.set(child.toURL(), child);
        if (child.isDirectory) walk(child as FakeDirectory);
      }
    })(root);
    return byUrl;
  }

  (
    windowRef as unknown as { resolveLocalFileSystemURL: unknown }
  ).resolveLocalFileSystemURL = (
    url: string,
    success: (entry: unknown) => void,
    error: (err: unknown) => void,
  ) => {
    // Rebuilt from scratch on every call — a Map that only ever grew would
    // keep "resolving" an entry's old URL even after it was deleted, since
    // nothing would ever prune it back out.
    const entry = buildIndex().get(url);
    if (entry) success(entry);
    else error(`not found: ${url}`);
  };
});

test("writeFile then readFile round-trips plain text", async () => {
  const fs = internalFs(root.toURL());
  const created = await fs.createFile("notes.txt");

  const file = internalFs(created.url);
  await file.writeFile("hello world");
  assert.equal(await file.readFile(), "hello world");
});

test("writeFile overwrites rather than appends (truncate-then-write sequencing)", async () => {
  const fs = internalFs(root.toURL());
  const created = await fs.createFile("notes.txt");
  const file = internalFs(created.url);

  await file.writeFile("a much longer first value");
  await file.writeFile("short");

  assert.equal(
    await file.readFile(),
    "short",
    "leftover bytes from the longer first write must not remain",
  );
});

test("base64 write/read round-trips exactly, including through real Blob/FileReader", async () => {
  const fs = internalFs(root.toURL());
  const created = await fs.createFile("data.bin");
  const file = internalFs(created.url);

  const original = "hello \u00e9\u00e8 world"; // includes non-ASCII to exercise byte-level correctness
  const base64 = btoa(unescape(encodeURIComponent(original)));

  await file.writeFile(base64, "base64");
  const roundTripped = await file.readFile("base64");
  const decoded = decodeURIComponent(escape(atob(roundTripped)));

  assert.equal(roundTripped, base64);
  assert.equal(decoded, original);
});

test("listDir paginates correctly across multiple readEntries() calls", async () => {
  const fs = internalFs(root.toURL());
  await fs.createFile("a.txt");
  await fs.createFile("b.txt");
  await fs.createDirectory("sub");

  const entries = await fs.listDir();
  const names = entries.map((e) => e.name).sort();

  assert.deepEqual(names, ["a.txt", "b.txt", "sub"]);
  const dirEntry = entries.find((e) => e.name === "sub");
  assert.equal(dirEntry?.isDirectory, true);
});

test("delete removes the entry", async () => {
  const fs = internalFs(root.toURL());
  const created = await fs.createFile("temp.txt");
  const file = internalFs(created.url);

  assert.equal(await file.exists(), true);
  await file.delete();
  assert.equal(await file.exists(), false);
});

test("rename updates the name and returns the (possibly new) url", async () => {
  const fs = internalFs(root.toURL());
  const created = await fs.createFile("old.txt");
  const file = internalFs(created.url);

  const renamed = await file.rename("new.txt");
  assert.equal(renamed.name, "new.txt");

  const atNewUrl = internalFs(renamed.url);
  assert.equal(await atNewUrl.exists(), true);
});

test("stat reports isDirectory correctly for both files and directories", async () => {
  const fs = internalFs(root.toURL());
  const file = await fs.createFile("f.txt");
  const dir = await fs.createDirectory("d");

  assert.equal((await internalFs(file.url).stat()).isDirectory, false);
  assert.equal((await internalFs(dir.url).stat()).isDirectory, true);
});

test("exists() is false for a url that was never created", async () => {
  const fs = internalFs("fake:///root/does-not-exist.txt");
  assert.equal(await fs.exists(), false);
});
