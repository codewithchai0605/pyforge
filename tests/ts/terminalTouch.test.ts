import test, { before } from "node:test";
import assert from "node:assert/strict";
import { giveSize, installXtermDom, sleep } from "./helpers/xtermEnv";
import type { TerminalView as TerminalViewType } from "../../src/terminal/terminalView";

let TerminalView: typeof TerminalViewType;
before(async () => {
  installXtermDom();
  ({ TerminalView } = await import("../../src/terminal/terminalView"));
});

const CELL_W = 8;
const CELL_H = 16;

async function make(text: string, extra: Record<string, unknown> = {}) {
  const writes: string[] = [];
  const taps: number[] = [];
  const urls: string[] = [];
  const view = new TerminalView({
    fontSize: 14,
    clipboard: {
      read: async () => "from clipboard",
      write: async (t) => void writes.push(t),
    },
    onTap: () => taps.push(1),
    openUrl: (u) => urls.push(u),
    ...extra,
  });
  document.body.replaceChildren(view.el);
  giveSize(view.el, 640, 384);
  giveSize(view.el.firstElementChild!, 640, 384);
  view.fitNow();
  // The 80x24 grid occupies exactly this many pixels: 8x16 per cell.
  const screen = view.term.element!.querySelector<HTMLElement>(".xterm-screen")!;
  giveSize(screen, 80 * CELL_W, 24 * CELL_H);
  view.write(text);
  await new Promise<void>((r) => view.write("", r));
  const target = view.term.element!;
  const touch = (type: string, x?: number, y?: number) => {
    const ev = new window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "touches", {
      value: x === undefined ? [] : [{ clientX: x, clientY: y }],
    });
    target.dispatchEvent(ev);
    return ev;
  };
  const at = (col: number, row = 0) => [col * CELL_W + 2, row * CELL_H + 4] as const;
  const bar = () => view.el.querySelector<HTMLElement>(".pf-sel-bar")!;
  const handle = (w: "start" | "end") =>
    view.el.querySelector<HTMLElement>(`.pf-handle-${w}`)!;
  const barLabels = () =>
    [...bar().querySelectorAll("button")].map((b) => b.getAttribute("aria-label"));
  return { view, writes, taps, urls, touch, at, bar, handle, barLabels };
}

test("long-press selects the word under the finger and shows the handles and the bar", async () => {
  const t = await make("print hello world");
  t.touch("touchstart", ...t.at(14)); // on "world" (columns 12..16)
  await sleep(480);
  assert.equal(t.view.getSelection(), "world");
  assert.equal(t.bar().hidden, false);
  assert.deepEqual(t.barLabels(), ["Copy", "Paste", "Select all"]);
  t.touch("touchend");
  assert.equal(t.handle("start").hidden, false);
  assert.equal(t.handle("end").hidden, false);
  // Handles sit at the bottom corners of the first and last selected cells.
  assert.equal(t.handle("start").style.left, `${12 * CELL_W}px`);
  assert.equal(t.handle("end").style.left, `${17 * CELL_W}px`); // right edge of the last cell
});

test("keeping the finger down and dragging extends the selection", async () => {
  const t = await make("print hello world and more");
  t.touch("touchstart", ...t.at(8)); // on "hello"
  await sleep(480);
  assert.equal(t.view.getSelection(), "hello");
  t.touch("touchmove", ...t.at(20)); // into "and"
  assert.equal(t.view.getSelection(), "hello world and");
  t.touch("touchmove", ...t.at(2)); // back left, into "print": the selection grows the other way
  assert.equal(t.view.getSelection(), "int hello");
  t.touch("touchend");
  assert.equal(t.view.getSelection(), "int hello");
});

test("the bar's Copy button copies the selection and hides everything", async () => {
  const t = await make("one two three");
  t.touch("touchstart", ...t.at(5));
  await sleep(480);
  t.touch("touchend");
  t.bar().querySelector<HTMLElement>('[aria-label="Copy"]')!.click();
  await sleep(5);
  assert.deepEqual(t.writes, ["two"]);
  assert.equal(t.view.hasSelection(), false);
  assert.equal(t.bar().hidden, true);
  assert.equal(t.handle("start").hidden, true);
});

