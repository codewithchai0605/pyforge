import test from "node:test";
import assert from "node:assert/strict";
import { createRouter } from "../../src/navigation";
import {
  backDepth,
  dispatchBack,
  handleBack,
  pushBack,
  setRootBackHandler,
} from "../../src/components/backStack";
import { clampFontSize, pinchFontSize } from "../../src/editor/pinchZoom";

function drain(): void {
  while (handleBack()) {
    /* clear leftovers from other tests */
  }
}

test("router: push, pop and the stack always start at home", () => {
  const r = createRouter();
  assert.deepEqual(r.stack.peek(), ["home"]);
  assert.equal(r.pop(), false);
  r.push("packages");
  r.push("settings");
  assert.deepEqual(r.stack.peek(), ["home", "packages", "settings"]);
  assert.equal(r.current.peek(), "settings");
  assert.equal(r.pop(), true);
  assert.equal(r.current.peek(), "packages");
  assert.equal(r.canGoBack.peek(), true);
  assert.equal(r.pop(), true);
  assert.equal(r.canGoBack.peek(), false);
  drain();
});

test("router: pushing an open page does not duplicate it, it unwinds to it", () => {
  const r = createRouter();
  r.push("packages");
  r.push("settings");
  r.push("packages");
  assert.deepEqual(r.stack.peek(), ["home", "packages"]);
  r.push("packages");
  assert.deepEqual(r.stack.peek(), ["home", "packages"]);
  r.home();
  assert.deepEqual(r.stack.peek(), ["home"]);
  drain();
});

test("Back closes the most recently opened layer, whether page or transient surface", () => {
  drain();
  const log: string[] = [];
  setRootBackHandler(() => log.push("root"));
  const r = createRouter();

  const releaseSheet = pushBack(() => log.push("sheet")); // opened first (on Home)
  r.push("packages"); // then a page over it
  const releaseDialog = pushBack(() => log.push("dialog")); // then a dialog over that
  assert.equal(backDepth(), 3);

  dispatchBack(); // dialog
  assert.equal(r.current.peek(), "packages");
  dispatchBack(); // the page closes BEFORE the sheet that is underneath it
  assert.equal(r.current.peek(), "home");
  dispatchBack(); // now the sheet
  dispatchBack(); // nothing left: the exit flow
  assert.deepEqual(log, ["dialog", "sheet", "root"]);
  releaseSheet();
  releaseDialog();
  drain();
});

test("a page closed with its own Back button leaves no stale entry on the Back order", () => {
  drain();
  const r = createRouter();
  r.push("settings");
  assert.equal(backDepth(), 1);
  r.pop(); // header Back button
  assert.equal(backDepth(), 0);
});

test("pinch: scales the starting size by the finger-distance ratio, clamped", () => {
  assert.equal(pinchFontSize(15, 100, 150), 23);
  assert.equal(pinchFontSize(15, 100, 50), 11); // clamped to the minimum
  assert.equal(pinchFontSize(20, 100, 400), 26); // clamped to the maximum
  assert.equal(pinchFontSize(15, 0, 120), 15); // degenerate start: unchanged
  assert.equal(clampFontSize(12.4), 12);
});
