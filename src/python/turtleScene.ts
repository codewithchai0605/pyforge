/**
 * Interprets the turtle command stream (see shims/turtle.py's header) and
 * draws it. Python already did all the geometry; this only has to
 *
 *   1. keep what was drawn (one off-screen *layer* per turtle that has drawn
 *      something, so `t.clear()` clears just that turtle's drawing),
 *   2. animate moves over the durations Python computed, and
 *   3. composite layers + stamps + turtle cursors onto the visible canvas,
 *      scaled to fit the available space.
 *
 * It has no DOM dependency: off-screen surfaces come from an injected
 * factory, which is also what makes it unit-testable with a recording fake.
 *
 * Coordinates: commands use turtle coordinates (origin centred, y up). Surfaces
 * use "window pixels" (origin top-left, y down) of the logical window size
 * given by `setup`, so a script written for a 600x600 window looks right on
 * any screen; `render()` scales that window to fit.
 */
import type { TurtleCmd } from './protocol';

export interface Surface {
  ctx: CanvasRenderingContext2D;
  /** What to pass to drawImage() when compositing this layer. */
  image: CanvasImageSource;
  clear(): void;
}
export type SurfaceFactory = (width: number, height: number) => Surface;

export interface SceneHooks {
  onSetup?(width: number, height: number): void;
  onTitle?(title: string): void;
  onKeys?(keys: string[]): void;
  onAsk?(id: number, kind: 'text' | 'num', title: string, prompt: string): void;
  onDone?(): void;
  onBye?(): void;
}

type Point = [number, number];

interface Cursor {
  x: number;
  y: number;
  heading: number;
  shape: string;
  pen: string;
  fill: string;
  sx: number;
  sy: number;
  outline: number;
  visible: boolean;
}

interface Stamp {
  sid: number;
  x: number;
  y: number;
  heading: number;
  shape: string;
  sx: number;
  sy: number;
  outline: number;
  pen: string;
  fill: string;
}

interface Segment {
  pts: Point[];
  color: string;
  width: number;
}

interface Anim {
  kind: 'move' | 'turn';
  tid: number;
  ms: number;
  start: number | null;
  // move
  pts: Point[];
  cumulative: number[];
  total: number;
  drawn: number;
  down: boolean;
  color: string;
  width: number;
  // heading (both kinds)
  h0: number;
  h1: number;
}

/** Standard turtle shapes, defined pointing "up" (+y) in pixel units. */
export const DEFAULT_SHAPES: Record<string, Point[]> = {
  classic: [[0, 0], [-5, -9], [0, -7], [5, -9]],
  arrow: [[-10, 0], [10, 0], [0, 10]],
  triangle: [[10, -5.77], [0, 11.55], [-10, -5.77]],
  square: [[10, -10], [10, 10], [-10, 10], [-10, -10]],
  circle: Array.from({ length: 24 }, (_, i): Point => {
    const a = (i / 24) * Math.PI * 2;
    return [Math.cos(a) * 10, Math.sin(a) * 10];
  }),
  turtle: [
    [0, 16], [-2, 14], [-1, 10], [-4, 7], [-7, 9], [-9, 8], [-6, 5], [-7, 1], [-5, -3], [-8, -6], [-6, -8], [-4, -5],
    [0, -7], [4, -5], [6, -8], [8, -6], [5, -3], [7, 1], [6, 5], [9, 8], [7, 9], [4, 7], [1, 10], [2, 14],
  ],
  blank: [],
};

/** If this many commands are waiting, the UI is behind: stop animating and catch up. */
const CATCH_UP_QUEUE = 2000;

const DEFAULT_CURSOR = (): Cursor => ({
  x: 0, y: 0, heading: 0, shape: 'classic', pen: 'black', fill: 'black', sx: 1, sy: 1, outline: 1, visible: true,
});

export class TurtleScene {
  width = 640;
  height = 640;
  bg = 'white';
  private world: [number, number, number, number] | null = null;

  private layers = new Map<number, Surface>();
  private cursors = new Map<number, Cursor>();
  private stamps: Stamp[] = [];
  private shapes = new Map<string, Point[]>(Object.entries(DEFAULT_SHAPES));
  /** Segments drawn since begin_fill, per turtle, so the outline can be re-stroked over the fill. */
  private fills = new Map<number, Segment[]>();
  private queue: TurtleCmd[] = [];
  private anim: Anim | null = null;

  constructor(
    private readonly createSurface: SurfaceFactory,
    private readonly hooks: SceneHooks = {},
  ) {}

  /** A copy of one turtle's current cursor state (for tests and hit-testing). */
  getCursor(tid: number): Readonly<Cursor> | undefined {
    const c = this.cursors.get(tid);
    return c ? { ...c } : undefined;
  }

