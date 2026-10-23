#!/usr/bin/env tsx
/**
 * UI smoke test: loads the *real built app* (www/index.html -> boot.js ->
 * main.js + css) in jsdom, wired to the real Python runner through the dev
 * bridge, and drives it the way a user would. It proves the pieces work
 * together, not just individually: editor, workspace files, run/stop, console,
 * input(), tracebacks, turtle, drawer, packages page.
 *
 * Requires `npm run build` first, and a Python 3 with `packaging` installed
 * (set PYFORGE_PYTHON to pick one). Not covered here, because jsdom can't do
 * it: real canvas pixels, touch gestures, the Android bridge.
 */
import { JSDOM, VirtualConsole } from "jsdom";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createBridge } from "../dev-bridge/bridge";

const root = process.cwd();
const www = path.join(root, "www");
if (!existsSync(path.join(www, "index.html"))) {
  console.error("www/index.html not found. Run `npm run build` first.");
  process.exit(1);
}

const TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
};
const work = mkdtempSync(path.join(tmpdir(), "pyforge-smoke-"));
const bridge = createBridge({ workDir: work });
const server = createServer((req, res) => {
  void bridge(req, res).then((handled) => {
    if (handled) return;
    const file = path.join(
      www,
      new URL(req.url ?? "/", "http://x").pathname.replace(
        /^\/$/,
        "/index.html",
      ),
    );
    if (!file.startsWith(www) || !existsSync(file))
      return void res.writeHead(404).end();
    res
      .writeHead(200, {
        "content-type": TYPES[path.extname(file)] ?? "application/octet-stream",
      })
      .end(readFileSync(file));
  });
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const failures: string[] = [];
const problems: string[] = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on("error", (...a) =>
  problems.push(`console.error: ${a.join(" ")}`),
);
virtualConsole.on("jsdomError", (e) => {
  if (!String(e.message).includes("cordova.js"))
    problems.push(`jsdom: ${e.message}`);
});

// A canvas stand-in: jsdom has no 2D context. Anything the app draws is recorded and ignored.
const fakeCtx = new Proxy(
  {},
  { get: (_t, p) => (p === "canvas" ? {} : () => undefined), set: () => true },
);

const dom = new JSDOM(readFileSync(path.join(www, "index.html"), "utf8"), {
  url: `${base}/index.html`,
  runScripts: "dangerously",
  resources: "usable",
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    // The bridge client uses fetch + streams, which jsdom lacks: hand it Node's.
    Object.assign(window, {
      fetch: (input: string, init?: RequestInit) =>
        fetch(new URL(input, base), init),
      TextDecoder,
      AbortSignal,
    });
    // jsdom has no layout; CodeMirror measures text through Range geometry.
    const rangeProto = window.Range.prototype as unknown as Record<
      string,
      unknown
    >;
    rangeProto.getClientRects = () => [];
    rangeProto.getBoundingClientRect = () => ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
    });
    (
      window.HTMLCanvasElement.prototype as unknown as {
        getContext: () => unknown;
      }
    ).getContext = () => fakeCtx;
  },
});
const { window } = dom;
const doc = window.document;
window.addEventListener("error", (e) =>
  problems.push(`window error: ${e.error?.stack ?? e.message}`),
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function waitFor<T>(
  what: string,
  probe: () => T | null | undefined | false,
  ms = 20000,
): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`);
    await sleep(40);
  }
}
const $ = <T extends Element = HTMLElement>(sel: string) =>
  doc.querySelector<T>(sel);
const consoleText = () =>
  [...doc.querySelectorAll(".console-log .cl")]
    .map((l) => l.textContent)
    .join("\n");
const status = () => $(".status-chip")?.textContent ?? "";
const pf = () =>
  (
    window as unknown as {
      pyforge: { editorManager: any; runPanel: any; router: any };
    }
  ).pyforge;
/** What Android does when the Back button is pressed. */
const pressBack = () => doc.dispatchEvent(new window.Event("backbutton"));
const dialogText = () => $(".dialog")?.textContent ?? "";
const clickButton = (label: string) =>
  [...doc.querySelectorAll<HTMLButtonElement>(".dialog button")]
    .find((b) => b.textContent === label)!
    .click();

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`  ok   ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(
      `  FAIL ${name}\n       ${e instanceof Error ? e.message : e}\n       console was: ${JSON.stringify(consoleText().slice(-300))}`,
    );
  }
}

