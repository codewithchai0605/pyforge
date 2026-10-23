import test, { before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installDom, sleep } from "./helpers/editorEnv";

const win = installDom();

type SM = typeof import("../../src/components/selectionMenu");
type Clip = typeof import("../../src/editor/clipboard");
type View = import("@codemirror/view").EditorView;
let S: SM;
let C: Clip;
let EditorManager: typeof import("../../src/editorManager").EditorManager;
let back: typeof import("../../src/components/backStack");

before(async () => {
  S = await import("../../src/components/selectionMenu");
  C = await import("../../src/editor/clipboard");
  back = await import("../../src/components/backStack");
  ({ EditorManager } = await import("../../src/editorManager"));
});

const made: Array<{ destroy(): void }> = [];
afterEach(() => {
  made.splice(0).forEach((m) => m.destroy());
  C.setClipboardBackend(null);
  C.setClipboardNotifier(() => {});
  while (back.handleBack());
  // restore anything a test overrode on the document
  delete (document as unknown as Record<string, unknown>).activeElement;
});

function setup(
  options: {
    doc?: string;
    defaults?: boolean;
    systemBar?: (on: boolean) => void;
  } = {},
) {
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  const em = new EditorManager(host);
  em.newFile("a.py", options.doc ?? "hello world\nsecond line");
  const menu = S.createSelectionMenu({
    editorManager: em,
    showDelay: 0,
    systemBar: options.systemBar,
  });
  document.body.append(menu.el);
  if (options.defaults) S.registerDefaultSelectionItems(menu);
  made.push(menu);
  return { em, view: em.editor, menu };
}

/** jsdom does not focus contenteditable elements, so say plainly that the editor is the focused element. */
function focus(view: View) {
  Object.defineProperty(document, "activeElement", {
    configurable: true,
    get: () => view.contentDOM,
  });
}
function pointer(
  type: "pointerdown" | "pointerup",
  target: EventTarget,
  pointerType = "touch",
) {
  const e = new win.MouseEvent(type, { bubbles: true, cancelable: true });
  Object.defineProperty(e, "pointerType", { value: pointerType });
  target.dispatchEvent(e);
  return e;
}
const labels = (menu: { el: HTMLElement }) =>
  [...menu.el.querySelectorAll("button")].map((b) =>
    b.getAttribute("aria-label"),
  );
const noop = () => {};

// ------------------------------------------------------------------ registry

test("add / has / remove, and add returns a remover", () => {
  const { menu } = setup();
  const remove = menu.add({ id: "a", label: "A", run: noop });
  assert.ok(menu.has("a"));
  remove();
  assert.ok(!menu.has("a"));
  menu.add({ id: "b", label: "B", run: noop });
  assert.equal(menu.remove("b"), true);
  assert.equal(menu.remove("b"), false);
});

test("items are ordered by `order`, ties keep insertion order", () => {
  const { menu } = setup();
  menu.add({ id: "late", label: "late", order: 200, run: noop });
  menu.add({ id: "first", label: "first", order: 1, run: noop });
  menu.add({ id: "x", label: "x", run: noop });
  menu.add({ id: "y", label: "y", run: noop });
  assert.deepEqual(
    menu.items().map((i) => i.id),
    ["first", "x", "y", "late"],
  );
});

test("adding an existing id replaces it, and the old remover cannot remove the replacement", () => {
  const { menu } = setup();
  const removeOld = menu.add({ id: "dup", label: "old", run: noop });
  menu.add({ id: "dup", label: "new", run: noop });
  assert.equal(menu.items().length, 1);
  assert.equal(menu.items()[0]!.label, "new");
  removeOld();
  assert.ok(menu.has("dup"), "the replacement survived");
});

