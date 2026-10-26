import { charWidth } from "./width";

/**
 * A small readline for the output console.
 *
 * A real shell has a PTY that echoes and edits for it. A Python program
 * waiting in `input()` does not: the runner just wants the finished line. So
 * when the console is a terminal (xterm.js), this class does the editing on
 * the page, the way a terminal driver would, and hands over the line once
 * Enter is pressed:
 *
 *   - echo, wrap-aware redraw (a long line that wraps onto the next row stays
 *     correct while you insert / delete in the middle of it)
 *   - Left/Right/Home/End, Ctrl+A/E/B/F, Alt/Ctrl+Left/Right (by word)
 *   - Backspace, Delete, Ctrl+W / Ctrl+U / Ctrl+K, Alt+D
 *   - Up/Down (and Ctrl+P/N) through a history list
 *   - Ctrl+D (EOF on an empty line), Ctrl+C (interrupt)
 *   - paste: a block with several lines yields one line per Enter and hands
 *     the unread rest back to the caller, so nothing is lost or reordered
 *
 * It only writes escape sequences through `host.write`; it never reads the
 * screen. The prompt (which the program already printed) is taken as given:
 * `start(col)` just needs to know which column the cursor is in.
 */

export type LineEvent =
    | { type: "submit"; text: string }
    | { type: "eof" }
    | { type: "interrupt" };

export interface LineEditorHost {
    write(data: string): void;
    readonly cols: number;
}

export interface LineEditorOptions {
    /** Past lines, oldest first. Shared with the caller; new lines are pushed onto it. */
    history?: string[];
    maxHistory?: number;
    /** What the Tab key inserts. */
    tab?: string;
}

interface Pos {
    row: number;
    col: number;
}

const isSpace = (ch: string): boolean => /\s/.test(ch);

export class LineEditor {
    private buf: string[] = [];
    private cur = 0;
    private startCol = 0;
    /** Where the cursor was last left, relative to the row the line started on. */
    private cursorRow = 0;
    private cursorCol = 0;
    private histIdx = 0;
    private draft = "";
    private running = false;
    private readonly history: string[];
    private readonly maxHistory: number;
    private readonly tabText: string;

    constructor(
        private readonly host: LineEditorHost,
        options: LineEditorOptions = {},
    ) {
        this.history = options.history ?? [];
        this.maxHistory = options.maxHistory ?? 200;
        this.tabText = options.tab ?? "    ";
    }

    get active(): boolean {
        return this.running;
    }

    /** What has been typed so far. */
    get text(): string {
        return this.buf.join("");
    }

    /** Begin a new line. The cursor is on `startCol` of the current row (right after the prompt). */
    start(startCol: number, initial = ""): void {
        this.buf = [...initial];
        this.cur = this.buf.length;
        this.startCol = Math.max(0, startCol);
        this.cursorRow = 0;
        this.cursorCol = this.startCol;
        this.histIdx = this.history.length;
        this.draft = "";
        this.running = true;
        if (initial) this.redraw();
    }

    /** Stop editing without reporting anything (the program ended, or the console was reset). */
    stop(): void {
        this.running = false;
        this.buf = [];
        this.cur = 0;
    }

