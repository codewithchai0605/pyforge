import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

/**
 * CodeMirror's view layer touches a fair amount of the DOM API surface
 * (MutationObserver, getComputedStyle, requestAnimationFrame, and a few
 * constructors it does `instanceof` checks against) that a bare `import
 * { JSDOM }` + assigning `globalThis.window`/`document` doesn't provide on
 * its own — importing `@codemirror/view` into the *outer* Node realm only
 * sees whatever's actually on `globalThis`, unlike code executing *inside*
 * a jsdom-managed `<script>` (which smoke-test.ts uses, and which doesn't
 * need this because jsdom's VM context already has all of this ambient).
 * This was hit and worked out for real while writing this file, not
 * assumed — see the plain `new EditorView(...)` failing with
 * "MutationObserver is not defined" before `globalThis.MutationObserver`
 * was added below.
 */
before(() => {
  const dom = new JSDOM(
    '<!doctype html><html><body><div id="host"></div></body></html>',
    { pretendToBeVisual: true },
  );
  const w = dom.window;
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = w;
  g.document = w.document;
  g.MutationObserver = w.MutationObserver;
  g.getComputedStyle = w.getComputedStyle.bind(w);
  g.requestAnimationFrame = w.requestAnimationFrame
    ? w.requestAnimationFrame.bind(w)
    : (cb: () => void) => setTimeout(cb, 16);
  g.cancelAnimationFrame = w.cancelAnimationFrame
    ? w.cancelAnimationFrame.bind(w)
    : clearTimeout;
  g.Node = w.Node;
  g.Text = w.Text;
  g.DocumentFragment = w.DocumentFragment;
  g.Range = w.Range;
  g.Element = w.Element;
  g.HTMLElement = w.HTMLElement;
});

const { EditorManager } = await import("../index");

function freshHost(): HTMLElement {
  const host = document.createElement("div");
  document.body.appendChild(host);
  return host;
}

function typeInto(
  manager: InstanceType<typeof EditorManager>,
  text: string,
): void {
  const len = manager.editor.state.doc.length;
  manager.editor.dispatch({ changes: { from: len, to: len, insert: text } });
}

test("newFile opens a tab, makes it active, and seeds its saved-content baseline", () => {
  const manager = new EditorManager(freshHost());
  const file = manager.newFile("a.txt", "hello");

  assert.equal(manager.activeFiles().length, 1);
  assert.equal(manager.activeFile()?.id, file.id);
  assert.equal(manager.getValue(), "hello");
  assert.equal(manager.getSavedContent(file.id), "hello");
  assert.equal(file.dirty(), false);
});

test("editing the active file sets its dirty flag", () => {
  const manager = new EditorManager(freshHost());
  const file = manager.newFile("a.txt", "hello");

  typeInto(manager, " world");

  assert.equal(manager.getValue(), "hello world");
  assert.equal(file.dirty(), true);
});

test("each open tab keeps its own content when switching away and back", () => {
  // This is the one design decision this whole module is built on: one
  // shared EditorView, one EditorState per file, swapped with setState()
  // rather than recreating a view per tab — see index.ts's class doc
  // comment. This test is what that decision is actually for.
  const manager = new EditorManager(freshHost());
  const a = manager.newFile("a.txt", "AAA");
  typeInto(manager, "-edited");
  assert.equal(manager.getValue(), "AAA-edited");

  const b = manager.newFile("b.txt", "BBB");
  assert.equal(manager.getValue(), "BBB");
  typeInto(manager, "-changed");
  assert.equal(manager.getValue(), "BBB-changed");

  manager.switchTo(a.id);
  assert.equal(manager.activeFile()?.id, a.id);
  assert.equal(
    manager.getValue(),
    "AAA-edited",
    "switching back to A should restore A's own edits, not B's",
  );

  manager.switchTo(b.id);
  assert.equal(
    manager.getValue(),
    "BBB-changed",
    "switching back to B should restore B's own edits",
  );
});

