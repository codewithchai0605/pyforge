import { test, before, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

/**
 * A trimmed-down version of internal.test.ts's fixture: walkFiles() only
 * ever calls listDir() (via fsOperation -> internalFs), so this fake only
 * needs to support directory listing and the createFile/createDirectory
 * calls used to build each test's tree — no writer/blob/rename/delete
 * machinery. Unlike internal.test.ts's fixture (a flat `fake:///${name}`
 * namespace, fine for its single-level trees), URLs here are built from the
 * full path from the root, since these tests specifically exercise nested
 * directories where two files can share a name in different folders.
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
});

const { internalFs } = await import("../backends/internal");
const { walkFiles, DEFAULT_IGNORED_DIR_NAMES } = await import("../walk");

class FakeFile {
  readonly isFile = true;
  readonly isDirectory = false;
  readonly fullPath: string;
  blob: Blob;
  constructor(
    public name: string,
    parent: FakeDirectory,
    content = "",
  ) {
    this.fullPath = parent.fullPath ? `${parent.fullPath}/${name}` : name;
    this.blob = new windowRef.Blob([content]);
  }
  toURL() {
    return `fake:///${this.fullPath}`;
  }
  getMetadata(
    success: (meta: { size: number; modificationTime: Date }) => void,
  ) {
    success({ size: this.blob.size, modificationTime: new Date(0) });
  }
  file(success: (file: File) => void) {
    success(new windowRef.File([this.blob], this.name));
  }
}

class FakeDirectory {
  readonly isFile = false;
  readonly isDirectory = true;
  readonly fullPath: string;
  children: (FakeFile | FakeDirectory)[] = [];
  constructor(
    public name: string,
    parent: FakeDirectory | null = null,
  ) {
    this.fullPath = parent
      ? parent.fullPath
        ? `${parent.fullPath}/${name}`
        : name
      : "";
  }
  toURL() {
    return `fake:///${this.fullPath}/`;
  }
  getMetadata(
    success: (meta: { size: number; modificationTime: Date }) => void,
  ) {
    success({ size: 0, modificationTime: new Date(0) });
  }
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
    if (existing) return success(existing as FakeFile);
    if (!options.create) return error(`not found: ${name}`);
    const created = new FakeFile(name, this);
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
    if (existing) return success(existing as FakeDirectory);
    if (!options.create) return error(`not found: ${name}`);
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
    globalThis.window as unknown as { resolveLocalFileSystemURL: unknown }
  ).resolveLocalFileSystemURL = (
    url: string,
    success: (entry: unknown) => void,
    error: (err: unknown) => void,
  ) => {
    const entry = buildIndex().get(url);
    if (entry) success(entry);
    else error(`not found: ${url}`);
  };
});

async function makeTree(spec: Record<string, string | null>): Promise<void> {
  // spec maps a slash-separated path to file *content* (irrelevant here,
  // walkFiles never reads it) or null for a directory. Parents are created
  // implicitly, in whatever order Object.entries gives them, since
  // createDirectory/createFile below both no-op on an already-existing entry.
  for (const [path, content] of Object.entries(spec)) {
    const parts = path.split("/");
    let dir = root.toURL();
    for (let i = 0; i < parts.length - 1; i++) {
      const segment = parts[i]!;
      try {
        const created = await internalFs(dir).createDirectory(segment);
        dir = created.url;
      } catch {
        dir = `${dir.replace(/\/$/, "")}/${segment}/`;
      }
    }
    const name = parts[parts.length - 1]!;
    if (content === null) {
      await internalFs(dir).createDirectory(name);
    } else {
      await internalFs(dir).createFile(name);
    }
  }
}

test("finds files at the top level", async () => {
  await makeTree({ "a.txt": "", "b.txt": "" });
  const result = await walkFiles(root.toURL());
  assert.deepEqual(result.files.map((f) => f.path).sort(), ["a.txt", "b.txt"]);
  assert.equal(result.truncated, false);
});

test("recurses into subdirectories and builds slash-separated relative paths", async () => {
  await makeTree({ "src/main.ts": "", "src/lib/util.ts": "", "README.md": "" });
  const result = await walkFiles(root.toURL());
  assert.deepEqual(result.files.map((f) => f.path).sort(), [
    "README.md",
    "src/lib/util.ts",
    "src/main.ts",
  ]);
});

test("each file keeps a usable url alongside its display path", async () => {
  await makeTree({ "src/main.ts": "" });
  const result = await walkFiles(root.toURL());
  const file = result.files.find((f) => f.path === "src/main.ts");
  assert.ok(file);
  assert.equal(await internalFs(file.url).readFile(), "");
});

test("skips default-ignored directory names like node_modules", async () => {
  await makeTree({ "node_modules/some-pkg/index.js": "", "src/main.ts": "" });
  const result = await walkFiles(root.toURL());
  assert.deepEqual(
    result.files.map((f) => f.path),
    ["src/main.ts"],
  );
});

test("ignoreDirNames: [] opts back into searching everything", async () => {
  await makeTree({ "node_modules/some-pkg/index.js": "" });
  const result = await walkFiles(root.toURL(), { ignoreDirNames: [] });
  assert.deepEqual(
    result.files.map((f) => f.path),
    ["node_modules/some-pkg/index.js"],
  );
});

test("stops at maxFiles and reports truncated", async () => {
  await makeTree({ "a.txt": "", "b.txt": "", "c.txt": "", "d.txt": "" });
  const result = await walkFiles(root.toURL(), { maxFiles: 2 });
  assert.equal(result.files.length, 2);
  assert.equal(result.truncated, true);
});

test("an empty tree returns no files and is not truncated", async () => {
  const result = await walkFiles(root.toURL());
  assert.deepEqual(result.files, []);
  assert.equal(result.truncated, false);
});

test("DEFAULT_IGNORED_DIR_NAMES matches this project's own build/tooling directories", () => {
  for (const name of [
    ".git",
    "node_modules",
    "target",
    "www",
    "platforms",
    "plugins",
  ]) {
    assert.ok(DEFAULT_IGNORED_DIR_NAMES.includes(name));
  }
});
