import test, { before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { installDom, sleep } from "./helpers/editorEnv";

const win = installDom();

type Modifiers = typeof import("../../src/editor/modifiers");
type Clip = typeof import("../../src/editor/clipboard");
let M: Modifiers;
let C: Clip;
let EditorManager: typeof import("../../src/editorManager").EditorManager;
let createQuickTools: typeof import("../../src/components/quickTools").createQuickTools;
let searchPanelOpen: typeof import("@codemirror/search").searchPanelOpen;
type View = import("@codemirror/view").EditorView;

before(async () => {
  M = await import("../../src/editor/modifiers");
  C = await import("../../src/editor/clipboard");
  ({ EditorManager } = await import("../../src/editorManager"));
  ({ createQuickTools } = await import("../../src/components/quickTools"));
  ({ searchPanelOpen } = await import("@codemirror/search"));
});

function editor(doc: string) {
  const host = document.createElement("div");
  document.body.replaceChildren(host);
  const em = new EditorManager(host);
  em.newFile("a.py", doc);
  M.keyModifiers.clear();
  return { em, view: em.editor };
}

const keydown = (view: View, key: string, init: KeyboardEventInit = {}) => {
  const e = new win.KeyboardEvent("keydown", {
    key,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  view.contentDOM.dispatchEvent(e);
  return e;
};
const beforeinput = (view: View, data: string, inputType = "insertText") => {
  const e = new win.InputEvent("beforeinput", {
    inputType,
    data,
    bubbles: true,
    cancelable: true,
  });
  view.contentDOM.dispatchEvent(e);
  return e;
};
const main = (view: View) => view.state.selection.main;
const isAllSelected = (view: View) =>
  main(view).from === 0 && main(view).to === view.state.doc.length;

function stubClipboard(initial = "") {
  const box = { text: initial, writes: [] as string[] };
  C.setClipboardBackend({
    read: async () => box.text,
    write: async (t) => {
      box.text = t;
      box.writes.push(t);
    },
  });
  return box;
}
afterEach(() => C.setClipboardBackend(null));

// ------------------------------------------------------------ KeyModifiers

test("KeyModifiers: a tap arms for one key, take() releases it", () => {
  const mods = new M.KeyModifiers();
  mods.tap("ctrl");
  assert.equal(mods.ctrl.peek(), "once");
  assert.deepEqual(mods.take(), { shift: false, ctrl: true, alt: false });
  assert.equal(mods.ctrl.peek(), "off");
  assert.equal(mods.any(), false);
});

test("KeyModifiers: a quick second tap locks it; take() keeps a locked modifier; the next tap unlocks", () => {
  let now = 1000;
  const mods = new M.KeyModifiers(() => now, 350);
  mods.tap("shift");
  now += 200;
  mods.tap("shift");
  assert.equal(mods.shift.peek(), "locked");
  mods.take();
  mods.take();
  assert.equal(mods.shift.peek(), "locked");
  now += 2000;
  mods.tap("shift");
  assert.equal(mods.shift.peek(), "off");
});

test("KeyModifiers: a slow second tap just turns it off again", () => {
  let now = 0;
  const mods = new M.KeyModifiers(() => now, 350);
  mods.tap("alt");
  now += 1000;
  mods.tap("alt");
  assert.equal(mods.alt.peek(), "off");
});

test("KeyModifiers: clear() releases everything, locked included", () => {
  let now = 0;
  const mods = new M.KeyModifiers(() => now, 350);
  mods.tap("ctrl");
  now += 10;
  mods.tap("ctrl");
  mods.tap("shift");
  mods.clear();
  assert.equal(mods.any(), false);
});

// --------------------------------------------- CTRL then a typed key (the bug)

test('CTRL then "a" from a key event selects all, and releases CTRL', () => {
  const { view } = editor("hello\nworld");
  view.dispatch({ selection: { anchor: 2 } });
  M.keyModifiers.tap("ctrl");
  const e = keydown(view, "a");
  assert.equal(e.defaultPrevented, true);
  assert.ok(isAllSelected(view));
  assert.equal(M.keyModifiers.any(), false);
});

test('CTRL then "a" from a soft keyboard (beforeinput) selects all and inserts nothing', () => {
  const { view } = editor("hello\nworld");
  view.dispatch({ selection: { anchor: 3 } });
  M.keyModifiers.tap("ctrl");
  const e = beforeinput(view, "a");
  assert.equal(e.defaultPrevented, true);
  assert.ok(isAllSelected(view));
  assert.equal(view.state.doc.toString(), "hello\nworld");
  assert.equal(M.keyModifiers.any(), false);
});

test('CTRL then "a" from a keyboard that already changed the DOM (IME): selects all and the stray letter is removed', async () => {
  const { view } = editor("hello\nworld");
  view.dispatch({ selection: { anchor: 11 } });
  await sleep(30);
  M.keyModifiers.tap("ctrl");
  const line = view.contentDOM.querySelectorAll(".cm-line")[1] as HTMLElement;
  const text = document.createTreeWalker(line, 4).nextNode() as Text;
  const range = document.createRange();
  range.setStart(text, text.data.length);
  range.collapse(true);
  const selection = win.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  text.data += "a"; // what the keyboard did to the page
  await sleep(80); // CodeMirror's DOM observer picks it up
  assert.equal(view.state.doc.toString(), "hello\nworld");
  assert.ok(isAllSelected(view));
  assert.equal(
    (view.contentDOM.querySelectorAll(".cm-line")[1] as HTMLElement)
      .textContent,
    "world",
  );
  assert.equal(M.keyModifiers.any(), false);
});

test("CTRL chords reach the editor keymap: undo, redo, comment", () => {
  const { view } = editor("x = 1");
  view.dispatch({
    changes: { from: 5, insert: "2" },
    selection: { anchor: 6 },
    userEvent: "input.type",
  });
  assert.equal(view.state.doc.toString(), "x = 12");
  M.keyModifiers.tap("ctrl");
  keydown(view, "z");
  assert.equal(view.state.doc.toString(), "x = 1");
  M.keyModifiers.tap("ctrl");
  M.keyModifiers.tap("shift");
  keydown(view, "Z"); // Ctrl+Shift+Z, capital as a real keyboard reports it
  assert.equal(view.state.doc.toString(), "x = 12");
  M.keyModifiers.tap("ctrl");
  keydown(view, "/");
  assert.equal(view.state.doc.toString(), "# x = 12");
});

test("ALT then an arrow moves the line", () => {
  const { view } = editor("one\ntwo");
  view.dispatch({ selection: { anchor: 0 } });
  M.keyModifiers.tap("alt");
  keydown(view, "ArrowDown");
  assert.equal(view.state.doc.toString(), "two\none");
});

test("Ctrl+S / Ctrl+Enter style app shortcuts still see the key (it bubbles to the document)", () => {
  const { view } = editor("x");
  const seen: Array<{ key: string; ctrl: boolean }> = [];
  const listener = (e: Event) =>
    seen.push({
      key: (e as KeyboardEvent).key,
      ctrl: (e as KeyboardEvent).ctrlKey,
    });
  document.addEventListener("keydown", listener);
  M.keyModifiers.tap("ctrl");
  beforeinput(view, "s");
  document.removeEventListener("keydown", listener);
  assert.deepEqual(seen, [{ key: "s", ctrl: true }]);
});

test("CTRL plus a letter nothing is bound to does nothing (it is not typed)", () => {
  const { view } = editor("abc");
  view.dispatch({ selection: { anchor: 1 } });
  M.keyModifiers.tap("ctrl");
  const e = beforeinput(view, "q");
  assert.equal(e.defaultPrevented, true);
  assert.equal(view.state.doc.toString(), "abc");
  assert.equal(main(view).head, 1);
});

test("SHFT then a letter types it capitalised, once", () => {
  const { view } = editor("");
  M.keyModifiers.tap("shift");
  beforeinput(view, "a");
  assert.equal(view.state.doc.toString(), "A");
  assert.equal(M.keyModifiers.any(), false);
  // Released: the next key is not intercepted any more, the keyboard types it itself.
  assert.equal(beforeinput(view, "b").defaultPrevented, false);
});

test("SHFT through the IME path (inputHandler) capitalises too", () => {
  const { view } = editor("");
  M.keyModifiers.tap("shift");
  const handled = view.state
    .facet(
      (view.constructor as typeof import("@codemirror/view").EditorView)
        .inputHandler,
    )
    .some((h) => h(view, 0, 0, "q", () => view.state.update({})));
  assert.equal(handled, true);
  assert.equal(view.state.doc.toString(), "Q");
});

test("a locked modifier stays for every key until released; losing focus releases it", () => {
  const { view } = editor("hello");
  M.keyModifiers.tap("ctrl");
  M.keyModifiers.tap("ctrl"); // two taps back to back: locked
  assert.equal(M.keyModifiers.ctrl.peek(), "locked");
  view.dispatch({ selection: { anchor: 1 } });
  keydown(view, "a");
  assert.ok(isAllSelected(view));
  assert.equal(M.keyModifiers.ctrl.peek(), "locked", "still locked after use");
  view.dispatch({ selection: { anchor: 1 } });
  keydown(view, "a");
  assert.ok(isAllSelected(view), "works again");
  view.contentDOM.dispatchEvent(new win.Event("blur"));
  assert.equal(M.keyModifiers.any(), false);
});

test("SHFT then a hardware ArrowRight extends the selection", () => {
  const { view } = editor("hello");
  view.dispatch({ selection: { anchor: 0 } });
  M.keyModifiers.tap("shift");
  assert.equal(keydown(view, "ArrowRight").defaultPrevented, true);
  assert.deepEqual([main(view).anchor, main(view).head], [0, 1]);
  assert.equal(M.keyModifiers.any(), false);
});

test("SHFT then Enter / Backspace / Delete still do their normal job, and SHFT is used up", () => {
  const cases: Array<[string, string]> = [
    ["Enter", "a\nbc"],
    ["Backspace", "bc"],
    ["Delete", "ac"],
  ];
  for (const [key, expected] of cases) {
    const { view } = editor("abc");
    view.dispatch({ selection: { anchor: 1 } });
    M.keyModifiers.tap("shift");
    keydown(view, key);
    assert.equal(M.keyModifiers.any(), false, `${key}: shift released`);
    assert.equal(
      view.state.doc.toString().replace(/\n\s*/, "\n"),
      expected,
      `${key}: the key worked`,
    );
  }
});

test("a replaced key does not also reach the document (no double Ctrl+S)", () => {
  const { view } = editor("x");
  const seen: string[] = [];
  const listener = (e: Event) =>
    seen.push(`${(e as KeyboardEvent).key}:${(e as KeyboardEvent).ctrlKey}`);
  document.addEventListener("keydown", listener);
  M.keyModifiers.tap("ctrl");
  keydown(view, "s");
  document.removeEventListener("keydown", listener);
  assert.deepEqual(
    seen,
    ["s:true"],
    'only the re-dispatched Ctrl+S, not the original plain "s"',
  );
});

test("with nothing armed, typing is left completely alone", () => {
  const { view } = editor("abc");
  assert.equal(keydown(view, "a").defaultPrevented, false);
  assert.equal(beforeinput(view, "a").defaultPrevented, false);
  assert.equal(view.state.selection.main.empty, true);
});

test("IME keydown (keyCode 229) is ignored so composition can finish; beforeinput handles it", () => {
  const { view } = editor("abc");
  M.keyModifiers.tap("ctrl");
  const e = keydown(view, "Unidentified", { keyCode: 229 });
  assert.equal(e.defaultPrevented, false);
  assert.equal(M.keyModifiers.ctrl.peek(), "once");
});

// ------------------------------------------------------------ clipboard chords

test("CTRL+C copies the selection, CTRL+X cuts it, CTRL+V pastes", async () => {
  const clip = stubClipboard();
  const { view } = editor("hello world");
  view.dispatch({ selection: { anchor: 0, head: 5 } });
  M.keyModifiers.tap("ctrl");
  keydown(view, "c");
  await sleep(0);
  assert.equal(clip.text, "hello");
  assert.equal(view.state.doc.toString(), "hello world");

  M.keyModifiers.tap("ctrl");
  keydown(view, "x");
  await sleep(0);
  assert.equal(view.state.doc.toString(), " world");

  clip.text = "bye";
  M.keyModifiers.tap("ctrl");
  keydown(view, "v");
  await sleep(0);
  assert.equal(view.state.doc.toString(), "bye world");
});

test("CTRL+F opens the in-file search", () => {
  const { view } = editor("foo bar foo");
  assert.equal(searchPanelOpen(view.state), false);
  M.keyModifiers.tap("ctrl");
  keydown(view, "f");
  assert.equal(searchPanelOpen(view.state), true);
});

test("copy with only a caret copies the whole line; cut removes it", async () => {
  const clip = stubClipboard();
  const { view } = editor("one\ntwo\nthree");
  view.dispatch({ selection: { anchor: 5 } }); // inside "two"
  assert.equal(await C.copySelection(view), "ok");
  assert.equal(clip.text, "two\n");
  assert.equal(await C.cutSelection(view), "ok");
  assert.equal(view.state.doc.toString(), "one\nthree");
});

test("cutting the last line takes the line break before it", async () => {
  stubClipboard();
  const { view } = editor("one\ntwo");
  view.dispatch({ selection: { anchor: 6 } });
  await C.cutSelection(view);
  assert.equal(view.state.doc.toString(), "one");
});

test("paste: an empty clipboard says so instead of changing anything; failures are reported, not thrown", async () => {
  const notes: Array<[string, string]> = [];
  C.setClipboardNotifier((m, k) => notes.push([m, k]));
  const { view } = editor("abc");
  stubClipboard("");
  assert.equal(await C.pasteIntoSelection(view), "empty");
  assert.deepEqual(notes.pop(), ["The clipboard is empty.", "info"]);
  C.setClipboardBackend({
    read: async () => {
      throw new Error("denied");
    },
    write: async () => {},
  });
  assert.equal(await C.pasteIntoSelection(view), "failed");
  assert.deepEqual(notes.pop(), ["denied", "error"]);
  assert.equal(view.state.doc.toString(), "abc");
});

// --------------------------------------------------- typing via the bar

test('typeKey("(") gives () with the caret inside, and ")" steps over the closer instead of doubling it', () => {
  const { view } = editor("");
  M.typeKey(view, "(");
  assert.equal(view.state.doc.toString(), "()");
  assert.equal(main(view).head, 1);
  M.typeKey(view, ")");
  assert.equal(view.state.doc.toString(), "()");
  assert.equal(main(view).head, 2);
});

test("typeKey with CTRL armed runs the shortcut instead of typing", () => {
  const { view } = editor("x = 1");
  M.keyModifiers.tap("ctrl");
  M.typeKey(view, "/");
  assert.equal(view.state.doc.toString(), "# x = 1");
});

// ------------------------------------------------------------- the bar itself

function bar(doc: string) {
  const { em, view } = editor(doc);
  let now = 10_000;
  const mods = new M.KeyModifiers(() => now, 350);
  const el = createQuickTools(em, mods);
  document.body.append(el);
  const button = (label: string) => {
    const b = [...el.querySelectorAll("button")].find((x) =>
      x.getAttribute("aria-label")?.startsWith(label),
    );
    assert.ok(b, `no button "${label}"`);
    return b as HTMLButtonElement;
  };
  return { view, mods, button, advance: (ms: number) => (now += ms) };
}

test("bar: SHFT then › extends the selection by one character and releases SHFT", async () => {
  const { view, mods, button } = bar("hello");
  view.dispatch({ selection: { anchor: 0 } });
  button("Shift").click();
  assert.equal(mods.shift.peek(), "once");
  button("Cursor right").click();
  assert.deepEqual([main(view).anchor, main(view).head], [0, 1]);
  assert.equal(mods.shift.peek(), "off");
  button("Cursor right").click(); // SHFT is gone, so this no longer extends
  // Plain "right" with a selection collapses it to its end, as in any editor.
  assert.deepEqual([main(view).anchor, main(view).head], [1, 1]);
});

test("bar: the toggle buttons show armed and locked states", async () => {
  const { button, advance } = bar("x");
  const ctrl = button("Ctrl");
  ctrl.click();
  await sleep(0);
  assert.ok(ctrl.classList.contains("active"));
  assert.equal(ctrl.getAttribute("aria-pressed"), "true");
  assert.ok(!ctrl.classList.contains("locked"));
  advance(100);
  ctrl.click();
  await sleep(0);
  assert.ok(ctrl.classList.contains("locked"));
  advance(1000);
  ctrl.click();
  await sleep(0);
  assert.ok(!ctrl.classList.contains("active"));
  assert.equal(ctrl.getAttribute("aria-pressed"), "false");
});

test("bar: ( then ) behaves like typing; CTRL then / comments the line", () => {
  const { view, button } = bar("");
  button("Insert (").click();
  button("Insert )").click();
  assert.equal(view.state.doc.toString(), "()");
  button("Ctrl").click();
  button("Insert /").click();
  assert.equal(view.state.doc.toString(), "# ()");
});

test("bar: symbols are typed as-is (no padding spaces around = - / %)", () => {
  const { view, button } = bar("");
  for (const s of ["=", "=", "-", "/", "%"]) button(`Insert ${s}`).click();
  assert.equal(view.state.doc.toString(), "==-/%");
});

test("bar: Tab indents; SHFT then Tab dedents", () => {
  const { view, button } = bar("x");
  button("Indent").click();
  const indented = view.state.doc.toString();
  assert.match(indented, /^\s+x$/, "x is now indented");
  button("Shift").click();
  button("Indent").click();
  assert.equal(view.state.doc.toString(), "x");
});

test("bar: Select all button selects everything; Paste button pastes", async () => {
  const clip = stubClipboard("PASTED");
  const { view, button } = bar("abc");
  button("Select all").click();
  assert.ok(isAllSelected(view));
  button("Paste").click();
  await sleep(0);
  assert.equal(view.state.doc.toString(), "PASTED");
  assert.equal(clip.text, "PASTED");
});

beforeEach(() => M?.keyModifiers.clear());
