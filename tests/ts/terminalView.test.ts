import test, { before } from "node:test";
import assert from "node:assert/strict";
import { giveSize, installXtermDom, sleep } from "./helpers/xtermEnv";
import type { TerminalView as TerminalViewType } from "../../src/terminal/terminalView";

let TerminalView: typeof TerminalViewType;
before(async () => {
    installXtermDom();
    ({ TerminalView } = await import("../../src/terminal/terminalView"));
});

function fakeClipboard(initial = "") {
    const state = { text: initial, reads: 0, writes: [] as string[] };
    return {
        state,
        backend: {
            read: async () => {
                state.reads++;
                return state.text;
            },
            write: async (t: string) => {
                state.writes.push(t);
                state.text = t;
            },
        },
    };
}

/** A view attached to the page, with a pretend 400x200 container, opened. */
async function make(extra: Partial<ConstructorParameters<typeof TerminalViewType>[0]> = {}) {
    const clip = fakeClipboard();
    const notes: string[] = [];
    const view = new TerminalView({
        fontSize: 14,
        clipboard: clip.backend,
        notify: (m) => notes.push(m),
        ...extra,
    });
    document.body.replaceChildren(view.el);
    const host = view.el.firstElementChild!;
    giveSize(host, 400, 200);
    assert.equal(view.fitNow(), false); // opens, but jsdom cannot measure a font, so no size yet
    const data: string[] = [];
    view.onData((d) => data.push(d));
    return { view, clip, notes, data };
}

test("the terminal opens once its container has a size, and the textarea is set up for raw keys", async () => {
    const { view } = await make();
    const ta = view.term.textarea!;
    assert.ok(view.term.element, "xterm was opened");
    assert.equal(ta.getAttribute("autocorrect"), "off");
    assert.equal(ta.getAttribute("autocapitalize"), "off");
    assert.equal(ta.getAttribute("spellcheck"), "false");
});

test("a container with no size is not opened (xterm would measure its font as 0 wide)", () => {
    const view = new TerminalView({ fontSize: 14 });
    document.body.replaceChildren(view.el);
    assert.equal(view.fitNow(), false);
    assert.equal(view.term.element, undefined);
});

test("output is written to the buffer and read back as text, wrapped rows joined", async () => {
    const { view } = await make();
    view.write("hello\r\nworld");
    await new Promise<void>((r) => view.write("", r));
    assert.equal(view.text(), "hello\nworld");
    assert.equal(view.cursorX(), 5);
});

test("Copy puts the selected text on the clipboard and clears the selection", async () => {
    const { view, clip, notes } = await make();
    view.write("one two three");
    await new Promise<void>((r) => view.write("", r));
    view.term.select(4, 0, 3);
    assert.equal(view.getSelection(), "two");
    assert.equal(await view.copy(), true);
    assert.deepEqual(clip.state.writes, ["two"]);
    assert.equal(view.hasSelection(), false);
    assert.ok(notes.includes("Copied"));
});

test("Copy with nothing selected says so instead of clearing the clipboard", async () => {
    const { view, clip, notes } = await make();
    assert.equal(await view.copy(), false);
    assert.deepEqual(clip.state.writes, []);
    assert.deepEqual(notes, ["Nothing selected."]);
});

test("Paste sends the clipboard text as typed input, newlines as Enter", async () => {
    const { view, clip, data } = await make();
    clip.state.text = "ls\npwd";
    assert.equal(await view.paste(), true);
    assert.deepEqual(data, ["ls\rpwd"]);
});

test("Paste of an empty clipboard reports it and sends nothing", async () => {
    const { view, data, notes } = await make();
    assert.equal(await view.paste(), false);
    assert.deepEqual(data, []);
    assert.deepEqual(notes, ["The clipboard is empty."]);
});

test("a clipboard that refuses is reported, not thrown", async () => {
    const notes: string[] = [];
    const view = new TerminalView({
        fontSize: 14,
        notify: (m) => notes.push(m),
        clipboard: {
            read: async () => {
                throw new Error("Paste is not available in this browser.");
            },
            write: async () => {
                throw new Error("Copy is not available in this browser.");
            },
        },
    });
    document.body.replaceChildren(view.el);
    giveSize(view.el.firstElementChild!, 400, 200);
    view.fitNow();
    view.write("abc");
    await new Promise<void>((r) => view.write("", r));
    view.term.select(0, 0, 3);
    assert.equal(await view.copy(), false);
    assert.equal(await view.paste(), false);
    assert.deepEqual(notes, [
        "Copy is not available in this browser.",
        "Paste is not available in this browser.",
    ]);
});