/** Replace the active buffer and run it; resolves when the status chip leaves "Running". */
async function runCode(
  code: string,
  wait: "finish" | "none" = "finish",
): Promise<void> {
  const view = pf().editorManager.editor;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: code },
  });
  $<HTMLButtonElement>("#run-btn")!.click();
  await waitFor("run to start", () =>
    /Running|Finished|Exit code|Stopped/.test(status()),
  );
  if (wait === "finish")
    await waitFor("run to end", () => !/Running/.test(status()));
}

console.log(`PyForge UI smoke test (${base})`);

await step(
  "app mounts with CodeMirror, main.py open and the Python runtime detected",
  async () => {
    await waitFor("editor", () => $(".cm-editor"));
    await waitFor(
      "main.py in titlebar",
      () => $("#filename")?.textContent === "main.py",
    );
    await waitFor("runtime label", () =>
      /Python 3\.\d+/.test($(".status-lang")?.textContent ?? ""),
    );
  },
);

await step(
  "Run executes the starter program and the console shows its output",
  async () => {
    $<HTMLButtonElement>("#run-btn")!.click();
    await waitFor("hello output", () =>
      consoleText().includes("Hello from PyForge!"),
    );
    await waitFor("finished chip", () => /Finished/.test(status()));
    if (!$(".run-panel.open")) throw new Error("output panel did not open");
  },
);

await step(
  "input(): the input row appears, the typed answer is echoed and used",
  async () => {
    await runCode('name = input("Name: ")\nprint("Hi", name)\n', "none");
    const form = await waitFor(
      "input row",
      () =>
        ($(".console-input-row") as HTMLElement | null)?.hidden === false &&
        $(".console-input-row"),
    );
    ($(".console-input") as HTMLInputElement).value = "Ada";
    form.dispatchEvent(new window.Event("submit", { cancelable: true }));
    await waitFor("greeting", () => consoleText().includes("Hi Ada"));
    await waitFor("finished", () => /Finished/.test(status()));
  },
);

await step(
  "a traceback is tappable and moves the editor cursor to the failing line",
  async () => {
    await runCode('x = 1\ny = 2\nraise ValueError("boom")\n');
    await waitFor("error chip", () => /Exit code 1/.test(status()));
    const link = await waitFor("traceback link", () => $(".cl.tb-link"));
    link.querySelector("span")!.click();
    await waitFor("cursor on line 3", () => {
      const st = pf().editorManager.editor.state;
      return st.doc.lineAt(st.selection.main.head).number === 3;
    });
  },
);

await step(
  "turtle: drawing commands switch the panel to the Display tab",
  async () => {
    await runCode(
      "import turtle\nt = turtle.Turtle()\nt.speed(0)\nt.forward(80)\nturtle.done()\n",
      "none",
    );
    await waitFor("display tab", () =>
      $(".seg-btn.on")?.textContent?.includes("Display"),
    );
    await waitFor(
      "stage visible",
      () => ($(".display-stage") as HTMLElement | null)?.hidden === false,
    );
    $<HTMLButtonElement>(".display-close")!.click(); // closing the window lets turtle.done() return
    await waitFor("run end", () => !/Running/.test(status()));
  },
);

await step("Stop kills an infinite loop", async () => {
  await runCode("while True:\n    pass\n", "none");
  await waitFor("running", () => /Running/.test(status()));
  $<HTMLButtonElement>("#run-btn")!.click();
  await waitFor("stopped", () => /Stopped/.test(status()));
});

