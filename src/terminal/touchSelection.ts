import type { Terminal } from "@xterm/xterm";
import { icon } from "@/components/icons";
import {
    cellAtPoint,
    compare,
    orderedRange,
    pointOfCell,
    wordAt,
    type CellRange,
    type Metrics,
} from "./selection";
import type { BufferLike, CellPoint } from "./types";

/**
 * Touch selection for xterm.js, which has none of its own: it only knows
 * mouse drags, and a finger does not drag a mouse.
 *
 *   long-press   selects the word under the finger; keep the finger down and
 *                drag to extend it (the view scrolls when you reach an edge)
 *   handles      two drag handles at the ends of the selection
 *   action bar   Copy / Paste / Select all, floating above the selection
 *   tap          clears the selection, or reports a plain tap to the owner
 *                (focus the terminal, open a link)
 *   long-press on a blank spot  shows Paste / Select all there
 *
 * Plain vertical drags are left alone, so xterm's own touch scrolling works.
 * The selection itself is xterm's (`term.select`), so `getSelection()`, the
 * highlight and Ctrl+C-to-copy all agree with what is on screen.
 */

export interface TouchSelectionActions {
    copy(): void;
    paste(): void;
    selectAll(): void;
}

export interface TouchSelectionOptions {
    term: Terminal;
    /** The element that receives the touches (xterm's root element). */
    target: HTMLElement;
    /** A positioned ancestor to place the handles and the bar in. */
    overlay: HTMLElement;
    actions: TouchSelectionActions;
    /** A touch that was neither a scroll nor a long-press. */
    onTap(cell: CellPoint): void;
}

const LONG_PRESS_MS = 420;
const MOVE_SLOP = 10; // px a finger may wander and still count as held in place
const HANDLE_LIFT = 22; // px: a dragged handle aims this far above the finger

type Mode = "idle" | "pending" | "extending" | "scrolling";

export class TouchSelection {
    private mode: Mode = "idle";
    private startX = 0;
    private startY = 0;
    private timer: ReturnType<typeof setTimeout> | undefined;
    private base: CellRange | null = null;
    private current: CellRange | null = null;
    private dragging: "start" | "end" | null = null;
    private lastAutoScroll = 0;
    /** Bar shown at a spot (no selection): where, in screen px. */
    private spot: { x: number; y: number } | null = null;
    private readonly bar: HTMLElement;
    private readonly handles: { start: HTMLElement; end: HTMLElement };
    private readonly disposers: Array<() => void> = [];
    private readonly term: Terminal;

    constructor(private readonly o: TouchSelectionOptions) {
        this.term = o.term;
        this.handles = { start: this.makeHandle("start"), end: this.makeHandle("end") };
        this.bar = this.makeBar();
        o.overlay.append(this.handles.start, this.handles.end, this.bar);

        const on = <K extends keyof HTMLElementEventMap>(
            type: K,
            fn: (e: HTMLElementEventMap[K]) => void,
            passive: boolean,
        ): void => {
            o.target.addEventListener(type, fn, { passive });
            this.disposers.push(() => o.target.removeEventListener(type, fn));
        };
        on("touchstart", (e) => this.touchStart(e), true);
        on("touchmove", (e) => this.touchMove(e), false);
        on("touchend", (e) => this.touchEnd(e), false);
        on("touchcancel", () => this.cancelGesture(), true);
        // Long-press raises a context menu on Android; ours replaces it.
        on("contextmenu", (e) => e.preventDefault(), false);

        for (const d of [
            this.term.onSelectionChange(() => this.sync()),
            this.term.onScroll(() => this.sync()),
            this.term.onResize(() => this.sync()),
        ])
            this.disposers.push(() => d.dispose());
    }

    dispose(): void {
        clearTimeout(this.timer);
        for (const d of this.disposers) d();
        this.handles.start.remove();
        this.handles.end.remove();
        this.bar.remove();
    }

    /** Clears the selection and hides the handles and the bar. */
    dismiss(): void {
        this.spot = null;
        this.base = this.current = null;
        if (this.term.hasSelection()) this.term.clearSelection();
        this.sync();
    }

    // --------------------------------------------------------- geometry

    private metrics(): Metrics | null {
        const screen = this.o.target.querySelector<HTMLElement>(".xterm-screen");
        if (!screen) return null;
        const r = screen.getBoundingClientRect();
        const { cols, rows } = this.term;
        if (r.width <= 0 || r.height <= 0 || cols <= 0 || rows <= 0) return null;
        return {
            left: r.left,
            top: r.top,
            cellW: r.width / cols,
            cellH: r.height / rows,
            cols,
            rows,
            viewportY: this.term.buffer.active.viewportY,
        };
    }

