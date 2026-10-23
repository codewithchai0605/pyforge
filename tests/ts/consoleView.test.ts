import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { ConsoleView } from "../../src/components/consoleView";

// ConsoleView only touches `document` inside its methods, so installing the
// jsdom globals after the (static) import is early enough.
const dom = new JSDOM("<!doctype html><body></body>", {
  pretendToBeVisual: true,
});
Object.assign(globalThis, {
  window: dom.window,
  document: dom.window.document,
  requestAnimationFrame: (f: () => void) => setTimeout(f, 0),
});

function make() {
  const inputs: (string | null)[] = [];
  const jumps: [string, number][] = [];
  const view = new ConsoleView({
    onInput: (t) => inputs.push(t),
    onJump: (p, l) => jumps.push([p, l]),
  });
  document.body.replaceChildren(view.el);
  return { view, inputs, jumps };
}

test("writes lines and keeps stdout/stderr styling separate", () => {
  const { view } = make();
  view.write("out", "hello\n");
  view.write("err", "oops\n");
  assert.equal(view.text(), "hello\noops");
  assert.equal(view.el.querySelectorAll(".err").length, 1);
});

test("carriage return overwrites the line (progress bars)", () => {
  const { view } = make();
  view.write("out", "10%\r50%\r100%\ndone\n");
  assert.equal(view.text(), "100%\ndone");
});

test("ANSI colours become inline styles; sequences split across chunks still work", () => {
  const { view } = make();
  view.write("out", "a \u001b[3");
  view.write("out", "1mred\u001b[0m b\n");
  const red = view.el.querySelector<HTMLElement>("span[style]");
  assert.equal(red?.textContent, "red");
  assert.match(red!.style.color, /ansi-1/);
  assert.equal(view.text(), "a red b");
});

test("input row: submit echoes the text, hides itself and reports it with a newline", () => {
  const { view, inputs } = make();
  view.write("out", "Name? ");
  view.showInput("Name?");
  assert.equal(view.waitingForInput, true);
  const input = view.el.querySelector<HTMLInputElement>(".console-input")!;
  input.value = "Ada";
  view.el
    .querySelector("form")!
    .dispatchEvent(new dom.window.Event("submit", { cancelable: true }));
  assert.deepEqual(inputs, ["Ada\n"]);
  assert.equal(view.waitingForInput, false);
  assert.equal(view.text(), "Name? Ada");
});

test("EOF button sends null", () => {
  const { view, inputs } = make();
  view.showInput();
  view.el
    .querySelector<HTMLButtonElement>('button[title^="Send end"]')!
    .click();
  assert.deepEqual(inputs, [null]);
});

test("traceback lines are tappable and report path + line", () => {
  const { view, jumps } = make();
  view.write(
    "err",
    'Traceback (most recent call last):\n  File "/data/projects/app.py", line 12, in <module>\n    boom()\n',
  );
  const link = view.el.querySelector<HTMLElement>(".tb-link")!;
  assert.ok(link);
  link.querySelector("span")!.click();
  assert.deepEqual(jumps, [["/data/projects/app.py", 12]]);
});

test("system lines start on their own line even after unterminated output", () => {
  const { view } = make();
  view.write("out", "no newline");
  view.system("Process exited with code 0", "ok");
  view.write("out", "next\n");
  assert.equal(view.text(), "no newline\nProcess exited with code 0\nnext");
});

test("log is capped so endless output cannot exhaust memory", () => {
  const { view } = make();
  view.write(
    "out",
    Array.from({ length: 5000 }, (_, i) => `l${i}`).join("\n") + "\n",
  );
  const lines = view.el.querySelectorAll(".cl").length;
  assert.ok(lines <= 4001, String(lines));
  assert.match(view.text(), /l4999/);
  assert.doesNotMatch(view.text(), /^l0\b/);
});

test("clear() resets everything including parser state", () => {
  const { view } = make();
  view.write("out", "\u001b[31mred");
  view.clear();
  view.write("out", "plain\n");
  assert.equal(view.el.querySelector<HTMLElement>("span")!.style.color, "");
  assert.equal(view.text(), "plain");
});