  // ------------------------------------------------------------- input

  push(cmds: TurtleCmd[]): void {
    for (const c of cmds) this.queue.push(c);
  }

  get pending(): number {
    return this.queue.length + (this.anim ? 1 : 0);
  }

  /** True while something is still animating or queued (the host should keep ticking). */
  get busy(): boolean {
    return this.pending > 0;
  }

  /** Advance to time `now` (ms). Returns true if the picture changed. */
  step(now: number): boolean {
    let changed = false;
    const hurry = this.queue.length > CATCH_UP_QUEUE;
    for (;;) {
      if (this.anim) {
        const a = this.anim;
        if (a.start === null) a.start = now;
        const f = hurry ? 1 : Math.min(1, (now - a.start) / Math.max(a.ms, 1));
        this.advance(a, f);
        changed = true;
        if (f < 1) return true;
        this.anim = null;
        continue;
      }
      const cmd = this.queue.shift();
      if (!cmd) break;
      changed = true;
      const anim = hurry ? null : this.beginAnimation(cmd);
      if (anim) this.anim = anim;
      else this.applyInstant(cmd);
    }
    return changed;
  }

  // --------------------------------------------------------- geometry

  private bounds(): [number, number, number, number] {
    return this.world ?? [-this.width / 2, -this.height / 2, this.width / 2, this.height / 2];
  }

  /** Turtle/world coordinates -> window pixels (y down). */
  toWindow(x: number, y: number): Point {
    const [llx, lly, urx, ury] = this.bounds();
    return [((x - llx) / (urx - llx)) * this.width, this.height - ((y - lly) / (ury - lly)) * this.height];
  }

  /** A point on the visible canvas of size vw x vh -> turtle/world coordinates. */
  toWorld(vx: number, vy: number, vw: number, vh: number): { x: number; y: number } {
    const s = Math.min(vw / this.width, vh / this.height);
    const wx = (vx - (vw - this.width * s) / 2) / s;
    const wy = (vy - (vh - this.height * s) / 2) / s;
    const [llx, lly, urx, ury] = this.bounds();
    return { x: llx + (wx / this.width) * (urx - llx), y: lly + ((this.height - wy) / this.height) * (ury - lly) };
  }

  // ------------------------------------------------------------ layers

  private layer(tid: number): Surface {
    let l = this.layers.get(tid);
    if (!l) {
      l = this.createSurface(this.width, this.height);
      this.layers.set(tid, l);
    }
    return l;
  }

  private cursor(tid: number): Cursor {
    let c = this.cursors.get(tid);
    if (!c) {
      c = DEFAULT_CURSOR();
      this.cursors.set(tid, c);
    }
    return c;
  }

  private stroke(ctx: CanvasRenderingContext2D, pts: Point[], color: string, width: number): void {
    if (pts.length === 0) return;
    ctx.beginPath();
    const [x0, y0] = this.toWindow(...pts[0]!);
    ctx.moveTo(x0, y0);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(...this.toWindow(...pts[i]!));
    // A single point (zero-length move) still leaves a dot thanks to the round cap.
    if (pts.length === 1) ctx.lineTo(x0, y0);
    ctx.strokeStyle = color;
    ctx.lineWidth = Math.max(width, 0.5);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }

  private drawLine(tid: number, pts: Point[], color: string, width: number): void {
    this.stroke(this.layer(tid).ctx, pts, color, width);
    this.fills.get(tid)?.push({ pts, color, width });
  }

  // --------------------------------------------------------- animation

  private beginAnimation(cmd: TurtleCmd): Anim | null {
    const op = cmd[0];
    if (op === 'm') {
      const [, tid, x0, y0, x1, y1, ms, down, color, width] = cmd as [string, number, number, number, number, number, number, number, string, number];
      if (!(ms > 0)) return null;
      return this.makeMove(tid, [[x0, y0], [x1, y1]], ms, !!down, color, width, this.cursor(tid).heading);
    }
    if (op === 'p') {
      const [, tid, pts, ms, down, color, width, head] = cmd as [string, number, Point[], number, number, string, number, number];
      if (!(ms > 0) || pts.length < 2) return null;
      return this.makeMove(tid, pts, ms, !!down, color, width, head);
    }
    if (op === 't') {
      const [, tid, h0, h1, ms] = cmd as [string, number, number, number, number];
      if (!(ms > 0)) return null;
      return { kind: 'turn', tid, ms, start: null, pts: [], cumulative: [], total: 0, drawn: 0, down: false, color: '', width: 0, h0, h1 };
    }
    return null;
  }