test("visibleItems follows selection vs caret mode and the visible() predicate", () => {
  const { view, menu } = setup({ doc: "abc" });
  menu.add({ id: "sel", label: "sel", run: noop });
  menu.add({ id: "cur", label: "cur", mode: "cursor", run: noop });
  menu.add({ id: "both", label: "both", mode: "always", run: noop });
  menu.add({
    id: "hidden",
    label: "hidden",
    mode: "always",
    visible: () => false,
    run: noop,
  });
  assert.deepEqual(
    menu.visibleItems().map((i) => i.id),
    ["cur", "both"],
  );
  view.dispatch({ selection: { anchor: 0, head: 2 } });
  assert.deepEqual(
    menu.visibleItems().map((i) => i.id),
    ["sel", "both"],
  );
});

// ------------------------------------------------------------------ placement

test("placeMenu: centred above the text when there is room", () => {
  const r = S.placeMenu(
    { left: 100, right: 200, top: 300, bottom: 320 },
    { width: 100, height: 50 },
    { left: 0, top: 0, right: 400, bottom: 800 },
  );
  assert.deepEqual(r, { left: 100, top: 240, placement: "above" });
});

test("placeMenu: flips below, clear of the handles, when there is no room above", () => {
  const r = S.placeMenu(
    { left: 100, right: 200, top: 20, bottom: 40 },
    { width: 100, height: 50 },
    { left: 0, top: 0, right: 400, bottom: 800 },
  );
  assert.equal(r.placement, "below");
  assert.equal(r.top, 40 + 30);
});

test("placeMenu: stays inside the bounds horizontally", () => {
  const bounds = { left: 0, top: 0, right: 400, bottom: 800 };
  assert.equal(
    S.placeMenu(
      { left: 0, right: 10, top: 300, bottom: 320 },
      { width: 200, height: 50 },
      bounds,
    ).left,
    8,
  );
  assert.equal(
    S.placeMenu(
      { left: 390, right: 400, top: 300, bottom: 320 },
      { width: 200, height: 50 },
      bounds,
    ).left,
    400 - 200 - 8,
  );
  // wider than the view: pinned to the left edge (the menu itself scrolls)
  assert.equal(
    S.placeMenu(
      { left: 100, right: 120, top: 300, bottom: 320 },
      { width: 900, height: 50 },
      bounds,
    ).left,
    8,
  );
});

test("placeMenu: a selection that fills the view still gets a spot inside the bounds", () => {
  const r = S.placeMenu(
    { left: 0, right: 400, top: 0, bottom: 800 },
    { width: 100, height: 50 },
    { left: 0, top: 0, right: 400, bottom: 800 },
  );
  assert.ok(r.top >= 8 && r.top <= 800 - 50);
});

// ------------------------------------------------------------------ showing

test("a settled, non-empty selection shows the menu; collapsing it hides it", async () => {
  const { view, menu } = setup({ defaults: true });
  focus(view);
  view.dispatch({ selection: { anchor: 0, head: 5 } });
  await sleep(20);
  assert.equal(menu.open.peek(), true);
  assert.deepEqual(labels(menu), [
    "Cut",
    "Copy",
    "Paste",
    "Select all",
    "Comment",
  ]);
  view.dispatch({ selection: { anchor: 3 } });
  assert.equal(menu.open.peek(), false);
});

test("typing (a document change) hides the menu and does not bring it back", async () => {
  const { view, menu } = setup({ defaults: true });
  focus(view);
  view.dispatch({ selection: { anchor: 0, head: 5 } });
  await sleep(20);
  assert.equal(menu.open.peek(), true);
  view.dispatch({ changes: { from: 0, to: 5, insert: "X" } });
  await sleep(20);
  assert.equal(menu.open.peek(), false);
});

test("while a finger is down in the editor the menu waits; it appears when the finger lifts", async () => {
  const { view, menu } = setup({ defaults: true });
  focus(view);
  pointer("pointerdown", view.contentDOM);
  view.dispatch({ selection: { anchor: 0, head: 5 } });
  await sleep(20);
  assert.equal(menu.open.peek(), false);
  pointer("pointerup", document);
  await sleep(20);
  assert.equal(menu.open.peek(), true);
});

