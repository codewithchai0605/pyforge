import test from "node:test";
import assert from "node:assert/strict";
import { TurtleScene, type Surface } from "../../src/python/turtleScene";

/** A canvas context that records every call and property write. */
function recorder() {
  const log: string[] = [];
  const fmt = (v: unknown) =>
    typeof v === "number"
      ? String(Math.round(v * 1000) / 1000)
      : typeof v === "object"
        ? "[img]"
        : String(v);
  const ctx = new Proxy(
    {},
    {
      get: (_t, prop) =>
        prop === "log"
          ? log
          : (...args: unknown[]) =>
              void log.push(`${String(prop)}(${args.map(fmt).join(",")})`),
      set: (_t, prop, value) => (
        log.push(`${String(prop)}=${fmt(value)}`),
        true
      ),
    },
  ) as unknown as CanvasRenderingContext2D & { log: string[] };
  return { ctx, log };
}

function makeScene() {
  const surfaces: { surface: Surface; log: string[] }[] = [];
  const events: string[] = [];
  const scene = new TurtleScene(
    () => {
      const { ctx, log } = recorder();
      const surface: Surface = {
        ctx,
        image: {} as CanvasImageSource,
        clear: () => void log.push("CLEAR"),
      };
      surfaces.push({ surface, log });
      return surface;
    },
    {
      onKeys: (k) => events.push(`keys:${k.join(",")}`),
      onAsk: (id, kind, title) => events.push(`ask:${id}:${kind}:${title}`),
      onDone: () => events.push("done"),
    },
  );
  scene.push([["setup", 200, 200]]);
  scene.step(0);
  return { scene, surfaces, events };
}

test("an instant line is drawn in window pixels with the pen settings", () => {
  const { scene, surfaces } = makeScene();
  scene.push([["m", 0, 0, 0, 100, 0, 0, 1, "red", 3]]);
  scene.step(0);
  assert.equal(surfaces.length, 1);
  assert.deepEqual(
    surfaces[0]!.log.filter((l) =>
      /^(moveTo|lineTo|strokeStyle|lineWidth|stroke)/.test(l),
    ),
    [
      "moveTo(100,100)",
      "lineTo(200,100)",
      "strokeStyle=red",
      "lineWidth=3",
      "stroke()",
    ],
  );
  assert.deepEqual([scene.getCursor(0)!.x, scene.getCursor(0)!.y], [100, 0]);
});

test("pen-up moves move the cursor but allocate no drawing layer", () => {
  const { scene, surfaces } = makeScene();
  scene.push([["m", 0, 0, 0, 50, 50, 0, 0, "black", 1]]);
  scene.step(0);
  assert.equal(surfaces.length, 0);
  assert.equal(scene.getCursor(0)!.y, 50);
});

test("setworldcoordinates maps the world box onto the window", () => {
  const { scene } = makeScene();
  scene.push([["world", 0, 0, 10, 10]]);
  scene.step(0);
  assert.deepEqual(scene.toWindow(5, 5), [100, 100]);
  assert.deepEqual(scene.toWindow(0, 0), [0, 200]);
  assert.deepEqual(scene.toWindow(10, 10), [200, 0]);
});

test("animated moves interpolate over their duration and draw incrementally", () => {
  const { scene, surfaces } = makeScene();
  scene.push([["m", 0, 0, 0, 100, 0, 1000, 1, "blue", 2]]);
  assert.equal(scene.step(0), true);
  assert.equal(scene.busy, true);
  assert.equal(scene.getCursor(0)!.x, 0);
  scene.step(250);
  assert.equal(scene.getCursor(0)!.x, 25);
  scene.step(500);
  assert.equal(scene.getCursor(0)!.x, 50);
  // Each frame draws only the new piece: 0->25 then 25->50 (window x 100->125->150)
  const lines = surfaces[0]!.log.filter(
    (l) => l.startsWith("moveTo") || l.startsWith("lineTo"),
  );
  assert.deepEqual(lines, [
    "moveTo(100,100)",
    "lineTo(125,100)",
    "moveTo(125,100)",
    "lineTo(150,100)",
  ]);
  scene.step(1500);
  assert.equal(scene.getCursor(0)!.x, 100);
  assert.equal(scene.busy, false);
});

test("turns animate heading; circles (polylines) follow their path and end at the final heading", () => {
  const { scene } = makeScene();
  scene.push([["t", 0, 0, 90, 1000]]);
  scene.step(0);
  scene.step(500);
  assert.equal(scene.getCursor(0)!.heading, 45);
  scene.step(1000);
  assert.equal(scene.getCursor(0)!.heading, 90);

  scene.push([
    [
      "p",
      0,
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      1000,
      1,
      "black",
      1,
      180,
    ],
  ]);
  scene.step(2000); // starts
  scene.step(2500); // half of the 20-unit path = end of the first leg
  const mid = scene.getCursor(0)!;
  assert.deepEqual([mid.x, mid.y], [10, 0]);
  scene.step(3000);
  const end = scene.getCursor(0)!;
  assert.deepEqual([end.x, end.y, end.heading], [10, 10, 180]);
});

