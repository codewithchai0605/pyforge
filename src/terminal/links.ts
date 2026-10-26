import type { ILink, ILinkProvider } from "@xterm/xterm";
import type { BufferLike, CellPoint } from "./types";

/**
 * Finds tappable things in the terminal's text: web URLs, and the
 * `File "x.py", line 12` lines of a Python traceback (which jump to the file
 * in the editor).
 *
 * It works on *logical* lines. A traceback line is longer than a phone's
 * screen is wide, so the terminal wraps it over several rows; a link has to
 * survive that, or only the first row would be tappable. xterm marks the
 * continuation rows with `isWrapped`, which is what is followed here.
 */

export type LinkKind = "traceback" | "url";

export interface FoundLink {
    kind: LinkKind;
    /** The text the link covers on screen. */
    text: string;
    /** First and last cell of the link (inclusive; 0-based; `row` is absolute in the buffer). */
    start: CellPoint;
    end: CellPoint;
    /** traceback only */
    path?: string;
    line?: number;
    /** url only */
    url?: string;
}

export const URL_RE = /https?:\/\/[^\s<>"'`\\^{|}]*[^\s<>"'`\\^{|}.,;:!?)\]]/g;
const TRACEBACK_RE = /File "(.+?)", line (\d+)/g;

interface LogicalLine {
    text: string;
    /** One entry per UTF-16 unit of `text`: the cell it was drawn in. */
    cells: CellPoint[];
}

/** The text of the whole wrapped line that contains `row`, with a map back to cells. */
export function logicalLineAt(
    buf: BufferLike,
    row: number,
): LogicalLine | null {
    if (!buf.getLine(row)) return null;
    let first = row;
    while (first > 0 && buf.getLine(first)?.isWrapped) first--;
    let last = row;
    while (last + 1 < buf.length && buf.getLine(last + 1)?.isWrapped) last++;

    let text = "";
    const cells: CellPoint[] = [];
    for (let y = first; y <= last; y++) {
        const line = buf.getLine(y);
        if (!line) continue;
        for (let x = 0; x < line.length; x++) {
            const cell = line.getCell(x);
            if (!cell || cell.getWidth() === 0) continue; // second half of a wide character
            const chars = cell.getChars() || " ";
            for (let u = 0; u < chars.length; u++) {
                text += chars[u];
                cells.push({ col: x, row: y });
            }
        }
    }
    // Blank cells at the end of the last row are not part of the text.
    const trimmed = text.replace(/\s+$/, "");
    return { text: trimmed, cells: cells.slice(0, trimmed.length) };
}

/** Every link on the logical line containing `row`. */
export function findLinks(buf: BufferLike, row: number): FoundLink[] {
    const line = logicalLineAt(buf, row);
    if (!line || !line.text) return [];
    const { text, cells } = line;
    const found: FoundLink[] = [];

    // One traceback location per line. The whole rest of the line is the tap
    // target: it is easier to hit than the short "line 12" part.
    TRACEBACK_RE.lastIndex = 0;
    const tb = TRACEBACK_RE.exec(text);
    if (tb) {
        found.push({
            kind: "traceback",
            text: text.slice(tb.index),
            start: cells[tb.index]!,
            end: cells[text.length - 1]!,
            path: tb[1]!,
            line: Number(tb[2]),
        });
    }

    URL_RE.lastIndex = 0;
    for (let m = URL_RE.exec(text); m; m = URL_RE.exec(text)) {
        found.push({
            kind: "url",
            text: m[0],
            start: cells[m.index]!,
            end: cells[m.index + m[0].length - 1]!,
            url: m[0],
        });
    }
    return found;
}

const linear = (p: CellPoint, cols: number): number => p.row * cols + p.col;

/** The link under `cell`, if any. */
export function linkAt(
    buf: BufferLike,
    cell: CellPoint,
    cols: number,
): FoundLink | null {
    const at = linear(cell, cols);
    for (const link of findLinks(buf, cell.row))
        if (at >= linear(link.start, cols) && at <= linear(link.end, cols))
            return link;
    return null;
}

/** An xterm.js link provider backed by `findLinks`, for hover/click with a mouse or hardware keyboard. */
export function createLinkProvider(
    term: { readonly cols: number; readonly buffer: { readonly active: BufferLike } },
    kinds: ReadonlySet<LinkKind>,
    activate: (link: FoundLink) => void,
): ILinkProvider {
    return {
        provideLinks(y, callback) {
            const row = y - 1;
            const links = findLinks(term.buffer.active, row).filter(
                (l) => kinds.has(l.kind) && l.start.row <= row && l.end.row >= row,
            );
            if (links.length === 0) return callback(undefined);
            callback(
                links.map(
                    (l): ILink => ({
                        range: {
                            start: { x: l.start.col + 1, y: l.start.row + 1 },
                            end: { x: l.end.col + 1, y: l.end.row + 1 },
                        },
                        text: l.text,
                        decorations: { pointerCursor: true, underline: true },
                        activate: () => activate(l),
                    }),
                ),
            );
        },
    };
}