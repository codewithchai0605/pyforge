import test, { before } from "node:test";
import assert from "node:assert/strict";
import { signal } from "xtags";
import { giveSize, installXtermDom, sleep } from "./helpers/xtermEnv";
import type { TerminalManager as ManagerType } from "../../src/terminal/sessions";
import type {
    TerminalBackend,
    TerminalExit,
    TerminalOpenOptions,
    TerminalSession,
} from "../../src/terminal/types";

let TerminalManager: typeof ManagerType;
before(async () => {
    installXtermDom();
    // jsdom cannot measure a font, so say what size a "screen" would have.
    const { FitAddon } = await import("@xterm/addon-fit");
    FitAddon.prototype.proposeDimensions = () => ({ cols: 50, rows: 12 });
    ({ TerminalManager } = await import("../../src/terminal/sessions"));
});

class FakeSession implements TerminalSession {
    readonly written: string[] = [];
    readonly resizes: Array<[number, number]> = [];
    closed = 0;
    exited = false;
    private d = new Set<(b: Uint8Array) => void>();
    private e = new Set<(x: TerminalExit) => void>();
    done: Promise<TerminalExit>;
    private res!: (x: TerminalExit) => void;
    constructor(readonly opts: TerminalOpenOptions) {
        this.done = new Promise((r) => (this.res = r));
    }
    onData(cb: (b: Uint8Array) => void) {
        this.d.add(cb);
        return () => void this.d.delete(cb);
    }
    onExit(cb: (x: TerminalExit) => void) {
        this.e.add(cb);
        return () => void this.e.delete(cb);
    }
    write(s: string) {
        this.written.push(s);
    }
    resize(c: number, r: number) {
        this.resizes.push([c, r]);
    }
    close() {
        this.closed++;
    }
    emit(bytes: Uint8Array | string) {
        const b = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
        this.d.forEach((cb) => cb(b));
    }
    exit(code: number) {
        this.exited = true;
        this.e.forEach((cb) => cb({ code }));
        this.res({ code });
    }
}

function setup(opts: { available?: boolean; throws?: boolean } = {}) {
    const sessions: FakeSession[] = [];
    const backend: TerminalBackend = {
        kind: "dev",
        shell: "fake",
        available: opts.available ?? true,
        open(o) {
            if (opts.throws) throw new Error("boom");
            const s = new FakeSession(o);
            sessions.push(s);
            return s;
        },
    };
    const manager = new TerminalManager({
        backend,
        settings: { terminalFontSize: signal(13), terminalWebgl: signal(false) },
        notify: () => { },
        openUrl: () => { },
        cwd: "/work",
    });
    /** Puts the tab on screen with a size, which is what makes it start its shell. */
    const show = async (tab: { view: { el: HTMLElement; fitNow(): boolean } }) => {
        document.body.append(tab.view.el);
        giveSize(tab.view.el.firstElementChild!, 400, 200);
        tab.view.fitNow();
        await sleep(5);
    };
    return { manager, sessions, show };
}

test("a shell is started once the terminal has a size, in the requested folder", async () => {
    const { manager, sessions, show } = setup();
    const tab = manager.ensureOne()!;
    assert.equal(tab.status.peek(), "starting");
    assert.equal(sessions.length, 0, "nothing is spawned for a terminal that is not on screen yet");
    await show(tab);
    assert.equal(sessions.length, 1);
    assert.deepEqual(sessions[0]!.opts, { cols: 50, rows: 12, cwd: "/work" });
    assert.equal(tab.status.peek(), "running");
    assert.equal(manager.ensureOne(), tab, "ensureOne does not open a second one");
});

test("output goes to the screen and keystrokes go to the shell", async () => {
    const { manager, sessions, show } = setup();
    const tab = manager.create();
    await show(tab);
    sessions[0]!.emit("hello\r\n$ ");
    await new Promise<void>((r) => tab.view.write("", r));
    assert.equal(tab.view.text(), "hello\n$");
    tab.view.send("ls\r");
    assert.deepEqual(sessions[0]!.written, ["ls\r"]);
});