    private buffer(): BufferLike {
        return this.term.buffer.active as unknown as BufferLike;
    }

    // ---------------------------------------------------------- gestures

    private touchStart(e: TouchEvent): void {
        clearTimeout(this.timer);
        if (e.touches.length !== 1) return this.cancelGesture();
        const t = e.touches[0]!;
        this.startX = t.clientX;
        this.startY = t.clientY;
        this.mode = "pending";
        this.timer = setTimeout(() => this.longPress(), LONG_PRESS_MS);
    }

    private touchMove(e: TouchEvent): void {
        const t = e.touches[0];
        if (!t) return;
        if (this.mode === "pending") {
            if (Math.hypot(t.clientX - this.startX, t.clientY - this.startY) > MOVE_SLOP) {
                clearTimeout(this.timer);
                this.mode = "scrolling"; // xterm scrolls the buffer
            }
        } else if (this.mode === "extending") {
            e.preventDefault(); // no scrolling while a selection is being dragged
            this.extendTo(t.clientX, t.clientY);
        }
    }

    private touchEnd(e: TouchEvent): void {
        clearTimeout(this.timer);
        const mode = this.mode;
        this.mode = "idle";
        if (mode === "extending") {
            e.preventDefault();
            this.sync();
        } else if (mode === "pending") {
            // A tap. Cancelling the event stops the browser from replaying it as a
            // mouse click, which would clear what we just did or double-handle it.
            e.preventDefault();
            if (this.term.hasSelection() || this.spot) {
                this.dismiss();
                return;
            }
            const m = this.metrics();
            if (m) this.o.onTap(cellAtPoint(this.startX, this.startY, m));
        }
    }

    private cancelGesture(): void {
        clearTimeout(this.timer);
        this.mode = "idle";
    }

    private longPress(): void {
        if (this.mode !== "pending") return;
        const m = this.metrics();
        if (!m) return this.cancelGesture();
        try {
            navigator.vibrate?.(8);
        } catch {
            /* no haptics: fine */
        }
        const cell = cellAtPoint(this.startX, this.startY, m);
        const word = wordAt(this.buffer(), cell, m.cols);
        if (word) {
            this.spot = null;
            this.base = word;
            this.setSelection(word);
            this.mode = "extending";
        } else {
            // Nothing to select here: offer Paste / Select all at the finger.
            this.term.clearSelection();
            this.spot = { x: this.startX, y: this.startY };
            this.mode = "idle";
            this.sync();
        }
    }

    private extendTo(x: number, y: number): void {
        const m = this.metrics();
        if (!m || !this.base) return;
        // Near the top or bottom edge: scroll so the selection can go further.
        const now = Date.now();
        if (now - this.lastAutoScroll > 90) {
            if (y < m.top + m.cellH) {
                this.term.scrollLines(-1);
                this.lastAutoScroll = now;
            } else if (y > m.top + m.cellH * (m.rows - 1)) {
                this.term.scrollLines(1);
                this.lastAutoScroll = now;
            }
        }
        const fresh = this.metrics() ?? m;
        const cell = cellAtPoint(x, y, fresh);
        const { start, end } = this.base;
        this.setSelection(
            compare(cell, start, fresh.cols) < 0
                ? { start: cell, end }
                : compare(cell, end, fresh.cols) > 0
                    ? { start, end: cell }
                    : this.base,
        );
    }

    private setSelection(range: CellRange): void {
        const cols = this.term.cols;
        const r = orderedRange(range.start, range.end, cols);
        this.current = { start: r.start, end: r.end };
        this.term.select(r.start.col, r.start.row, r.length);
    }

    // ----------------------------------------------------------- handles

