/**
 * End-to-end: TypeScript client (devTerminalBackend) -> HTTP bridge ->
 * pty_host.py -> a real bash on a real pseudo-terminal -> bytes back.
 * Run with `npm run test:ts` (needs Python 3 and bash).
 */
import test, { after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { createBridge } from "../../utils/dev-bridge/bridge";
import { devTerminalBackend } from "../../src/native/terminal";
import type { TerminalBackend, TerminalSession } from "../../src/terminal/types";

let server: Server;
let backend: TerminalBackend;
let work: string;
const sessions: TerminalSession[] = [];

before(async () => {
  work = mkdtempSync(path.join(tmpdir(), "pyforge-term-"));
  const bridge = createBridge({ workDir: work });
  server = createServer(
    (req, res) => void bridge(req, res).then((handled) => handled || res.end("no")),
  );
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  backend = devTerminalBackend(
    `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
  );
});

after(() => {
  for (const s of sessions) s.close();
  server.closeAllConnections();
  server.close();
  rmSync(work, { recursive: true, force: true });
});

function open(opts: { cols?: number; rows?: number; shell?: string } = {}) {
  const session = backend.open({ cols: opts.cols ?? 80, rows: opts.rows ?? 24, shell: opts.shell ?? "/bin/bash" });
  sessions.push(session);
  const decoder = new TextDecoder();
  let output = "";
  session.onData((b) => (output += decoder.decode(b, { stream: true })));
  const waitFor = async (re: RegExp, ms = 8000): Promise<string> => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (re.test(output)) return output;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error(`timed out waiting for ${re}; output so far: ${JSON.stringify(output.slice(-300))}`);
  };
  return { session, waitFor, output: () => output };
}

test("a shell starts, runs a command and echoes what is typed", async () => {
  const t = open();
  t.session.write("echo pyforge-$((6*7))\n");
  const out = await t.waitFor(/pyforge-42/);
  assert.match(out, /echo pyforge-\$\(\(6\*7\)\)/, "the PTY echoes the typed command");
});

test("it is a real terminal: stdout is a tty and TERM is set", async () => {
  const t = open();
  t.session.write("[ -t 1 ] && echo ISATTY-yes; echo term=$TERM\n");
  const out = await t.waitFor(/term=xterm-256color/);
  assert.match(out, /ISATTY-yes/);
});

test("the shell starts in the workspace folder", async () => {
  const t = open();
  t.session.write("basename \"$(pwd)\"\n");
  await t.waitFor(/\rprojects\r?\n/);
});

test("resize reaches the program (stty size)", async () => {
  const t = open({ cols: 100, rows: 30 });
  t.session.write("stty size\n");
  await t.waitFor(/30 100/);
  t.session.resize(61, 17);
  await new Promise((r) => setTimeout(r, 150));
  t.session.write("stty size\n");
  await t.waitFor(/17 61/);
});

test("UTF-8 round-trips (accents, CJK, emoji)", async () => {
  const t = open();
  t.session.write("echo caf\u00e9-\u65e5\u672c-\ud83d\ude00\n");
  const out = await t.waitFor(/caf\u00e9-\u65e5\u672c-\ud83d\ude00\r?\n/);
  assert.ok(out.includes("\u65e5\u672c"));
});

test("Ctrl+C interrupts a running command and the shell stays usable", async () => {
  const t = open();
  t.session.write("sleep 30\n");
  await new Promise((r) => setTimeout(r, 300));
  t.session.write("\x03"); // the PTY turns this into SIGINT for the foreground job
  t.session.write("echo alive-after-interrupt\n");
  await t.waitFor(/alive-after-interrupt\r?\n/);
});

test("exit reports the shell's status", async () => {
  const t = open();
  t.session.write("exit 7\n");
  const exit = await Promise.race([
    t.session.done,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no exit")), 8000)),
  ]);
  assert.equal(exit.code, 7);
  assert.equal(t.session.exited, true);
});

test("close() hangs up the shell", async () => {
  const t = open();
  t.session.write("echo up\n");
  await t.waitFor(/up\r?\n/);
  t.session.close();
  const exit = await Promise.race([
    t.session.done,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("still running")), 8000)),
  ]);
  assert.equal(typeof exit.code, "number");
  assert.equal(t.session.exited, true);
});

test("two terminals are independent", async () => {
  const a = open();
  const b = open();
  a.session.write("export WHO=alice; echo who=$WHO\n");
  b.session.write("echo who=${WHO:-nobody}\n");
  await a.waitFor(/who=alice/);
  await b.waitFor(/who=nobody/);
});

test("a program that fails to start reports an exit instead of hanging", async () => {
  const t = open({ shell: "/definitely/not/a/shell" });
  const exit = await Promise.race([
    t.session.done,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error("hung")), 8000)),
  ]);
  assert.notEqual(exit.code, 0);
});