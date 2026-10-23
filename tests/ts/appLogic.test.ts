import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { searchText } from "../../src/components/searchPanel";
import {
  memoryEnsureDirectory,
  memorySnapshot,
} from "../../src/fileSystem/backends/memory";
import { memoryFs } from "../../src/fileSystem/backends/memory";
import { createWorkspace } from "../../src/workspace";
import { noneRuntime } from "../../src/native/pyruntime";
import { tkKeysym } from "../../src/components/displayView";

test("searchText: plain text is literal, case-insensitive by default", () => {
  const m = searchText("Price: $5 (USD)\nprice again", "price", {
    matchCase: false,
    regex: false,
  });
  assert.deepEqual(
    m.map((x) => [x.line, x.start, x.end]),
    [
      [1, 0, 5],
      [2, 0, 5],
    ],
  );
  assert.equal(
    searchText("a.b\naxb", "a.b", { matchCase: true, regex: false }).length,
    1,
  ); // "." is not a wildcard
  assert.equal(
    searchText("$5 (x)", "$5 (x)", { matchCase: true, regex: false }).length,
    1,
  );
});

test("searchText: match case, regex mode, bad patterns, zero-width matches", () => {
  assert.equal(
    searchText("Foo foo", "foo", { matchCase: true, regex: false }).length,
    1,
  );
  assert.equal(
    searchText("def f(): pass\ndef g(): pass", "^def \\w", {
      matchCase: true,
      regex: true,
    }).length,
    2,
  );
  assert.throws(
    () => searchText("x", "(", { matchCase: false, regex: true }),
    /Invalid pattern/,
  );
  assert.deepEqual(
    searchText("abc", "^", { matchCase: false, regex: true }),
    [],
  ); // must terminate
});

test("searchText caps matches per file", () => {
  assert.equal(
    searchText("x\n".repeat(500), "x", { matchCase: true, regex: false })
      .length,
    100,
  );
});

test("memory filesystem: create, write, read, rename (with children), delete (recursive)", async () => {
  const root = memoryEnsureDirectory("mem://t1");
  const dir = await memoryFs(root).createDirectory("pkg");
  const file = await memoryFs(dir.url).createFile("a.py");
  await memoryFs(file.url).writeFile("print(1)");
  assert.equal(await memoryFs(file.url).readFile(), "print(1)");
  await assert.rejects(memoryFs(dir.url).createFile("a.py"), /already exists/);

  await memoryFs(dir.url).rename("lib");
  assert.equal(await memoryFs("mem://t1/pkg").exists(), false);
  assert.equal(await memoryFs("mem://t1/lib/a.py").readFile(), "print(1)");
  assert.deepEqual(memorySnapshot(root), { "lib/a.py": "print(1)" });

  await memoryFs("mem://t1/lib").delete();
  assert.deepEqual(memorySnapshot(root), {});
  await assert.rejects(
    memoryFs("mem://t1/lib/a.py").readFile(),
    /No such file/,
  );
});

test("dev workspace: seeds main.py and builds run requests with every file plus the live buffer", async () => {
  const dom = new JSDOM("");
  Object.assign(globalThis, { window: dom.window });
  const ws = await createWorkspace(noneRuntime(), {
    python: "3.12.0",
    android: false,
    abi: null,
    api: 0,
    cp: "cp312",
    site: "/s",
    projects: "/host/projects",
  });
  assert.equal(ws.kind, "dev");
  const entries = await memoryFs(ws.rootUrl).listDir();
  assert.deepEqual(
    entries.map((e) => e.name),
    ["main.py"],
  );

  const helper = await memoryFs(ws.rootUrl).createFile("util.py");
  await memoryFs(helper.url).writeFile("X = 1");
  const req = ws.buildRunRequest(
    `${ws.rootUrl}/main.py`,
    "main.py",
    "import util  # unsaved edit",
  );
  assert.equal(req.path, "main.py");
  assert.equal(req.files!["util.py"], "X = 1");
  assert.equal(req.files!["main.py"], "import util  # unsaved edit"); // buffer wins over disk

  assert.equal(ws.relativePath(`${ws.rootUrl}/util.py`), "util.py");
  assert.equal(
    ws.urlForPythonPath("/host/projects/util.py"),
    `${ws.rootUrl}/util.py`,
  );
  assert.equal(ws.urlForPythonPath("/usr/lib/python3/os.py"), null);
  const scratch = ws.buildRunRequest(null, "untitled.py", "print()");
  assert.equal(scratch.path, ".scratch/untitled.py");
});

test("tkKeysym maps DOM key names to the Tk names turtle.onkey expects", () => {
  assert.deepEqual(
    ["ArrowUp", " ", "Enter", "a", "Escape", "Backspace"].map(tkKeysym),
    ["Up", "space", "Return", "a", "Escape", "BackSpace"],
  );
});