test("queued commands run back to back within one step when they take no time", () => {
  const { scene } = makeScene();
  scene.push([
    ["m", 0, 0, 0, 10, 0, 0, 1, "black", 1],
    ["m", 0, 10, 0, 10, 10, 0, 1, "black", 1],
    ["t", 0, 0, 90, 0],
  ]);
  scene.step(0);
  assert.equal(scene.pending, 0);
  assert.deepEqual(
    [scene.getCursor(0)!.x, scene.getCursor(0)!.y, scene.getCursor(0)!.heading],
    [10, 10, 90],
  );
});

test("begin/end fill: the polygon is filled, then the outline is re-stroked on top", () => {
  const { scene, surfaces } = makeScene();
  scene.push([
    ["bf", 0],
    ["m", 0, 0, 0, 100, 0, 0, 1, "black", 1],
    ["m", 0, 100, 0, 100, 100, 0, 1, "black", 1],
    [
      "ef",
      0,
      "green",
      [
        [0, 0],
        [100, 0],
        [100, 100],
      ],
    ],
  ]);
  scene.step(0);
  const ops = surfaces[0]!.log.filter((l) =>
    /^(fill\(|stroke\(|fillStyle)/.test(l),
  );
  const fillAt = ops.indexOf("fill()");
  assert.ok(
    fillAt > 0 &&
      ops.slice(fillAt + 1).filter((o) => o === "stroke()").length === 2,
    ops.join(" "),
  );
  assert.ok(ops.includes("fillStyle=green"));
});

test("clear() only clears the given turtle; clearscreen wipes everything", () => {
  const { scene, surfaces } = makeScene();
  scene.push([
    ["m", 0, 0, 0, 10, 0, 0, 1, "black", 1],
    ["m", 1, 0, 0, 10, 0, 0, 1, "black", 1],
    ["clear", 0],
  ]);
  scene.step(0);
  assert.equal(surfaces[0]!.log.includes("CLEAR"), true);
  assert.equal(surfaces[1]!.log.includes("CLEAR"), false);
  scene.push([["clearscreen"]]);
  scene.step(0);
  assert.equal(surfaces[1]!.log.includes("CLEAR"), true);
  assert.equal(scene.getCursor(0), undefined);
});

test("when far behind, animation is skipped so the UI catches up", () => {
  const { scene } = makeScene();
  scene.push(
    Array.from({ length: 2600 }, (_, i): [string, ...unknown[]] => [
      "m",
      0,
      i,
      0,
      i + 1,
      0,
      1000,
      1,
      "black",
      1,
    ]),
  );
  scene.step(0);
  assert.equal(scene.busy, false);
  assert.equal(scene.getCursor(0)!.x, 2600);
});

test("toWorld is the inverse of the fit-to-view transform, with letterboxing", () => {
  const { scene } = makeScene(); // 200x200 window
  // 400x300 view => scale 1.5, window is 300x300 centred horizontally (x offset 50)
  assert.deepEqual(scene.toWorld(200, 150, 400, 300), { x: 0, y: 0 });
  const p = scene.toWorld(50, 0, 400, 300); // top-left corner of the window
  assert.deepEqual([p.x, p.y], [-100, 100]);
});

test("render scales the window to fit and draws layers, then shapes oriented along the heading", () => {
  const { scene } = makeScene();
  scene.push([
    ["m", 0, 0, 0, 50, 0, 0, 1, "black", 1],
    ["shape", 0, "arrow"],
    ["pos", 0, 0, 0, 0],
  ]);
  scene.step(0);
  const { ctx, log } = recorder();
  scene.render(ctx, 400, 300);
  assert.ok(log.includes("scale(1.5,1.5)"));
  assert.ok(log.includes("translate(50,0)"));
  assert.ok(log.some((l) => l.startsWith("drawImage")));
  // Arrow at heading 0 points east: tip (0,10) -> (cx+10, cy) = (110, 100)
  const moves = log.filter(
    (l) => l.startsWith("moveTo") || l.startsWith("lineTo"),
  );
  assert.deepEqual(
    moves.slice(-3).map((m) => m.replace(/-?0(?=[,)])/g, "0")),
    ["moveTo(100,90)", "lineTo(100,110)", "lineTo(110,100)"],
  );
});

test("hooks fire for keys, dialogs, done; unknown opcodes are ignored", () => {
  const { scene, events } = makeScene();
  scene.push([
    ["keys", ["Up", "Down"]],
    ["ask", 7, "text", "Name", "Who?"],
    ["done"],
    ["from_the_future", 1, 2],
  ]);
  scene.step(0);
  assert.deepEqual(events, ["keys:Up,Down", "ask:7:text:Name", "done"]);
});

test("invisible cursors and the blank shape are not drawn", () => {
  const { scene } = makeScene();
  scene.push([
    ["vis", 0, 0],
    ["shape", 1, "blank"],
  ]);
  scene.step(0);
  const { ctx, log } = recorder();
  scene.render(ctx, 200, 200);
  assert.equal(log.filter((l) => l === "closePath()").length, 0); // the clip uses rect(); no cursor/shape was drawn
});
