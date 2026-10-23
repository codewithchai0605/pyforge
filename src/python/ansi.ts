/**
 * Turns the raw text a Python program printed into drawing instructions for
 * the console: styled text runs, line feeds, and the carriage-return /
 * erase-line tricks progress bars (tqdm, pip-style) rely on.
 *
 * It is a *stream* parser: chunks arrive in arbitrary pieces (the runner
 * flushes every ~30 ms), so an escape sequence or a "\r\n" pair can be cut in
 * half between two chunks. Incomplete tails are held back until more data
 * arrives instead of being mis-rendered.
 */

export interface AnsiStyle {
  /** `var(--ansi-N)` for the 16 standard colours, or `#rrggbb`. */
  fg: string | null;
  bg: string | null;
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
}

export type AnsiToken =
  | { type: "text"; text: string; style: AnsiStyle }
  | { type: "lf" }
  /** "\r" not followed by "\n": the next text overwrites the current line. */
  | { type: "cr" }
  /** ESC[K / ESC[2K: wipe the current line. */
  | { type: "clear-line" };

const ESC = "\u001b";

function blank(): AnsiStyle {
  return {
    fg: null,
    bg: null,
    bold: false,
    dim: false,
    italic: false,
    underline: false,
  };
}

function hex(n: number): string {
  return n.toString(16).padStart(2, "0");
}

/** xterm 256-colour palette index -> CSS colour. */
function color256(n: number): string {
  if (n < 16) return `var(--ansi-${n})`;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `#${hex(v)}${hex(v)}${hex(v)}`;
  }
  const i = n - 16;
  const level = (c: number): number => (c === 0 ? 0 : 55 + c * 40);
  return `#${hex(level(Math.floor(i / 36)))}${hex(level(Math.floor(i / 6) % 6))}${hex(level(i % 6))}`;
}

export class AnsiParser {
  private style: AnsiStyle = blank();
  /** Unprocessed tail from the previous chunk (partial escape, or a lone "\r"). */
  private carry = "";

  push(chunk: string): AnsiToken[] {
    const input = this.carry + chunk;
    this.carry = "";
    const tokens: AnsiToken[] = [];
    let text = "";

    const flushText = (): void => {
      if (text) {
        tokens.push({ type: "text", text, style: { ...this.style } });
        text = "";
      }
    };

    for (let i = 0; i < input.length; i++) {
      const ch = input[i]!;

      if (ch === "\n") {
        flushText();
        tokens.push({ type: "lf" });
      } else if (ch === "\r") {
        if (i === input.length - 1) {
          // Can't tell "\r" from the first half of "\r\n" yet.
          this.carry = "\r";
          break;
        }
        if (input[i + 1] === "\n") continue; // CRLF: the "\n" does the work
        flushText();
        tokens.push({ type: "cr" });
      } else if (ch === ESC) {
        if (i + 1 >= input.length) {
          this.carry = input.slice(i);
          break;
        }
        if (input[i + 1] !== "[") continue; // a bare ESC: drop it
        let j = i + 2;
        while (j < input.length && /[0-9;?]/.test(input[j]!)) j++;
        if (j >= input.length) {
          this.carry = input.slice(i);
          break;
        }
        const final = input[j]!;
        const params = input.slice(i + 2, j);
        i = j;
        if (final === "m") {
          flushText();
          this.applySgr(params);
        } else if (final === "K") {
          flushText();
          tokens.push({ type: "clear-line" });
        }
        // Every other CSI (cursor movement, etc.) is ignored on purpose.
      } else if (ch === "\b") {
        // Backspace is rarely meaningful in a log view; drop it.
      } else {
        text += ch;
      }
    }
    flushText();
    return tokens;
  }

  /** Release a held-back lone "\r" (call when the program ends). */
  flush(): AnsiToken[] {
    const pending = this.carry;
    this.carry = "";
    return pending === "\r" ? [{ type: "cr" }] : [];
  }

  private applySgr(params: string): void {
    const codes =
      params === ""
        ? [0]
        : params.split(";").map((p) => (p === "" ? 0 : Number(p)));
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i]!;
      const s = this.style;
      if (c === 0) this.style = blank();
      else if (c === 1) s.bold = true;
      else if (c === 2) s.dim = true;
      else if (c === 3) s.italic = true;
      else if (c === 4) s.underline = true;
      else if (c === 22) ((s.bold = false), (s.dim = false));
      else if (c === 23) s.italic = false;
      else if (c === 24) s.underline = false;
      else if (c >= 30 && c <= 37) s.fg = `var(--ansi-${c - 30})`;
      else if (c >= 90 && c <= 97) s.fg = `var(--ansi-${c - 90 + 8})`;
      else if (c >= 40 && c <= 47) s.bg = `var(--ansi-${c - 40})`;
      else if (c >= 100 && c <= 107) s.bg = `var(--ansi-${c - 100 + 8})`;
      else if (c === 39) s.fg = null;
      else if (c === 49) s.bg = null;
      else if (c === 38 || c === 48) {
        const target = c === 38 ? "fg" : "bg";
        if (codes[i + 1] === 5 && codes[i + 2] !== undefined) {
          s[target] = color256(codes[i + 2]!);
          i += 2;
        } else if (codes[i + 1] === 2 && codes[i + 4] !== undefined) {
          s[target] =
            `#${hex(codes[i + 2]! & 255)}${hex(codes[i + 3]! & 255)}${hex(codes[i + 4]! & 255)}`;
          i += 4;
        }
      }
    }
  }
}