test("onUpdate fires on a real edit", () => {
  const manager = new EditorManager(freshHost());
  manager.newFile("a.txt", "x");

  let calls = 0;
  manager.onUpdate(() => calls++);
  typeInto(manager, "y");

  assert.ok(calls >= 1);
});

test("onUpdate fires on switchTo even though EditorView.setState() does not fire updateListener on its own", () => {
  // Verified empirically while building this (see createEditor.ts's
  // baseExtensions doc comment): EditorView.setState() does NOT trigger
  // updateListener extensions the way dispatch() does, so switchTo() has
  // to call the notification path manually. This test is what would catch
  // that call being accidentally removed — every other test in this file
  // would still pass without it, since they don't depend on the count.
  const manager = new EditorManager(freshHost());
  const a = manager.newFile("a.txt", "x");
  const b = manager.newFile("b.txt", "y");

  let calls = 0;
  manager.onUpdate(() => calls++);
  calls = 0; // newFile(b) itself just fired onUpdate via switchTo — start counting fresh

  manager.switchTo(a.id);
  assert.ok(
    calls >= 1,
    "switching tabs should notify subscribers even with no text edit involved",
  );
  void b;
});

test("onUpdate subscribers can unsubscribe", () => {
  const manager = new EditorManager(freshHost());
  manager.newFile("a.txt", "x");

  let calls = 0;
  const unsubscribe = manager.onUpdate(() => calls++);
  typeInto(manager, "y");
  assert.equal(calls, 1);

  unsubscribe();
  typeInto(manager, "z");
  assert.equal(calls, 1, "no further calls after unsubscribing");
});

test("closing a tab that is not active leaves the active one untouched", () => {
  const manager = new EditorManager(freshHost());
  const a = manager.newFile("a.txt", "A");
  const b = manager.newFile("b.txt", "B");
  manager.switchTo(a.id);

  manager.closeFile(b.id);

  assert.equal(manager.activeFile()?.id, a.id);
  assert.equal(manager.getValue(), "A");
  assert.equal(manager.activeFiles().length, 1);
});

test("closing the active tab focuses its right neighbor, falling back left", () => {
  const manager = new EditorManager(freshHost());
  const a = manager.newFile("a.txt", "A");
  const b = manager.newFile("b.txt", "B");
  const c = manager.newFile("c.txt", "C");
  manager.switchTo(b.id);

  manager.closeFile(b.id);
  assert.equal(
    manager.activeFile()?.id,
    c.id,
    "closing the middle tab should focus the one to its right",
  );

  manager.closeFile(c.id);
  assert.equal(
    manager.activeFile()?.id,
    a.id,
    "closing the last tab should fall back to the one on its left",
  );
});

test("closing the only open tab leaves nothing active", () => {
  const manager = new EditorManager(freshHost());
  const a = manager.newFile("a.txt", "A");

  manager.closeFile(a.id);

  assert.equal(manager.activeFile(), null);
  assert.equal(manager.activeFiles().length, 0);
  assert.equal(manager.getValue(), "");
});

test("goToLine moves the cursor and clamps out-of-range input", () => {
  const manager = new EditorManager(freshHost());
  manager.newFile("a.txt", "one\ntwo\nthree");

  manager.goToLine(2);
  assert.equal(
    manager.editor.state.doc.lineAt(manager.editor.state.selection.main.head)
      .number,
    2,
  );

  manager.goToLine(999);
  assert.equal(
    manager.editor.state.doc.lineAt(manager.editor.state.selection.main.head)
      .number,
    3,
    "clamps to the last line",
  );

  manager.goToLine(0);
  assert.equal(
    manager.editor.state.doc.lineAt(manager.editor.state.selection.main.head)
      .number,
    1,
    "clamps to the first line",
  );
});

test("newFile never collides with an already-open tab, even with the same name", () => {
  const manager = new EditorManager(freshHost());
  manager.newFile("untitled", "");
  manager.newFile("untitled", "");

  assert.equal(
    manager.activeFiles().length,
    2,
    "two distinct untitled tabs, not one reused tab",
  );
});
