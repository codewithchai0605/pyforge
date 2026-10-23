/**
 * End-to-end: TypeScript client (devRuntime) -> HTTP bridge -> real Python
 * runner (pyforge.host) -> events back. Run with:
 *   PYFORGE_PYTHON=/path/to/python npm run test:e2e
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createBridge } from "../../utils/dev-bridge/bridge";
import { devRuntime } from "../../src/native/pyruntime";
import type { PyEvent, PyRuntime } from "../../src/python/protocol";

let server: Server;
let runtime: PyRuntime;
let work: string;

before(async () => {
  work = mkdtempSync(path.join(tmpdir(), "pyforge-e2e-"));
  const bridge = createBridge({ workDir: work });
  server = createServer(
    (req, res) =>
      void bridge(req, res).then((handled) => handled || res.end("no")),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  runtime = devRuntime(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  );
});

after(() => {
  server.close();
  rmSync(work, { recursive: true, force: true });
});

function collect(req: Parameters<PyRuntime["run"]>[0]) {
  const events: PyEvent[] = [];
  const handle = runtime.run(req, (e) => events.push(e));
  const text = (kind: "out" | "err") =>
    events
      .filter((e): e is Extract<PyEvent, { t: typeof kind }> => e.t === kind)
      .map((e) => e.s)
      .join("");
  const waitFor = async (pred: (e: PyEvent) => boolean, ms = 15000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const hit = events.find(pred);
      if (hit) return hit;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(
      `timeout waiting for event; got ${JSON.stringify(events.slice(-5))}`,
    );
  };
  return { events, handle, text, waitFor };
}

test("ping reports the desktop Python", async () => {
  const info = await runtime.init();
  assert.match(info.python, /^3\.\d+\.\d+$/);
  assert.equal(info.android, false);
});

test("runs a script from in-memory project files and streams output", async () => {
  const r = collect({
    path: "main.py",
    files: {
      "main.py": 'import helper\nprint(helper.greet("PyForge"))\n',
      "helper.py": 'def greet(n):\n    return f"Hello, {n}!"\n',
    },
  });
  const exit = await r.handle.done;
  assert.equal(exit.code, 0);
  assert.equal(r.text("out"), "Hello, PyForge!\n");
  assert.equal(r.events[0]?.t, "started");
});

test("reports a traceback with the script path and exit code 1", async () => {
  const r = collect({
    path: "bad.py",
    files: { "bad.py": 'x = 1\nraise ValueError("boom")\n' },
  });
  const exit = await r.handle.done;
  assert.equal(exit.code, 1);
  assert.match(r.text("err"), /bad\.py", line 2, in <module>/);
  assert.match(r.text("err"), /ValueError: boom/);
});

test("interactive input() works through the stdin round-trip", async () => {
  const r = collect({
    path: "in.py",
    files: { "in.py": 'name = input("Name: ")\nprint("Hi", name)\n' },
  });
  const ask = await r.waitFor((e) => e.t === "input");
  assert.equal((ask as Extract<PyEvent, { t: "input" }>).prompt, "Name: ");
  r.handle.stdin("Ada\n");
  const exit = await r.handle.done;
  assert.equal(exit.code, 0);
  assert.equal(r.text("out"), "Name: Hi Ada\n");
});

test("stop() hard-kills an infinite loop and still delivers an exit event", async () => {
  const r = collect({
    path: "loop.py",
    files: { "loop.py": "while True:\n    pass\n" },
  });
  await r.waitFor((e) => e.t === "started");
  await r.handle.stop();
  const exit = await r.handle.done;
  assert.equal(exit.t, "exit");
  assert.notEqual(exit.code, 0);
});

test("turtle commands arrive as gui events and key events reach Python", async () => {
  const code = [
    "import turtle",
    "t = turtle.Turtle(); t.speed(0)",
    "s = turtle.Screen()",
    'def go(): print("key!"); t.forward(10)',
    's.onkey(go, "Up"); s.listen()',
    "t.forward(50)",
    "turtle.done()",
  ].join("\n");
  const r = collect({
    path: "turtle_demo.py",
    files: { "turtle_demo.py": code },
  });
  await r.waitFor((e) => e.t === "gui" && e.cmds.some((c) => c[0] === "done"));
  // Drawing commands and the "done" marker may arrive in different batches.
  const cmds = r.events.flatMap((e) => (e.t === "gui" ? e.cmds : []));
  assert.ok(
    cmds.some((c) => c[0] === "m" && c[4] === 50),
    "forward(50) segment present",
  );
  r.handle.gui({ k: "key", key: "Up", down: false });
  await r.waitFor((e) => e.t === "out" && e.s.includes("key!"));
  r.handle.gui({ k: "close" });
  const exit = await r.handle.done;
  assert.equal(exit.code, 0);
});

test("matplotlib plt.show() yields an img event whose URL serves a PNG", async () => {
  const r = collect({
    path: "plot.py",
    files: {
      "plot.py":
        "import matplotlib.pyplot as plt\nplt.plot([1,2,3])\nplt.show()\n",
    },
  });
  const exit = await r.handle.done;
  if (exit.code !== 0 && /No module named 'matplotlib'/.test(r.text("err")))
    return; // optional dependency
  assert.equal(exit.code, 0, r.text("err"));
  const img = r.events.find(
    (e): e is Extract<PyEvent, { t: "img" }> => e.t === "img",
  );
  assert.ok(img, "img event emitted");
  const res = await fetch(await runtime.imageUrl(img.path));
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.deepEqual([...bytes.slice(1, 4)], [0x50, 0x4e, 0x47]);
});

test("bridge refuses paths that escape the workspace", async () => {
  const r = collect({ path: "../../etc/passwd", files: {} });
  const exit = await r.handle.done;
  assert.notEqual(exit.code, 0);
});

test("package manager list/lookup round trip through the bridge", async () => {
  const list = await runtime.pip.list();
  assert.ok(Array.isArray(list));
  const found = await runtime.pip.lookup(
    "this-package-name-does-not-exist-qq-77",
  );
  assert.equal(found.status, "not_found");
});
