import test, { before } from "node:test";
import assert from "node:assert/strict";
import { installDom } from "./helpers/editorEnv";
import { Screen } from "./helpers/headless";
import { bufferText } from "../../src/terminal/text";
import type {
    ConsoleSurface,
    TerminalConsole as TerminalConsoleType,
} from "../../src/terminal/terminalConsole";

let TerminalConsole: typeof TerminalConsoleType;
let endsAtLineStart: typeof import("../../src/terminal/terminalConsole").endsAtLineStart;
before(async () => {
    installDom();
    ({ TerminalConsole, endsAtLineStart } = await import("../../src/terminal/terminalConsole"));
});

function make(cols = 30) {
    const screen = new Screen(cols, 10, true); // convertEol, like the real console
    const listeners = new Set<(d: string) => void>();
    const state = { inputEnabled: false, focused: 0 };
    const surface: ConsoleSurface = {
        el: document.createElement("div"),
        get cols() {
            return screen.cols;
        },
        write: (d, cb) => screen.term.write(d, cb),
        cursorX: () => screen.cursor.x,
        clear: () => screen.term.write("\x1bc\x1b[3J"),
        text: () => bufferText(screen.buffer),
        onData: (cb) => {
            listeners.add(cb);
            return { dispose: () => void listeners.delete(cb) };
        },
        setInputEnabled: (on) => void (state.inputEnabled = on),
        focus: () => void state.focused++,
    };
    const inputs: Array<string | null> = [];
    let interrupts = 0;
    const keyRow = document.createElement("div");
    const con = new TerminalConsole(
        {
            onInput: (t) => inputs.push(t),
            onJump: () => { },
            onInterrupt: () => void interrupts++,
        },
        surface,
        { keyRow },
    );
    const type = (data: string) => listeners.forEach((l) => l(data));
    return {
        con,
        screen,
        inputs,
        state,
        keyRow,
        type,
        interrupts: () => interrupts,
        /** What a program does for input(): print the prompt, then ask for a line. */
        async prompt(text: string) {
            con.write("out", text);
            con.showInput(text);
            await screen.settle();
        },
    };
}

test("output: lines, stderr in red, and the plain text read back", async () => {
    const t = make();
    t.con.write("out", "hello\n");
    t.con.write("err", "oops\n");
    await t.screen.settle();
    assert.equal(t.con.text(), "hello\noops");
    const cell = t.screen.term.buffer.active.getLine(1)!.getCell(0)!;
    assert.equal(cell.isFgPalette(), true);
    assert.equal(cell.getFgColor(), 9, "bright red");
    const out = t.screen.term.buffer.active.getLine(0)!.getCell(0)!;
    assert.equal(out.isFgDefault(), true);
});

test("a program's own colour reset inside stderr does not drop the red", async () => {
    const t = make();
    t.con.write("err", "\x1b[1mbold\x1b[0m still red\n");
    await t.screen.settle();
    const line = t.screen.term.buffer.active.getLine(0)!;
    assert.equal(line.getCell(8)!.getFgColor(), 9); // the "s" of "still"
});

test("carriage return overwrites the line (progress bars)", async () => {
    const t = make();
    t.con.write("out", "10%\r50%\r100%\ndone\n");
    await t.screen.settle();
    assert.equal(t.con.text(), "100%\ndone");
});

test("ANSI colours and sequences split across chunks still work", async () => {
    const t = make();
    t.con.write("out", "a \x1b[3");
    t.con.write("out", "1mred\x1b[0m b\n");
    await t.screen.settle();
    assert.equal(t.con.text(), "a red b");
    assert.equal(t.screen.term.buffer.active.getLine(0)!.getCell(2)!.getFgColor(), 1);
});

test("a system line starts on a fresh line when the program left a prompt unfinished", async () => {
    const t = make();
    t.con.write("out", "Name? ");
    t.con.system("Stopped");
    await t.screen.settle();
    assert.equal(t.con.text(), "Name?\nStopped");
    t.con.system("Next");
    await t.screen.settle();
    assert.equal(t.con.text(), "Name?\nStopped\nNext");
});

test("input(): typing happens in the terminal, Enter sends the line with a newline", async () => {
    const t = make();
    await t.prompt("Name: ");
    assert.equal(t.con.waitingForInput, true);
    assert.equal(t.state.inputEnabled, true, "the soft keyboard may come up");
    assert.equal(t.keyRow.hidden, false);
    t.type("Ada");
    await t.screen.settle();
    assert.equal(t.con.text(), "Name: Ada");
    t.type("\r");
    await t.screen.settle();
    assert.deepEqual(t.inputs, ["Ada\n"]);
    assert.equal(t.con.waitingForInput, false);
    assert.equal(t.state.inputEnabled, false);
    assert.equal(t.keyRow.hidden, true);
    assert.deepEqual(t.screen.cursor, { x: 0, y: 1 });
});