test("a quick drag is a scroll, not a selection", async () => {
  const t = await make("hello world");
  t.touch("touchstart", ...t.at(2));
  t.touch("touchmove", ...t.at(2, 6)); // 96px down: well past the slop
  await sleep(480);
  t.touch("touchend");
  assert.equal(t.view.hasSelection(), false);
  assert.deepEqual(t.taps, []);
});

test("a tap with nothing selected is reported to the owner and focuses the terminal", async () => {
  const t = await make("hello world");
  const ev0 = t.touch("touchstart", ...t.at(2));
  const ev1 = t.touch("touchend");
  assert.equal(ev0.defaultPrevented, false, "starting a touch must not block scrolling");
  assert.equal(ev1.defaultPrevented, true, "the tap must not be replayed as a mouse click");
  assert.deepEqual(t.taps, [1]);
  assert.equal(document.activeElement, t.view.term.textarea);
});

test("a tap while something is selected clears the selection instead", async () => {
  const t = await make("hello world");
  t.touch("touchstart", ...t.at(2));
  await sleep(480);
  t.touch("touchend");
  assert.equal(t.view.hasSelection(), true);
  t.touch("touchstart", ...t.at(30, 5));
  t.touch("touchend");
  assert.equal(t.view.hasSelection(), false);
  assert.equal(t.bar().hidden, true);
  assert.deepEqual(t.taps, []);
});

test("long-press on empty space offers Paste and Select all only", async () => {
  const t = await make("hello");
  t.touch("touchstart", ...t.at(40, 5));
  await sleep(480);
  t.touch("touchend");
  assert.equal(t.view.hasSelection(), false);
  assert.equal(t.bar().hidden, false);
  assert.deepEqual(t.barLabels(), ["Paste", "Select all"]);
  t.bar().querySelector<HTMLElement>('[aria-label="Select all"]')!.click();
  assert.equal(t.view.hasSelection(), true);
});

test("tapping a URL opens it instead of focusing", async () => {
  const t = await make("see https://example.com/x ok");
  t.touch("touchstart", ...t.at(10));
  t.touch("touchend");
  assert.deepEqual(t.urls, ["https://example.com/x"]);
  assert.deepEqual(t.taps, []);
});

test("tapping a traceback line calls the jump handler", async () => {
  const jumps: Array<[string, number]> = [];
  const t = await make('  File "/p/app.py", line 7, in <module>', {
    onTraceback: (p: string, l: number) => jumps.push([p, l]),
  });
  t.touch("touchstart", ...t.at(20));
  t.touch("touchend");
  assert.deepEqual(jumps, [["/p/app.py", 7]]);
});

test("dragging the end handle moves the end of the selection; dragging past the start swaps them", async () => {
  const t = await make("alpha beta gamma delta");
  t.touch("touchstart", ...t.at(7)); // "beta" = columns 6..9
  await sleep(480);
  t.touch("touchend");
  assert.equal(t.view.getSelection(), "beta");
  const end = t.handle("end");
  const down = new window.Event("pointerdown", { bubbles: true, cancelable: true });
  Object.assign(down, { pointerId: 1 });
  end.dispatchEvent(down);
  const move = (col: number) => {
    const ev = new window.Event("pointermove", { bubbles: true });
    Object.assign(ev, { pointerId: 1, clientX: col * CELL_W + 2, clientY: 4 + 22 });
    end.dispatchEvent(ev);
  };
  move(15); // "gamma" ends at column 15
  assert.equal(t.view.getSelection(), "beta gamma");
  move(2); // past the start: the handles swap roles; the old start cell (column 6) stays selected
  assert.equal(t.view.getSelection(), "pha b");
  end.dispatchEvent(new window.Event("pointerup", { bubbles: true }));
});

test("typing dismisses the selection", async () => {
  const t = await make("hello world");
  t.touch("touchstart", ...t.at(2));
  await sleep(480);
  t.touch("touchend");
  assert.equal(t.view.hasSelection(), true);
  t.view.send("x");
  assert.equal(t.view.hasSelection(), false);
  assert.equal(t.handle("start").hidden, true);
});