await step(
  "the drawer lists workspace files; the overflow menu opens the Packages page",
  async () => {
    $<HTMLButtonElement>('button[aria-label="Open files drawer"]')!.click();
    await waitFor("drawer open", () => $("#drawer.open"));
    await waitFor("main.py in tree", () =>
      [...doc.querySelectorAll(".tree-label")].some(
        (l) => l.textContent === "main.py",
      ),
    );
    $<HTMLButtonElement>('button[aria-label="Close drawer"]')!.click();
    $<HTMLButtonElement>('button[aria-label="More actions"]')!.click();
    [...doc.querySelectorAll<HTMLButtonElement>(".menu-item")]
      .find((b) => b.textContent === "Packages")!
      .click();
    await waitFor("packages page open", () => $("#packages-page.open"));
    await waitFor(
      "popular list",
      () => doc.querySelectorAll(".pkg-card").length >= 8,
    );
  },
);

await step("page zoom is disabled", async () => {
  const viewport = $("meta[name=viewport]")!.getAttribute("content")!;
  if (!/user-scalable=no/.test(viewport) || !/maximum-scale=1/.test(viewport))
    throw new Error(`viewport allows zoom: ${viewport}`);
});

await step(
  "Back walks the navigation stack: Settings opened from Packages returns to Packages, then Home",
  async () => {
    // We are on the Packages page (previous step). Open Settings from its gear.
    $<HTMLButtonElement>(
      '#packages-page button[aria-label="Settings"]',
    )!.click();
    await waitFor(
      "settings on top",
      () =>
        pf().router.stack.peek().join() === "home,packages,settings" &&
        $("#settings-page.open"),
    );
    pressBack();
    await waitFor(
      "back to packages",
      () => pf().router.stack.peek().join() === "home,packages",
    );
    if (!$("#packages-page.open")) throw new Error("packages page closed");
    pressBack();
    await waitFor(
      "back to home",
      () => pf().router.stack.peek().join() === "home",
    );
    await waitFor("packages hidden", () => !$("#packages-page.open"));
  },
);

await step(
  "Back on Home asks to exit; Back again dismisses the dialog and stays",
  async () => {
    // Make sure nothing is unsaved: wait out auto-save and leave the output sheet closed.
    pf().runPanel.hide();
    await waitFor(
      "files saved",
      () =>
        !pf()
          .editorManager.activeFiles.peek()
          .some((f: any) => f.dirty.peek()),
      8000,
    );
    pressBack();
    await waitFor("exit dialog", () => /Exit PyForge\?/.test(dialogText()));
    pressBack(); // Back closes the dialog, it does not exit
    await waitFor("dialog gone", () => !$(".dialog"));
  },
);

await step(
  "unsaved changes: exit offers Save / Discard / Stay, and Stay keeps the file open",
  async () => {
    const view = pf().editorManager.editor;
    view.dispatch({ changes: { from: 0, insert: "# edited\n" } });
    await waitFor("dirty", () =>
      pf().editorManager.activeFile.peek().dirty.peek(),
    );
    pressBack();
    await waitFor(
      "unsaved dialog",
      () =>
        /Unsaved changes/.test(dialogText()) && /main\.py/.test(dialogText()),
    );
    const labels = [...doc.querySelectorAll(".dialog button")].map(
      (b) => b.textContent,
    );
    if (labels.join("|") !== "Save and exit|Discard and exit|Stay")
      throw new Error(`buttons: ${labels.join("|")}`);
    clickButton("Stay");
    await waitFor("dialog gone", () => !$(".dialog"));
    if (pf().editorManager.activeFiles.peek().length !== 1)
      throw new Error("file closed");
  },
);

await step("auto-save writes the edit shortly after typing stops", async () => {
  await waitFor(
    "saved",
    () => !pf().editorManager.activeFile.peek().dirty.peek(),
    6000,
  );
});

window.close();
server.close();
rmSync(work, { recursive: true, force: true });

if (problems.length) {
  console.log("\nUnexpected page errors:");
  for (const p of [...new Set(problems)].slice(0, 8))
    console.log(" -", p.slice(0, 300));
}
if (failures.length || problems.length) {
  console.log(
    `\nFAILED (${failures.length} step(s) failed, ${problems.length} page error(s))`,
  );
  process.exit(1);
}
console.log("\nAll smoke steps passed.");
process.exit(0);