    private makeHandle(which: "start" | "end"): HTMLElement {
        const h = document.createElement("div");
        h.className = `pf-handle pf-handle-${which}`;
        h.hidden = true;
        h.addEventListener("pointerdown", (e) => {
            e.preventDefault();
            e.stopPropagation();
            h.setPointerCapture?.(e.pointerId);
            this.dragging = which;
            this.bar.hidden = true;
        });
        h.addEventListener("pointermove", (e) => {
            if (!this.dragging || !this.current) return;
            const m = this.metrics();
            if (!m) return;
            const cell = cellAtPoint(e.clientX, e.clientY - HANDLE_LIFT, m);
            const { start, end } = this.current;
            // Dragging one end past the other turns it into the other handle.
            if (this.dragging === "start") {
                if (compare(cell, end, m.cols) > 0) {
                    this.dragging = "end";
                    this.setSelection({ start: end, end: cell });
                } else this.setSelection({ start: cell, end });
            } else if (compare(cell, start, m.cols) < 0) {
                this.dragging = "start";
                this.setSelection({ start: cell, end: start });
            } else this.setSelection({ start, end: cell });
        });
        const release = (): void => {
            this.dragging = null;
            this.sync();
        };
        h.addEventListener("pointerup", release);
        h.addEventListener("pointercancel", release);
        return h;
    }

    private makeBar(): HTMLElement {
        const bar = document.createElement("div");
        bar.className = "pf-sel-bar";
        bar.hidden = true;
        bar.setAttribute("role", "toolbar");
        bar.setAttribute("aria-label", "Terminal selection");
        // Never take focus from the terminal (that would hide the keyboard).
        bar.addEventListener("pointerdown", (e) => e.preventDefault());
        return bar;
    }

    private setBarButtons(withCopy: boolean): void {
        const specs: Array<[string, "copy" | "paste" | "selectAll", () => void]> = [];
        if (withCopy) specs.push(["Copy", "copy", () => this.o.actions.copy()]);
        specs.push(["Paste", "paste", () => this.o.actions.paste()]);
        specs.push(["Select all", "selectAll", () => this.o.actions.selectAll()]);
        this.bar.replaceChildren(
            ...specs.map(([label, name, run]) => {
                const b = document.createElement("button");
                b.type = "button";
                b.className = "pf-sel-btn";
                b.title = label;
                b.setAttribute("aria-label", label);
                b.append(icon(name, 18));
                b.addEventListener("click", () => {
                    this.spot = null;
                    run();
                    this.sync();
                });
                return b;
            }),
        );
    }

    /** Brings the handles and the bar in line with the current selection. */
    private sync(): void {
        const m = this.metrics();
        const overlay = this.o.overlay.getBoundingClientRect();
        const sel = this.term.hasSelection() ? this.term.getSelectionPosition() : undefined;

        let range: CellRange | null = null;
        if (sel && m) {
            // xterm reports 0-based cells and an exclusive end; ours is inclusive.
            const start = { col: sel.start.x, row: sel.start.y };
            let end = { col: sel.end.x - 1, row: sel.end.y };
            if (end.col < 0) end = { col: m.cols - 1, row: end.row - 1 };
            range = { start, end };
            this.current = range;
        } else {
            this.current = null;
        }

        const place = (el: HTMLElement, p: { x: number; y: number } | null): void => {
            el.hidden = p === null;
            if (p) {
                el.style.left = `${p.x - overlay.left}px`;
                el.style.top = `${p.y - overlay.top}px`;
            }
        };
        if (range && m) {
            place(this.handles.start, pointOfCell(range.start, "start", m));
            place(this.handles.end, pointOfCell(range.end, "end", m));
        } else {
            this.handles.start.hidden = this.handles.end.hidden = true;
        }

        const showBar = (range && m) || this.spot;
        if (!showBar || this.dragging || this.mode === "extending") {
            this.bar.hidden = true;
            return;
        }
        this.setBarButtons(range !== null);
        this.bar.hidden = false;
        const barW = this.bar.offsetWidth || 150;
        const barH = this.bar.offsetHeight || 40;
        let x: number;
        let y: number;
        if (range && m) {
            const top = pointOfCell(range.start, "start", m);
            const bottom = pointOfCell(range.end, "end", m);
            const anchorY = top ? top.y - m.cellH : (bottom?.y ?? m.top);
            x = (top?.x ?? bottom?.x ?? m.left) - overlay.left;
            y = anchorY - overlay.top - barH - 10;
            if (y < 4) y = (bottom?.y ?? anchorY) - overlay.top + 30; // no room above: go below
        } else {
            x = this.spot!.x - overlay.left - barW / 2;
            y = this.spot!.y - overlay.top - barH - 18;
        }
        x = Math.min(Math.max(4, x), Math.max(4, overlay.width - barW - 4));
        y = Math.min(Math.max(4, y), Math.max(4, overlay.height - barH - 4));
        this.bar.style.left = `${x}px`;
        this.bar.style.top = `${y}px`;
    }
}