import test from "node:test";
import assert from "node:assert/strict";
import { LineEditor } from "../../src/terminal/lineEditor";
import { Screen } from "./helpers/headless";

/** An editor wired to a real xterm engine, with the prompt already printed. */
async function make(cols = 10, prompt = "", history: string[] = []) {
  const screen = new Screen(cols, 8);
  screen.write(prompt);
  await screen.settle();
  const editor = new LineEditor(screen, { history });
  editor.start(screen.cursor.x);
  const type = async (data: string) => {
    const result = editor.feed(data);
    await screen.settle();
    return result;
  };
  return { screen, editor, type, history };
}

test("typed text is echoed and Enter submits it on a fresh line", async () => {
  const { screen, editor, type } = await make(20, "Name: ");
  await type("Ada");
  assert.deepEqual(screen.lines(), ["Name: Ada"]);
  assert.deepEqual(screen.cursor, { x: 9, y: 0 });
  const { event } = await type("\r");
  assert.deepEqual(event, { type: "submit", text: "Ada" });
  assert.equal(editor.active, false);
  assert.deepEqual(screen.cursor, { x: 0, y: 1 });
});

test("insert in the middle, Backspace and Delete keep the cursor in the right place", async () => {
  const { screen, type } = await make(20, ">>> ");
  await type("helo");
  await type("\x1b[D"); // left
  await type("l");
  assert.deepEqual(screen.lines(), [">>> hello"]);
  assert.deepEqual(screen.cursor, { x: 8, y: 0 }); // before the final "o"
  await type("\x7f"); // backspace removes the l just typed
  assert.deepEqual(screen.lines(), [">>> helo"]);
  await type("\x1b[3~"); // delete removes "o"
  assert.deepEqual(screen.lines(), [">>> hel"]);
  assert.deepEqual(screen.cursor, { x: 7, y: 0 });
});

test("a line that wraps stays correct while editing in the middle of it", async () => {
  const { screen, type } = await make(10, "Name: "); // 4 free columns on row 0
  await type("abcdefghijkl");
  assert.deepEqual(screen.lines(), ["Name: abcd", "efghijkl"]);
  assert.deepEqual(screen.cursor, { x: 8, y: 1 });
  await type("\x01"); // Ctrl+A: back to the start of the text
  assert.deepEqual(screen.cursor, { x: 6, y: 0 });
  await type("X");
  assert.deepEqual(screen.lines(), ["Name: Xabc", "defghijkl"]);
  assert.deepEqual(screen.cursor, { x: 7, y: 0 });
  await type("\x05"); // Ctrl+E
  assert.deepEqual(screen.cursor, { x: 9, y: 1 });
  await type("\x15"); // Ctrl+U wipes the whole line, including the wrapped row
  assert.deepEqual(screen.lines(), ["Name: "]);
  assert.deepEqual(screen.cursor, { x: 6, y: 0 });
});

test("text that ends exactly at the last column puts the cursor on the next row", async () => {
  const { screen, type } = await make(10, "Name: ");
  await type("abcd"); // fills columns 6..9
  assert.deepEqual(screen.cursor, { x: 0, y: 1 });
  await type("e");
  assert.deepEqual(screen.lines(), ["Name: abcd", "e"]);
  await type("\x7f\x7f"); // back across the wrap
  assert.deepEqual(screen.lines(), ["Name: abc"]);
  assert.deepEqual(screen.cursor, { x: 9, y: 0 });
});

test("history: Up / Down walk it and the unfinished line comes back", async () => {
  const { screen, type, history } = await make(30, ">>> ", ["first", "second"]);
  await type("dra");
  await type("\x1b[A");
  assert.deepEqual(screen.lines(), [">>> second"]);
  await type("\x1b[A");
  assert.deepEqual(screen.lines(), [">>> first"]);
  await type("\x1b[A"); // already at the oldest
  assert.deepEqual(screen.lines(), [">>> first"]);
  await type("\x1b[B");
  await type("\x1b[B");
  assert.deepEqual(screen.lines(), [">>> dra"]);
  await type("\r");
  assert.deepEqual(history, ["first", "second", "dra"]);
});

test("empty lines and repeats are not added to history", async () => {
  const history = ["same"];
  const { editor, type } = await make(20, "", history);
  await type("\r");
  assert.deepEqual(history, ["same"]);
  editor.start(0);
  await type("same\r");
  assert.deepEqual(history, ["same"]);
});