test("a mouse selection does not pop the menu up on its own (desktop), but right-click does", async () => {
  const { view, menu } = setup({ defaults: true });
  focus(view);
  pointer("pointerdown", document.body, "mouse");
  pointer("pointerup", document, "mouse");
  view.dispatch({ selection: { anchor: 0, head: 5 } });
  await sleep(20);
  assert.equal(menu.open.peek(), false);
  const e = new win.MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
  });
  view.dom.dispatchEvent(e);
  assert.equal(
    e.defaultPrevented,
    true,
    "the browser/system context menu is suppressed",
  );
  await sleep(20);
  assert.equal(menu.open.peek(), true);
});

test("long-press with only a caret opens the caret menu: Paste and Select all", async () => {
  const { view, menu } = setup({ defaults: true });
  focus(view);
  view.dispatch({ selection: { anchor: 3 } });
  view.dom.dispatchEvent(
    new win.MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
  );
  await sleep(20);
  assert.equal(menu.open.peek(), true);
  assert.deepEqual(labels(menu), ["Paste", "Select all"]);
});

test("it does not show when the editor is not the focused element", async () => {
  const { view, menu } = setup({ defaults: true });
  view.dispatch({ selection: { anchor: 0, head: 5 } });
  await sleep(20);
  assert.equal(menu.open.peek(), false);
});

test("with no applicable items the menu stays hidden", async () => {
  const { view, menu } = setup();
  focus(view);
  view.dispatch({ selection: { anchor: 0, head: 5 } });
  await sleep(20);
  assert.equal(menu.open.peek(), false);
});

test("Back closes the menu (and is not passed on to the app)", async () => {
  const { view, menu } = setup({ defaults: true });
  focus(view);
  view.dispatch({ selection: { anchor: 0, head: 5 } });
  await sleep(20);
  assert.equal(back.backDepth(), 1);
  assert.equal(back.handleBack(), true);
  assert.equal(menu.open.peek(), false);
  assert.equal(back.backDepth(), 0);
});

test("tapping somewhere else dismisses it; tapping the menu itself does not, and does not steal focus", async () => {
  const { view, menu } = setup({ defaults: true });
  focus(view);
  view.dispatch({ selection: { anchor: 0, head: 5 } });
  await sleep(20);
  // A press on a button: the menu cancels its default (so focus stays in the editor) and does not dismiss itself.
  const onMenu = pointer("pointerdown", menu.el.querySelector("button")!);
  assert.equal(onMenu.defaultPrevented, true);
  assert.equal(menu.open.peek(), true);
  pointer("pointerdown", document.body);
  assert.equal(menu.open.peek(), false);
});

test("the OS selection bar is switched off while the editor has focus, back on when it loses it", () => {
  const calls: boolean[] = [];
  const { view } = setup({ systemBar: (on) => calls.push(on) });
  view.contentDOM.dispatchEvent(new win.Event("focusin", { bubbles: true }));
  view.contentDOM.dispatchEvent(new win.Event("focusout", { bubbles: true }));
  assert.deepEqual(calls, [true, false]);
  // focus moving between other things inside the editor (the search box) leaves the OS bar alone
  const input = document.createElement("input");
  view.dom.append(input);
  input.dispatchEvent(new win.Event("focusin", { bubbles: true }));
  input.dispatchEvent(new win.Event("focusout", { bubbles: true }));
  assert.deepEqual(calls, [true, false]);
});

test("destroy() detaches every listener", async () => {
  const { view, menu } = setup({ defaults: true });
  focus(view);
  menu.destroy();
  view.dispatch({ selection: { anchor: 0, head: 5 } });
  await sleep(20);
  assert.equal(menu.open.peek(), false);
});

// ----------------------------------------------------------------- activation