test("a UTF-8 character split across two chunks of output is not corrupted", async () => {
    const { manager, sessions, show } = setup();
    const tab = manager.create();
    await show(tab);
    const bytes = new TextEncoder().encode("caf\u00e9 \u65e5");
    sessions[0]!.emit(bytes.slice(0, 4)); // "caf" + first byte of é
    sessions[0]!.emit(bytes.slice(4));
    await new Promise<void>((r) => tab.view.write("", r));
    assert.equal(tab.view.text(), "caf\u00e9 \u65e5");
});

test("resizes reach the shell, debounced into one", async () => {
    const { manager, sessions, show } = setup();
    const tab = manager.create();
    await show(tab);
    tab.view.term.resize(60, 20);
    tab.view.term.resize(61, 21);
    tab.view.term.resize(62, 22);
    assert.deepEqual(sessions[0]!.resizes, []);
    await sleep(150);
    assert.deepEqual(sessions[0]!.resizes, [[62, 22]]);
});

test("when the shell ends the terminal says so, and Enter starts a new one", async () => {
    const { manager, sessions, show } = setup();
    const tab = manager.create();
    await show(tab);
    sessions[0]!.exit(3);
    await new Promise<void>((r) => tab.view.write("", r));
    assert.equal(tab.status.peek(), "exited");
    assert.equal(tab.exitCode.peek(), 3);
    assert.match(tab.view.text(), /Shell ended \(exit 3\)/);

    tab.view.send("x"); // other keys do nothing
    assert.equal(sessions.length, 1);
    tab.view.send("\r");
    await sleep(10);
    assert.equal(sessions.length, 2);
    assert.equal(tab.status.peek(), "running");
    assert.equal(tab.exitCode.peek(), null);
    sessions[1]!.emit("fresh\r\n");
    await new Promise<void>((r) => tab.view.write("", r));
    assert.equal(tab.view.text(), "fresh", "the old transcript is gone");
});

test("input after the shell ended is not sent to the dead session", async () => {
    const { manager, sessions, show } = setup();
    const tab = manager.create();
    await show(tab);
    sessions[0]!.exit(0);
    tab.view.send("echo hi");
    assert.deepEqual(sessions[0]!.written, []);
});

test("closing a tab hangs up its shell; closing the last one opens a fresh tab", async () => {
    const { manager, sessions, show } = setup();
    const first = manager.create();
    await show(first);
    const second = manager.create();
    await show(second);
    assert.equal(manager.active.peek(), second);
    manager.close(second.id);
    assert.equal(sessions[1]!.closed, 1);
    assert.equal(manager.tabs.peek().length, 1);
    assert.equal(manager.active.peek(), first);

    manager.close(first.id);
    assert.equal(sessions[0]!.closed, 1);
    assert.equal(manager.tabs.peek().length, 1, "never left with no terminal");
    assert.notEqual(manager.tabs.peek()[0], first);
});

test("closing a tab before its shell started does not start one", async () => {
    const { manager, sessions, show } = setup();
    const a = manager.create();
    const b = manager.create();
    manager.close(a.id);
    await show(a); // too late
    await show(b);
    assert.equal(sessions.length, 1);
});

test("select switches the active tab", async () => {
    const { manager, show } = setup();
    const a = manager.create();
    const b = manager.create();
    await show(a);
    await show(b);
    manager.select(a.id);
    assert.equal(manager.active.peek(), a);
});

test("a backend that cannot open reports it in the terminal instead of throwing", async () => {
    const { manager, show } = setup({ throws: true });
    const tab = manager.create();
    await show(tab);
    await new Promise<void>((r) => tab.view.write("", r));
    assert.equal(tab.status.peek(), "exited");
    assert.match(tab.view.text(), /Could not start a shell: boom/);
});

test("with no backend available no shell is opened", () => {
    const { manager } = setup({ available: false });
    assert.equal(manager.ensureOne(), null);
    assert.equal(manager.tabs.peek().length, 0);
});

test("the window title the shell sets becomes the tab title", async () => {
    const { manager, sessions, show } = setup();
    const tab = manager.create();
    await show(tab);
    assert.equal(tab.title.peek(), `Shell ${tab.id}`);
    sessions[0]!.emit("\x1b]0;user@host: ~/proj\x07");
    await new Promise<void>((r) => tab.view.write("", r));
    assert.equal(tab.title.peek(), "user@host: ~/proj");
    sessions[0]!.emit("\x1b]0;\x07");
    await new Promise<void>((r) => tab.view.write("", r));
    assert.equal(tab.title.peek(), `Shell ${tab.id}`);
});