test("Ctrl+D: EOF on an empty line, delete-forward otherwise; Ctrl+C interrupts", async () => {
  const a = await make(20, "> ");
  assert.deepEqual((await a.type("\x04")).event, { type: "eof" });

  const b = await make(20, "> ");
  await b.type("ab");
  await b.type("\x1b[D");
  await b.type("\x04"); // deletes "b"
  assert.deepEqual(b.screen.lines(), ["> a"]);

  const c = await make(20, "> ");
  await c.type("abc");
  const { event } = await c.type("\x03");
  assert.deepEqual(event, { type: "interrupt" });
  assert.deepEqual(c.screen.lines(), ["> abc^C"]);
  assert.equal(c.editor.active, false);
});

test("pasting several lines: each Enter ends one line and the rest is handed back", async () => {
  const { editor, type, screen } = await make(20, "> ");
  const first = await type("one\rtwo\rthr");
  assert.deepEqual(first.event, { type: "submit", text: "one" });
  assert.equal(first.rest, "two\rthr");
  screen.write("> "); // the program prints its next prompt
  await screen.settle();
  editor.start(2);
  const second = await type(first.rest);
  assert.deepEqual(second.event, { type: "submit", text: "two" });
  assert.equal(second.rest, "thr");
  screen.write("> ");
  await screen.settle();
  editor.start(2);
  const third = await type(second.rest);
  assert.equal(third.event, null);
  assert.equal(editor.text, "thr");
  assert.equal(screen.lines().at(-1), "> thr");
});

test("CRLF in pasted text counts as one Enter", async () => {
  const { type } = await make(20, "> ");
  const r = await type("a\r\nb");
  assert.deepEqual(r.event, { type: "submit", text: "a" });
  assert.equal(r.rest, "b");
});

test("word movement and word deletion", async () => {
  const { screen, type } = await make(40, "> ");
  await type("print hello world");
  await type("\x17"); // Ctrl+W removes "world"
  assert.deepEqual(screen.lines(), ["> print hello "]);
  await type("\x1b[1;5D"); // Ctrl+Left: start of "hello"
  assert.deepEqual(screen.cursor, { x: 8, y: 0 });
  await type("\x1bb"); // Alt+B: start of "print"
  assert.deepEqual(screen.cursor, { x: 2, y: 0 });
  await type("\x1bf"); // Alt+F: end of "print"
  assert.deepEqual(screen.cursor, { x: 7, y: 0 });
  await type("\x0b"); // Ctrl+K kills to the end
  assert.deepEqual(screen.lines(), ["> print"]);
});

test("Home/End keys in both common encodings", async () => {
  const { screen, type } = await make(20, "> ");
  await type("abc");
  await type("\x1b[H");
  assert.deepEqual(screen.cursor, { x: 2, y: 0 });
  await type("\x1b[F");
  assert.deepEqual(screen.cursor, { x: 5, y: 0 });
  await type("\x1bOH");
  assert.deepEqual(screen.cursor, { x: 2, y: 0 });
  await type("\x1b[4~");
  assert.deepEqual(screen.cursor, { x: 5, y: 0 });
});

test("Tab inserts spaces; unknown control keys are ignored", async () => {
  const { screen, type } = await make(20, "> ");
  await type("\t");
  await type("\x0c\x07"); // Ctrl+L, bell
  await type("x");
  assert.deepEqual(screen.lines(), [">     x"]);
});

test("wide characters take two cells", async () => {
  const { screen, type } = await make(20, "> ");
  await type("日本");
  assert.deepEqual(screen.cursor, { x: 6, y: 0 });
  await type("\x1b[D");
  assert.deepEqual(screen.cursor, { x: 4, y: 0 });
  await type("\x7f");
  assert.deepEqual(screen.lines(), ["> 本"]);
});

test("a wide character that does not fit wraps early, like the terminal does", async () => {
  const { screen, type } = await make(10, "Name: ");
  await type("abc日");
  assert.deepEqual(screen.lines(), ["Name: abc", "日"]);
  assert.deepEqual(screen.cursor, { x: 2, y: 1 });
  await type("\x7f");
  assert.deepEqual(screen.lines(), ["Name: abc"]);
  assert.deepEqual(screen.cursor, { x: 9, y: 0 });
});