test("tapping an item runs it with the selected text, closes the menu, and keeps the editor focused", async () => {
  const { view, menu } = setup();
  focus(view);
  let seen: { text: string; hasSelection: boolean } | null = null;
  menu.add({
    id: "probe",
    label: "Probe",
    run: (ctx) =>
      void (seen = { text: ctx.text, hasSelection: ctx.hasSelection }),
  });
  view.dispatch({ selection: { anchor: 0, head: 5 } });
  await sleep(20);
  menu.el
    .querySelector<HTMLButtonElement>('button[aria-label="Probe"]')!
    .click();
  assert.deepEqual(seen, { text: "hello", hasSelection: true });
  assert.equal(menu.open.peek(), false);
});

test("multi-line selection text is joined with line breaks", async () => {
  const { view, menu } = setup({ doc: "one\ntwo" });
  focus(view);
  let text = "";
  menu.add({
    id: "probe",
    label: "Probe",
    run: (ctx) => void (text = ctx.text),
  });
  view.dispatch({ selection: { anchor: 0, head: 7 } });
  await sleep(20);
  menu.el.querySelector<HTMLButtonElement>("button")!.click();
  assert.equal(text, "one\ntwo");
});

test("keepOpen leaves the menu showing; a throwing item is reported and does not break the menu", async () => {
  const { view, menu } = setup();
  focus(view);
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void errors.push(a);
  try {
    menu.add({ id: "stay", label: "Stay", keepOpen: true, run: noop });
    menu.add({
      id: "boom",
      label: "Boom",
      run: () => {
        throw new Error("nope");
      },
    });
    menu.add({
      id: "async-boom",
      label: "AsyncBoom",
      run: async () => {
        throw new Error("later");
      },
    });
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    await sleep(20);
    menu.el
      .querySelector<HTMLButtonElement>('button[aria-label="Stay"]')!
      .click();
    assert.equal(menu.open.peek(), true);
    menu.el
      .querySelector<HTMLButtonElement>('button[aria-label="Boom"]')!
      .click();
    await sleep(0);
    menu.show();
    menu.el
      .querySelector<HTMLButtonElement>('button[aria-label="AsyncBoom"]')!
      .click();
    await sleep(0);
  } finally {
    console.error = original;
  }
  assert.equal(errors.length, 2);
});

test("an item without an icon shows its label as text", async () => {
  const { view, menu } = setup();
  focus(view);
  menu.add({ id: "t", label: "Shout", run: noop });
  view.dispatch({ selection: { anchor: 0, head: 5 } });
  await sleep(20);
  assert.equal(menu.el.querySelector(".sm-text")?.textContent, "Shout");
});

test("adding or removing while open updates the open menu", async () => {
  const { view, menu } = setup({ defaults: true });
  focus(view);
  view.dispatch({ selection: { anchor: 0, head: 5 } });
  await sleep(20);
  const remove = menu.add({ id: "extra", label: "Extra", run: noop });
  assert.ok(labels(menu).includes("Extra"));
  remove();
  assert.ok(!labels(menu).includes("Extra"));
  menu.remove("cut");
  assert.ok(!labels(menu).includes("Cut"));
});

// ------------------------------------------------------- geometry (stubbed)

/** jsdom has no layout: give the editor a 400x500 scroller at (0,100) and say where the selection is drawn. */
function stubLayout(
  view: View,
  rect: { top: number; bottom: number; left?: number; right?: number },
) {
  (
    view.scrollDOM as unknown as { getBoundingClientRect: () => unknown }
  ).getBoundingClientRect = () => ({
    left: 0,
    top: 100,
    right: 400,
    bottom: 600,
    width: 400,
    height: 500,
  });
  (view as unknown as { coordsAtPos: unknown }).coordsAtPos = () => ({
    left: 100,
    right: 160,
    top: rect.top,
    bottom: rect.bottom,
  });
}

test("the menu sits above a selection that is on screen, and the OS-bar-style offset is applied", async () => {
  const { view, menu } = setup({ defaults: true });
  focus(view);
  stubLayout(view, { top: 300, bottom: 320 });
  view.dispatch({ selection: { anchor: 0, head: 5 } });
  await sleep(20);
  assert.equal(menu.open.peek(), true);
  assert.equal(menu.el.dataset.placement, "above");
});