  private makeMove(tid: number, pts: Point[], ms: number, down: boolean, color: string, width: number, h1: number): Anim {
    const cumulative = [0];
    for (let i = 1; i < pts.length; i++) {
      cumulative.push(cumulative[i - 1]! + Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]));
    }
    return {
      kind: 'move', tid, ms, start: null, pts, cumulative, total: cumulative[cumulative.length - 1]!, drawn: 0,
      down, color, width, h0: this.cursor(tid).heading, h1,
    };
  }

  /** The polyline portion between path lengths [from, to], with interpolated ends. */
  private slice(a: Anim, from: number, to: number): Point[] {
    const out: Point[] = [];
    const at = (len: number): Point => {
      for (let i = 1; i < a.pts.length; i++) {
        if (len <= a.cumulative[i]! || i === a.pts.length - 1) {
          const seg = a.cumulative[i]! - a.cumulative[i - 1]!;
          const t = seg === 0 ? 1 : Math.min(1, Math.max(0, (len - a.cumulative[i - 1]!) / seg));
          const p0 = a.pts[i - 1]!;
          const p1 = a.pts[i]!;
          return [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t];
        }
      }
      return a.pts[a.pts.length - 1]!;
    };
    out.push(at(from));
    for (let i = 1; i < a.pts.length - 1; i++) {
      if (a.cumulative[i]! > from && a.cumulative[i]! < to) out.push(a.pts[i]!);
    }
    out.push(at(to));
    return out;
  }

  private advance(a: Anim, f: number): void {
    const cur = this.cursor(a.tid);
    if (a.kind === 'turn') {
      cur.heading = a.h0 + (a.h1 - a.h0) * f;
      return;
    }
    const target = a.total * f;
    if (a.down && target > a.drawn) {
      this.drawLine(a.tid, this.slice(a, a.drawn, target), a.color, a.width);
    }
    a.drawn = target;
    const [x, y] = this.slice(a, target, target)[0]!;
    cur.x = x;
    cur.y = y;
    cur.heading = a.h0 + (a.h1 - a.h0) * f;
  }

  // ------------------------------------------------------ instant ops

  private applyInstant(cmd: TurtleCmd): void {
    const [op, ...a] = cmd;
    switch (op) {
      case 'setup': {
        this.width = a[0] as number;
        this.height = a[1] as number;
        this.layers.clear(); // surfaces are sized to the window; recreate lazily
        this.hooks.onSetup?.(this.width, this.height);
        break;
      }
      case 'world': this.world = [a[0], a[1], a[2], a[3]] as [number, number, number, number]; break;
      case 'bg': this.bg = a[0] as string; break;
      case 'title': this.hooks.onTitle?.(a[0] as string); break;
      case 'm': {
        const [tid, x0, y0, x1, y1, , down, color, width] = a as [number, number, number, number, number, number, number, string, number];
        if (down) this.drawLine(tid, [[x0, y0], [x1, y1]], color, width);
        const c = this.cursor(tid);
        c.x = x1;
        c.y = y1;
        break;
      }
      case 'p': {
        const [tid, pts, , down, color, width, head] = a as [number, Point[], number, number, string, number, number];
        if (down) this.drawLine(tid, pts, color, width);
        const c = this.cursor(tid);
        const last = pts[pts.length - 1]!;
        c.x = last[0];
        c.y = last[1];
        c.heading = head;
        break;
      }
      case 't': this.cursor(a[0] as number).heading = a[2] as number; break;
      case 'pos': {
        const c = this.cursor(a[0] as number);
        c.x = a[1] as number;
        c.y = a[2] as number;
        c.heading = a[3] as number;
        break;
      }
      case 'dot': {
        const [tid, x, y, size, color] = a as [number, number, number, number, string];
        const ctx = this.layer(tid).ctx;
        const [wx, wy] = this.toWindow(x, y);
        ctx.beginPath();
        ctx.arc(wx, wy, Math.max(size, 1) / 2, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        break;
      }
      case 'w': {
        const [tid, x, y, text, align, family, size, style, color] = a as [number, number, number, string, string, string, number, string, string];
        const ctx = this.layer(tid).ctx;
        const [wx, wy] = this.toWindow(x, y);
        // Tk font sizes are points; canvas wants px (96 dpi => x 1.333).
        ctx.font = `${style === 'normal' ? '' : style + ' '}${Math.round(size * 1.333)}px ${family}, sans-serif`;
        ctx.textAlign = align === 'center' ? 'center' : align === 'right' ? 'right' : 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = color;
        ctx.fillText(text, wx, wy);
        break;
      }
      case 'bf': this.fills.set(a[0] as number, []); break;
      case 'ef': {
        const [tid, color, pts] = a as [number, string, Point[]];
        const recorded = this.fills.get(tid) ?? [];
        this.fills.delete(tid);
        if (pts.length >= 3) {
          const ctx = this.layer(tid).ctx;
          ctx.beginPath();
          const [x0, y0] = this.toWindow(...pts[0]!);
          ctx.moveTo(x0, y0);
          for (let i = 1; i < pts.length; i++) ctx.lineTo(...this.toWindow(...pts[i]!));
          ctx.closePath();
          ctx.fillStyle = color;
          ctx.fill();
          // The fill must sit *under* the outline drawn since begin_fill, as
          // in Tk: put those strokes back on top.
          for (const seg of recorded) this.stroke(ctx, seg.pts, seg.color, seg.width);
        }
        break;
      }
      case 'stamp': {
        const [sid, , x, y, heading, shape, sx, sy, outline, pen, fill] = a as [number, number, number, number, number, string, number, number, number, string, string];
        this.stamps.push({ sid, x, y, heading, shape, sx, sy, outline, pen, fill });
        break;
      }
      case 'unstamp': this.stamps = this.stamps.filter((s) => s.sid !== a[0]); break;
      case 'clear': {
        this.layers.get(a[0] as number)?.clear();
        this.fills.delete(a[0] as number);
        break;
      }
      case 'clearscreen': {
        for (const l of this.layers.values()) l.clear();
        this.layers.clear();
        this.cursors.clear();
        this.stamps = [];
        this.fills.clear();
        this.bg = 'white';
        break;
      }
      case 'shape': this.cursor(a[0] as number).shape = a[1] as string; break;
      case 'color': {
        const c = this.cursor(a[0] as number);
        c.pen = a[1] as string;
        c.fill = a[2] as string;
        break;
      }
      case 'size': {
        const c = this.cursor(a[0] as number);
        c.sx = a[1] as number;
        c.sy = a[2] as number;
        c.outline = a[3] as number;
        break;
      }
      case 'vis': this.cursor(a[0] as number).visible = !!a[1]; break;
      case 'shapedef': this.shapes.set(a[0] as string, a[1] as Point[]); break;
      case 'keys': this.hooks.onKeys?.(a[0] as string[]); break;
      case 'ask': this.hooks.onAsk?.(a[0] as number, a[1] as 'text' | 'num', a[2] as string, a[3] as string); break;
      case 'done': this.hooks.onDone?.(); break;
      case 'bye': this.hooks.onBye?.(); break;
      default: break; // unknown opcodes from a newer Python side are ignored
    }
  }

  // ----------------------------------------------------------- render

  /** Draw the whole picture, scaled to fit a vw x vh canvas. */
  render(ctx: CanvasRenderingContext2D, vw: number, vh: number): void {
    const s = Math.min(vw / this.width, vh / this.height);
    ctx.save();
    ctx.clearRect(0, 0, vw, vh);
    ctx.translate((vw - this.width * s) / 2, (vh - this.height * s) / 2);
    ctx.scale(s, s);
    ctx.fillStyle = this.bg;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.beginPath();
    ctx.rect(0, 0, this.width, this.height);
    ctx.clip();
    for (const layer of this.layers.values()) ctx.drawImage(layer.image, 0, 0, this.width, this.height);
    for (const st of this.stamps) this.drawShape(ctx, st.x, st.y, st.heading, st.shape, st.sx, st.sy, st.outline, st.pen, st.fill);
    for (const c of this.cursors.values()) {
      if (c.visible) this.drawShape(ctx, c.x, c.y, c.heading, c.shape, c.sx, c.sy, c.outline, c.pen, c.fill);
    }
    ctx.restore();
  }

  private drawShape(
    ctx: CanvasRenderingContext2D, x: number, y: number, heading: number, shape: string,
    sx: number, sy: number, outline: number, pen: string, fill: string,
  ): void {
    const poly = this.shapes.get(shape) ?? this.shapes.get('classic')!;
    if (poly.length === 0) return;
    const [cx, cy] = this.toWindow(x, y);
    // Shapes point +y; rotate so +y lines up with the heading (math degrees, CCW).
    const theta = ((heading - 90) * Math.PI) / 180;
    const cos = Math.cos(theta);
    const sin = Math.sin(theta);
    ctx.beginPath();
    poly.forEach(([px, py], i) => {
      const ux = px * sx;
      const uy = py * sy;
      const rx = ux * cos - uy * sin;
      const ry = ux * sin + uy * cos;
      if (i === 0) ctx.moveTo(cx + rx, cy - ry);
      else ctx.lineTo(cx + rx, cy - ry);
    });
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = pen;
    ctx.lineWidth = Math.max(outline, 1);
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}
