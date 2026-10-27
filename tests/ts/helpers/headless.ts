import { Terminal } from "@xterm/headless";
import type { BufferLike } from "../../../src/terminal/types";

/** A real xterm.js engine without a DOM: the tests feed it what the app writes and read the screen back. */
export class Screen {
  readonly term: Terminal;
  constructor(cols = 20, rows = 8, convertEol = false) {
    this.term = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      convertEol,
      scrollback: 100,
    });
  }
  get cols(): number {
    return this.term.cols;
  }
  write(data: string): void {
    this.term.write(data);
  }
  /** Resolves once everything written so far has been parsed. */
  async settle(): Promise<void> {
    await new Promise<void>((resolve) => this.term.write("", resolve));
  }
  get cursor(): { x: number; y: number } {
    const b = this.term.buffer.active;
    return { x: b.cursorX, y: b.cursorY };
  }
  /** Visible rows, right-trimmed, with trailing empty rows dropped. */
  lines(): string[] {
    const b = this.term.buffer.active;
    const out: string[] = [];
    for (let y = 0; y < b.length; y++)
      out.push(b.getLine(y)?.translateToString(true) ?? "");
    while (out.length && out[out.length - 1] === "") out.pop();
    return out;
  }
  get buffer(): BufferLike {
    return this.term.buffer.active as unknown as BufferLike;
  }
}