    /**
     * Handle keyboard data. Stops at the first event that ends the line
     * (Enter / Ctrl+D / Ctrl+C) and returns what it did not read, so a pasted
     * block can be fed to the next line.
     */
    feed(data: string): { event: LineEvent | null; rest: string } {
        if (!this.running) return { event: null, rest: data };
        let changed = false; // the text on screen needs redrawing
        let moved = false; // only the cursor moved
        let i = 0;
        while (i < data.length) {
            const cp = data.codePointAt(i)!;
            const ch = String.fromCodePoint(cp);
            i += ch.length;

            if (ch === "\x1b") {
                const used = this.escape(data, i);
                i += used.consumed;
                if (used.changed) changed = true;
                if (used.moved) moved = true;
                continue;
            }

            switch (ch) {
                case "\r":
                case "\n": {
                    if (ch === "\r" && data[i] === "\n") i++; // CRLF counts once
                    this.flush(changed, moved, true);
                    const text = this.text;
                    this.host.write("\r\n");
                    this.remember(text);
                    this.running = false;
                    return {
                        event: { type: "submit", text },
                        rest: data.slice(i),
                    };
                }
                case "\x03":
                    this.flush(changed, moved, true);
                    this.host.write("^C\r\n");
                    this.running = false;
                    return { event: { type: "interrupt" }, rest: data.slice(i) };
                case "\x04":
                    if (this.buf.length === 0) {
                        this.host.write("\r\n");
                        this.running = false;
                        return { event: { type: "eof" }, rest: data.slice(i) };
                    }
                    if (this.deleteForward()) changed = true;
                    break;
                case "\x01":
                    moved = this.moveTo(0) || moved;
                    break;
                case "\x05":
                    moved = this.moveTo(this.buf.length) || moved;
                    break;
                case "\x02":
                    moved = this.moveTo(this.cur - 1) || moved;
                    break;
                case "\x06":
                    moved = this.moveTo(this.cur + 1) || moved;
                    break;
                case "\x08":
                case "\x7f":
                    if (this.deleteBack()) changed = true;
                    break;
                case "\x0b":
                    if (this.cur < this.buf.length) {
                        this.buf.length = this.cur;
                        changed = true;
                    }
                    break;
                case "\x15":
                    if (this.cur > 0) {
                        this.buf.splice(0, this.cur);
                        this.cur = 0;
                        changed = true;
                    }
                    break;
                case "\x17":
                    if (this.deleteWordBack()) changed = true;
                    break;
                case "\x10":
                    if (this.historyPrev()) changed = true;
                    break;
                case "\x0e":
                    if (this.historyNext()) changed = true;
                    break;
                case "\t":
                    this.insert(this.tabText);
                    changed = true;
                    break;
                default:
                    // Other control characters (Ctrl+L, bell, ...) do nothing here.
                    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) break;
                    this.insert(ch);
                    changed = true;
            }
        }
        this.flush(changed, moved, false);
        return { event: null, rest: "" };
    }

    // ------------------------------------------------------------ editing

    private insert(text: string): void {
        const chars = [...text];
        this.buf.splice(this.cur, 0, ...chars);
        this.cur += chars.length;
    }

    private deleteBack(): boolean {
        if (this.cur === 0) return false;
        this.buf.splice(this.cur - 1, 1);
        this.cur--;
        return true;
    }

    private deleteForward(): boolean {
        if (this.cur >= this.buf.length) return false;
        this.buf.splice(this.cur, 1);
        return true;
    }

    private wordLeft(from: number): number {
        let i = from;
        while (i > 0 && isSpace(this.buf[i - 1]!)) i--;
        while (i > 0 && !isSpace(this.buf[i - 1]!)) i--;
        return i;
    }

    private wordRight(from: number): number {
        let i = from;
        while (i < this.buf.length && isSpace(this.buf[i]!)) i++;
        while (i < this.buf.length && !isSpace(this.buf[i]!)) i++;
        return i;
    }

    private deleteWordBack(): boolean {
        const to = this.wordLeft(this.cur);
        if (to === this.cur) return false;
        this.buf.splice(to, this.cur - to);
        this.cur = to;
        return true;
    }

    private deleteWordForward(): boolean {
        const to = this.wordRight(this.cur);
        if (to === this.cur) return false;
        this.buf.splice(this.cur, to - this.cur);
        return true;
    }

    private moveTo(index: number): boolean {
        const next = Math.min(this.buf.length, Math.max(0, index));
        if (next === this.cur) return false;
        this.cur = next;
        return true;
    }

    private setText(text: string): void {
        this.buf = [...text];
        this.cur = this.buf.length;
    }

    private historyPrev(): boolean {
        if (this.histIdx === 0) return false;
        if (this.histIdx === this.history.length) this.draft = this.text;
        this.histIdx--;
        this.setText(this.history[this.histIdx]!);
        return true;
    }

    private historyNext(): boolean {
        if (this.histIdx >= this.history.length) return false;
        this.histIdx++;
        this.setText(
            this.histIdx === this.history.length
                ? this.draft
                : this.history[this.histIdx]!,
        );
        return true;
    }

    private remember(text: string): void {
        if (!text.trim() || this.history[this.history.length - 1] === text) return;
        this.history.push(text);
        while (this.history.length > this.maxHistory) this.history.shift();
    }

    // -------------------------------------------------------- escapes

    /** `at` is the index just after the ESC. Returns how many characters belong to the sequence. */
    private escape(
        data: string,
        at: number,
    ): { consumed: number; changed: boolean; moved: boolean } {
        const none = { consumed: 0, changed: false, moved: false };
        const next = data[at];
        if (next === undefined) return none;

        if (next === "[") {
            let j = at + 1;
            while (j < data.length && /[0-?]/.test(data[j]!)) j++; // parameter bytes
            while (j < data.length && /[ -/]/.test(data[j]!)) j++; // intermediates
            if (j >= data.length) return { ...none, consumed: j - at };
            const params = data.slice(at + 1, j).split(";");
            const final = data[j]!;
            const consumed = j + 1 - at;
            const mod = Number(params[1] ?? 1) - 1; // xterm: 1 + shift(1) + alt(2) + ctrl(4)
            const byWord = (mod & 6) !== 0;
            const first = Number(params[0] || 1);
            let changed = false;
            let moved = false;
            switch (final) {
                case "A":
                    changed = this.historyPrev();
                    break;
                case "B":
                    changed = this.historyNext();
                    break;
                case "C":
                    moved = this.moveTo(
                        byWord ? this.wordRight(this.cur) : this.cur + 1,
                    );
                    break;
                case "D":
                    moved = this.moveTo(byWord ? this.wordLeft(this.cur) : this.cur - 1);
                    break;
                case "H":
                    moved = this.moveTo(0);
                    break;
                case "F":
                    moved = this.moveTo(this.buf.length);
                    break;
                case "~":
                    if (first === 1 || first === 7) moved = this.moveTo(0);
                    else if (first === 4 || first === 8)
                        moved = this.moveTo(this.buf.length);
                    else if (first === 3)
                        changed = byWord ? this.deleteWordForward() : this.deleteForward();
                    break;
                default:
                    break; // Shift+Tab, Page Up/Down, mouse reports, ...: ignored
            }
            return { consumed, changed, moved };
        }

        if (next === "O") {
            const final = data[at + 1];
            if (final === undefined) return { ...none, consumed: 1 };
            let changed = false;
            let moved = false;
            if (final === "A") changed = this.historyPrev();
            else if (final === "B") changed = this.historyNext();
            else if (final === "C") moved = this.moveTo(this.cur + 1);
            else if (final === "D") moved = this.moveTo(this.cur - 1);
            else if (final === "H") moved = this.moveTo(0);
            else if (final === "F") moved = this.moveTo(this.buf.length);
            return { consumed: 2, changed, moved };
        }

        // ESC + key = Alt + key
        switch (next) {
            case "b":
                return { consumed: 1, changed: false, moved: this.moveTo(this.wordLeft(this.cur)) };
            case "f":
                return { consumed: 1, changed: false, moved: this.moveTo(this.wordRight(this.cur)) };
            case "d":
                return { consumed: 1, changed: this.deleteWordForward(), moved: false };
            case "\x7f":
                return { consumed: 1, changed: this.deleteWordBack(), moved: false };
            default:
                return { consumed: 1, changed: false, moved: false };
        }
    }

    // ---------------------------------------------------------- drawing

    /** Where each character starts, plus the cell after the last one, accounting for wrapping at `cols`. */
    private layout(): Pos[] {
        const cols = Math.max(1, this.host.cols);
        const out: Pos[] = [];
        let row = Math.floor(this.startCol / cols);
        let col = this.startCol % cols;
        for (const ch of this.buf) {
            const w = charWidth(ch.codePointAt(0)!);
            if (col >= cols || (w > 0 && col + w > cols)) {
                row++;
                col = 0;
            }
            out.push({ row, col });
            col += w;
        }
        if (col >= cols) {
            row++;
            col = 0;
        }
        out.push({ row, col });
        return out;
    }

    private flush(changed: boolean, moved: boolean, atEnd: boolean): void {
        if (atEnd && this.cur !== this.buf.length) {
            // Enter / Ctrl+C: the cursor goes to the end of the text before the line break.
            this.cur = this.buf.length;
            moved = true;
        }
        if (changed) this.redraw();
        else if (moved) this.placeCursor();
    }

    /** Repaint the whole line from where it started. One write, so xterm never shows a half-drawn line. */
    private redraw(): void {
        const pos = this.layout();
        const end = pos[this.buf.length]!;
        let out = "";
        if (this.cursorRow > 0) out += `\x1b[${this.cursorRow}A`;
        out += `\x1b[${(this.startCol % Math.max(1, this.host.cols)) + 1}G`;
        out += this.buf.join("") + "\x1b[J";
        // Text that ends exactly at the last column leaves the terminal in a
        // "wrap pending" state; force the wrap so the cursor really is where
        // `layout()` says it is.
        if (this.buf.length > 0 && end.col === 0) out += " \b";
        out += this.moveFrom(end, pos[this.cur]!);
        this.host.write(out);
    }

    /** Only the cursor moved: no need to repaint the text. */
    private placeCursor(): void {
        const target = this.layout()[this.cur]!;
        this.host.write(
            this.moveFrom({ row: this.cursorRow, col: this.cursorCol }, target),
        );
    }

    /** Escape sequence that moves the cursor from `from` to `to` (both relative to the start row); remembers `to`. */
    private moveFrom(from: Pos, to: Pos): string {
        this.cursorRow = to.row;
        this.cursorCol = to.col;
        let out = "";
        const dr = from.row - to.row;
        if (dr > 0) out += `\x1b[${dr}A`;
        else if (dr < 0) out += `\x1b[${-dr}B`;
        return out + `\x1b[${to.col + 1}G`;
    }
}