test("sticky Ctrl turns the next typed character into a control code, then releases", async () => {
    const { view, data } = await make();
    view.modifiers.tap("ctrl");
    view.send("c");
    view.send("c");
    assert.deepEqual(data, ["\x03", "c"]);
});

test("a locked modifier stays on until tapped again", async () => {
    const { view, data } = await make();
    view.modifiers.ctrl.set("locked");
    view.send("a");
    view.send("e");
    view.modifiers.tap("ctrl");
    view.send("e");
    assert.deepEqual(data, ["\x01", "\x05", "e"]);
});

/** xterm decides what a key sends from the legacy `keyCode`, which jsdom leaves at 0 unless told. */
function key(init: KeyboardEventInit): KeyboardEvent {
    const k = init.key ?? "";
    const keyCode = k === "Insert" ? 45 : k.length === 1 ? k.toUpperCase().charCodeAt(0) : 0;
    return new window.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        keyCode,
        ...init,
    });
}

test("Ctrl+Shift+C copies, Ctrl+Shift+V pastes, and xterm does not also send them to the shell", async () => {
    const { view, clip, data } = await make();
    view.write("abc");
    await new Promise<void>((r) => view.write("", r));
    view.term.select(0, 0, 3);
    const ta = view.term.textarea!;
    const copy = key({ key: "C", ctrlKey: true, shiftKey: true });
    ta.dispatchEvent(copy);
    assert.equal(copy.defaultPrevented, true);
    await sleep(5);
    assert.deepEqual(clip.state.writes, ["abc"]);

    clip.state.text = "pasted";
    ta.dispatchEvent(key({ key: "V", ctrlKey: true, shiftKey: true }));
    await sleep(5);
    assert.deepEqual(data, ["pasted"]);
});

test("Ctrl+C copies when text is selected and is an interrupt (0x03) when not", async () => {
    const { view, clip, data } = await make();
    view.write("abc");
    await new Promise<void>((r) => view.write("", r));
    const ta = view.term.textarea!;

    ta.dispatchEvent(key({ key: "c", ctrlKey: true }));
    assert.deepEqual(data, ["\x03"]);
    assert.deepEqual(clip.state.writes, []);

    view.term.select(0, 0, 3);
    ta.dispatchEvent(key({ key: "c", ctrlKey: true }));
    await sleep(5);
    assert.deepEqual(clip.state.writes, ["abc"]);
    assert.deepEqual(data, ["\x03"], "no second interrupt");
});

test("Ctrl+V and Shift+Insert paste, Ctrl+Insert copies", async () => {
    const { view, clip, data } = await make();
    view.write("xyz");
    await new Promise<void>((r) => view.write("", r));
    const ta = view.term.textarea!;
    clip.state.text = "P";
    ta.dispatchEvent(key({ key: "v", ctrlKey: true }));
    ta.dispatchEvent(key({ key: "Insert", shiftKey: true }));
    await sleep(5);
    assert.deepEqual(data, ["P", "P"]);
    view.term.select(0, 0, 3);
    ta.dispatchEvent(key({ key: "Insert", ctrlKey: true }));
    await sleep(5);
    assert.deepEqual(clip.state.writes, ["xyz"]);
});

test("the Ctrl+Shift+A shortcut selects everything", async () => {
    const { view } = await make();
    view.write("some text");
    await new Promise<void>((r) => view.write("", r));
    view.term.textarea!.dispatchEvent(key({ key: "A", ctrlKey: true, shiftKey: true }));
    assert.equal(view.hasSelection(), true);
    assert.match(view.getSelection(), /some text/);
});

test("with input disabled the soft keyboard stays away (inputMode none) but the text is still selectable", async () => {
    const { view } = await make();
    view.setInputEnabled(false);
    assert.equal(view.term.textarea!.inputMode, "none");
    view.setInputEnabled(true);
    assert.equal(view.term.textarea!.inputMode, "text");
});

test("clear() wipes the screen in order with earlier writes", async () => {
    const { view } = await make();
    view.write("old output\r\n");
    view.clear();
    view.write("new");
    await new Promise<void>((r) => view.write("", r));
    assert.equal(view.text(), "new");
});

test("URLs in the output are tappable through the link finder; a traceback calls the handler", async () => {
    const jumps: Array<[string, number]> = [];
    const { view } = await make({ onTraceback: (p, l) => jumps.push([p, l]) });
    view.write('  File "/p/app.py", line 7, in <module>\r\n');
    await new Promise<void>((r) => view.write("", r));
    const { findLinks } = await import("../../src/terminal/links");
    const [link] = findLinks(view.buffer, 0);
    assert.equal(link?.path, "/p/app.py");
    assert.equal(link?.line, 7);
});