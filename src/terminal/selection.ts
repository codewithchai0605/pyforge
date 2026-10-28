import type { BufferLike, BufferLineLike, CellPoint } from "./types";

/**
 * The arithmetic behind touch selection. xterm.js can only select "N cells
 * starting here, running on through the following rows", so every selection
 * is turned into a start cell and a length. All points are in absolute buffer
 * coordinates (scrollback included), 0-based.
 */

export const linear = (p: CellPoint, cols: number): number =>
  p.row * cols + p.col;

export const fromLinear = (n: number, cols: number): CellPoint => ({
  row: Math.floor(n / cols),
  col: n % cols,
});

export function compare(a: CellPoint, b: CellPoint, cols: number): number {
  return linear(a, cols) - linear(b, cols);
}

export interface CellRange {
  start: CellPoint;
  end: CellPoint;
}

/** The two points in reading order, and the number of cells from the first to the second, both included. */
export function orderedRange(
  a: CellPoint,
  b: CellPoint,
  cols: number,
): CellRange & { length: number } {
  const [start, end] = compare(a, b, cols) <= 0 ? [a, b] : [b, a];
  return { start, end, length: linear(end, cols) - linear(start, cols) + 1 };
}

export interface Metrics {
  /** Screen position of the top-left corner of the first cell. */
  left: number;
  top: number;
  cellW: number;
  cellH: number;
  cols: number;
  rows: number;
  /** Buffer row shown at the top of the screen. */
  viewportY: number;
}

/** The cell under a screen point, clamped to the grid. */
export function cellAtPoint(
  x: number,
  y: number,
  m: Metrics,
): CellPoint {
  const col = Math.min(m.cols - 1, Math.max(0, Math.floor((x - m.left) / m.cellW)));
  const row = Math.min(m.rows - 1, Math.max(0, Math.floor((y - m.top) / m.cellH)));
  return { col, row: m.viewportY + row };
}

/** Screen position of the bottom-left (`edge: "start"`) or bottom-right (`"end"`) corner of a cell, or null if it is scrolled out of view. */
export function pointOfCell(
  cell: CellPoint,
  edge: "start" | "end",
  m: Metrics,
): { x: number; y: number } | null {
  const visibleRow = cell.row - m.viewportY;
  if (visibleRow < 0 || visibleRow >= m.rows) return null;
  return {
    x: m.left + (cell.col + (edge === "end" ? 1 : 0)) * m.cellW,
    y: m.top + (visibleRow + 1) * m.cellH,
  };
}

function rowText(line: BufferLineLike, cols: number): string[] {
  // One entry per cell; the second half of a wide character repeats the first so a word never splits in it.
  const out: string[] = [];
  let last = " ";
  for (let x = 0; x < cols; x++) {
    const cell = line.getCell(x);
    if (!cell) {
      out.push(" ");
      continue;
    }
    if (cell.getWidth() === 0) {
      out.push(last);
      continue;
    }
    last = cell.getChars() || " ";
    out.push(last);
  }
  return out;
}

/** Characters that end a word. Paths, dotted names and dashes stay in one piece. */
export const WORD_SEPARATORS = " \t()[]{}<>'\"`,;|";

/** The word under `at` (within its row), or null if the cell is blank. */
export function wordAt(
  buf: BufferLike,
  at: CellPoint,
  cols: number,
  separators = WORD_SEPARATORS,
): CellRange | null {
  const line = buf.getLine(at.row);
  if (!line) return null;
  const cells = rowText(line, cols);
  const isWord = (i: number): boolean =>
    cells[i] !== undefined && cells[i] !== " " && !separators.includes(cells[i]!);
  if (!isWord(at.col)) return null;
  let from = at.col;
  let to = at.col;
  while (from > 0 && isWord(from - 1)) from--;
  while (to < cols - 1 && isWord(to + 1)) to++;
  return { start: { col: from, row: at.row }, end: { col: to, row: at.row } };
}

/** Straight-line distance between two touch points. */
export function touchDistance(
  a: { clientX: number; clientY: number },
  b: { clientX: number; clientY: number },
): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

/** The text size a pinch asks for: the size when the fingers landed, scaled by how far they have moved apart. */
export function pinchSize(
  startSize: number,
  startDistance: number,
  distance: number,
  min: number,
  max: number,
): number {
  if (startDistance <= 0) return startSize;
  return Math.min(max, Math.max(min, Math.round((startSize * distance) / startDistance)));
}