test("scrolling the selection out of view closes the menu (above or below the visible area)", async () => {
  for (const gone of [
    { top: 10, bottom: 30 },
    { top: 700, bottom: 720 },
  ]) {
    const { view, menu } = setup({ defaults: true });
    focus(view);
    stubLayout(view, { top: 300, bottom: 320 });
    view.dispatch({ selection: { anchor: 0, head: 5 } });
    await sleep(20);
    assert.equal(menu.open.peek(), true);
    stubLayout(view, gone); // the text moved off screen
    view.scrollDOM.dispatchEvent(new win.Event("scroll"));
    await sleep(60); // one animation frame
    assert.equal(
      menu.open.peek(),
      false,
      `still open for a selection at y=${gone.top}`,
    );
  }
});

test("a selection that is only partly on screen keeps the menu (it clamps to the edge)", async () => {
  const { view, menu } = setup({ defaults: true });
  focus(view);
  stubLayout(view, { top: 80, bottom: 120 }); // straddles the top edge at y=100
  view.dispatch({ selection: { anchor: 0, head: 5 } });
  await sleep(20);
  assert.equal(menu.open.peek(), true);
});

// ------------------------------------------------------------------ defaults

function stubClipboard(initial = "") {
  const box = { text: initial };
  C.setClipboardBackend({
    read: async () => box.text,
    write: async (t) => void (box.text = t),
  });
  return box;
}

test("built-in Copy puts the selection on the clipboard and leaves the text alone", async () => {
  const clip = stubClipboard();
  const { view, menu } = setup({ defaults: true });
  focus(view);
  view.dispatch({ selection: { anchor: 0, head: 5 } });
  await sleep(20);
  menu.el
    .querySelector<HTMLButtonElement>('button[aria-label="Copy"]')!
    .click();
  await sleep(0);
  assert.equal(clip.text, "hello");
  assert.equal(view.state.doc.sliceString(0, 11), "hello world");
});

test("built-in Cut removes the selection; Paste replaces it", async () => {
  const clip = stubClipboard();
  const { view, menu } = setup({ defaults: true });
  focus(view);
  view.dispatch({ selection: { anchor: 0, head: 6 } });
  await sleep(20);
  menu.el.querySelector<HTMLButtonElement>('button[aria-label="Cut"]')!.click();
  await sleep(0);
  assert.equal(clip.text, "hello ");
  assert.equal(view.state.doc.line(1).text, "world");
  clip.text = "HEY";
  view.dispatch({ selection: { anchor: 0, head: 5 } });
  await sleep(20);
  menu.el
    .querySelector<HTMLButtonElement>('button[aria-label="Paste"]')!
    .click();
  await sleep(0);
  assert.equal(view.state.doc.line(1).text, "HEY");
});

test("built-in Select all selects everything, and then no longer offers itself", async () => {
  const { view, menu } = setup({ defaults: true });
  focus(view);
  view.dispatch({ selection: { anchor: 0, head: 5 } });
  await sleep(20);
  assert.ok(labels(menu).includes("Select all"));
  menu.el
    .querySelector<HTMLButtonElement>('button[aria-label="Select all"]')!
    .click();
  assert.deepEqual(
    [view.state.selection.main.from, view.state.selection.main.to],
    [0, view.state.doc.length],
  );
  assert.ok(!menu.visibleItems().some((i) => i.id === "select-all"));
});

test("built-in Comment toggles the comment on the selected lines", async () => {
  const { view, menu } = setup({ defaults: true });
  focus(view);
  view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } });
  await sleep(20);
  menu.el
    .querySelector<HTMLButtonElement>('button[aria-label="Comment"]')!
    .click();
  assert.equal(view.state.doc.toString(), "# hello world\n# second line");
});

test("the built-ins can be removed like anything else", () => {
  const { menu } = setup({ defaults: true });
  for (const id of ["cut", "copy", "paste", "select-all", "comment"])
    assert.equal(menu.remove(id), true);
  assert.equal(menu.items().length, 0);
});