test("the cursor column of the prompt is respected (editing never eats the prompt)", async () => {
    const t = make();
    await t.prompt(">>> ");
    t.type("abc\x01"); // Ctrl+A goes to the start of the text, not of the line
    await t.screen.settle();
    assert.deepEqual(t.screen.cursor, { x: 4, y: 0 });
    t.type("\x7f"); // nothing before the cursor: Backspace must not delete the prompt
    await t.screen.settle();
    assert.equal(t.con.text(), ">>> abc");
});

test("keys typed before the prompt has been drawn are not lost", async () => {
    const t = make();
    t.con.write("out", "Name: ");
    t.con.showInput();
    t.type("Bo"); // arrives while xterm has not parsed the prompt yet
    await t.screen.settle();
    t.type("b\r");
    await t.screen.settle();
    assert.deepEqual(t.inputs, ["Bob\n"]);
    assert.equal(t.con.text(), "Name: Bob");
});

test("Ctrl+D on an empty prompt is end-of-input; the input is hidden", async () => {
    const t = make();
    await t.prompt("> ");
    t.type("\x04");
    await t.screen.settle();
    assert.deepEqual(t.inputs, [null]);
    assert.equal(t.con.waitingForInput, false);
});

test("Ctrl+C: while waiting it echoes ^C and stops the program; while running it stops it too", async () => {
    const t = make();
    await t.prompt("> ");
    t.type("abc\x03");
    await t.screen.settle();
    assert.equal(t.interrupts(), 1);
    assert.equal(t.con.text(), "> abc^C");
    assert.deepEqual(t.inputs, []);

    const u = make();
    u.type("\x03"); // nothing is reading: still means "stop"
    assert.equal(u.interrupts(), 1);
    u.type("x"); // other typing while the program runs is ignored
    assert.equal(u.interrupts(), 1);
});

test("a pasted block with several lines feeds one line per prompt, none lost", async () => {
    const t = make();
    await t.prompt("1> ");
    t.type("one\rtwo\rthr");
    await t.screen.settle();
    assert.deepEqual(t.inputs, ["one\n"]);
    await t.prompt("2> "); // the program asks again
    assert.deepEqual(t.inputs, ["one\n", "two\n"]);
    await t.prompt("3> ");
    assert.equal(t.con.waitingForInput, true);
    t.type("ee\r"); // "thr" was kept as typed text
    await t.screen.settle();
    assert.deepEqual(t.inputs, ["one\n", "two\n", "three\n"]);
    assert.equal(t.con.text(), "1> one\n2> two\n3> three");
});

test("history is kept between prompts of one run", async () => {
    const t = make();
    await t.prompt("> ");
    t.type("first\r");
    await t.screen.settle();
    await t.prompt("> ");
    t.type("\x1b[A");
    await t.screen.settle();
    assert.equal(t.con.text(), "> first\n> first");
});

test("clear() keeps what was being typed and moves the prompt to the top", async () => {
    const t = make();
    t.con.write("out", "lots of output\n");
    await t.prompt("> ");
    t.type("abc");
    t.con.clear();
    await t.screen.settle();
    assert.equal(t.con.text(), "abc");
    t.type("d\r");
    await t.screen.settle();
    assert.deepEqual(t.inputs, ["abcd\n"]);
});

test("finish() hides the input and drops anything typed ahead", async () => {
    const t = make();
    await t.prompt("> ");
    t.type("abc");
    t.con.finish();
    assert.equal(t.con.waitingForInput, false);
    assert.equal(t.keyRow.hidden, true);
    assert.equal(t.state.inputEnabled, false);
    t.type("zzz\r"); // ignored: nothing is reading
    assert.deepEqual(t.inputs, []);
});

test("a program that ends while the prompt is still being drawn does not leave the editor running", async () => {
    const t = make();
    t.con.write("out", "x ");
    t.con.showInput();
    t.con.finish(); // before xterm parsed the prompt
    await t.screen.settle();
    assert.equal(t.con.waitingForInput, false);
    t.type("a");
    assert.deepEqual(t.inputs, []);
});

test("endsAtLineStart looks through trailing escape sequences", () => {
    assert.equal(endsAtLineStart("abc\n", false), true);
    assert.equal(endsAtLineStart("abc\n\x1b[0m", false), true);
    assert.equal(endsAtLineStart("abc\r", false), true);
    assert.equal(endsAtLineStart("abc", true), false);
    assert.equal(endsAtLineStart("\x1b[31m", true), true, "only a colour change: nothing moved");
    assert.equal(endsAtLineStart("\x1b[31m", false), false);
    assert.equal(endsAtLineStart("", true), true);
});