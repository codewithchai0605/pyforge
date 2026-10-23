import type { GuiEvent, TurtleCmd } from "@/python/protocol";
import { TurtleScene, type Surface } from "@/python/turtleScene";
import { promptDialog } from "./dialogs";
import { icon } from "./icons";

export interface DisplayCallbacks {
  onGuiEvent(event: GuiEvent): void;
  /** The turtle window gained content (so the panel can switch to this view). */
  onActivity(): void;
}

/** Translate a DOM key event to the Tk keysym names turtle's onkey() expects. */
export function tkKeysym(key: string): string {
  const named: Record<string, string> = {
    ArrowUp: "Up",
    ArrowDown: "Down",
    ArrowLeft: "Left",
    ArrowRight: "Right",
    " ": "space",
    Enter: "Return",
    Escape: "Escape",
    Backspace: "BackSpace",
    Tab: "Tab",
    Delete: "Delete",
    Home: "Home",
    End: "End",
    PageUp: "Prior",
    PageDown: "Next",
  };
  return named[key] ?? key;
}

const KEY_LABELS: Record<string, string> = {
  space: "Space",
  Return: "Enter",
  Escape: "Esc",
  BackSpace: "⌫",
};
const ARROWS = ["Up", "Left", "Down", "Right"];

/**
 * Shows what a program draws: the turtle window, and matplotlib figures.
 * One view, three states: empty, turtle, images.
 */
export class DisplayView {
  readonly el: HTMLElement;
  private readonly stage: HTMLElement;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private readonly caption: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly keypad: HTMLElement;
  private readonly imageBox: HTMLElement;
  private readonly image: HTMLImageElement;
  private readonly pager: HTMLElement;
  private readonly pageLabel: HTMLElement;
  private readonly closeBtn: HTMLButtonElement;

  private scene!: TurtleScene;
  private mode: "empty" | "turtle" | "images" = "empty";
  private images: { url: string; title: string }[] = [];
  private page = 0;
  private cssW = 0;
  private cssH = 0;
  private dpr = 1;
  private dirty = true;
  private ticking = false;
  private active = false;
  private keys: string[] = [];
  private windowClosed = false;
  private readonly onKeyDown = (e: KeyboardEvent): void =>
    this.physicalKey(e, true);
  private readonly onKeyUp = (e: KeyboardEvent): void =>
    this.physicalKey(e, false);

  constructor(private readonly cb: DisplayCallbacks) {
    this.canvas = document.createElement("canvas");
    this.canvas.className = "display-canvas";
    this.canvas.setAttribute("role", "img");
    this.canvas.setAttribute("aria-label", "Turtle graphics window");
    this.ctx = this.canvas.getContext("2d")!;

    this.caption = document.createElement("div");
    this.caption.className = "display-caption";

    this.closeBtn = document.createElement("button");
    this.closeBtn.type = "button";
    this.closeBtn.className = "icon-btn display-close";
    this.closeBtn.title = "Close turtle window";
    this.closeBtn.setAttribute("aria-label", "Close turtle window");
    this.closeBtn.append(icon("x", 18));
    this.closeBtn.addEventListener("click", () => {
      this.cb.onGuiEvent({ k: "close" });
      this.windowClosed = true;
      this.caption.textContent = "Window closed";
      this.closeBtn.hidden = true;
      this.keypad.hidden = true;
    });

    this.keypad = document.createElement("div");
    this.keypad.className = "keypad";
    this.keypad.hidden = true;

    this.stage = document.createElement("div");
    this.stage.className = "display-stage";
    this.stage.append(this.canvas, this.caption, this.closeBtn, this.keypad);
    this.stage.hidden = true;

    this.image = document.createElement("img");
    this.image.className = "display-image";
    this.image.alt = "Plot";
    this.pageLabel = document.createElement("span");
    const prev = this.pagerButton("chevronRight", "Previous figure", -1);
    prev.classList.add("flip");
    const next = this.pagerButton("chevronRight", "Next figure", 1);
    this.pager = document.createElement("div");
    this.pager.className = "pager";
    this.pager.append(prev, this.pageLabel, next);
    this.imageBox = document.createElement("div");
    this.imageBox.className = "display-images";
    this.imageBox.hidden = true;
    this.imageBox.append(this.image, this.pager);

    this.empty = document.createElement("div");
    this.empty.className = "display-empty";
    this.empty.innerHTML =
      "<p><strong>Nothing to show yet</strong></p><p>Turtle drawings and matplotlib plots appear here when your program makes them.</p>";

    this.el = document.createElement("div");
    this.el.className = "display";
    this.el.append(this.empty, this.stage, this.imageBox);

    this.newScene();
    if (typeof ResizeObserver !== "undefined")
      new ResizeObserver(() => this.resize()).observe(this.stage);

    // Pointer: tap = turtle click (in turtle coordinates).
    this.canvas.addEventListener("pointerdown", (e) => {
      if (this.windowClosed) return;
      const r = this.canvas.getBoundingClientRect();
      const p = this.scene.toWorld(
        e.clientX - r.left,
        e.clientY - r.top,
        this.cssW,
        this.cssH,
      );
      this.cb.onGuiEvent({
        k: "click",
        x: Math.round(p.x * 100) / 100,
        y: Math.round(p.y * 100) / 100,
      });
    });
  }

  // ------------------------------------------------------------ public

  get hasContent(): boolean {
    return this.mode !== "empty";
  }

  /** Called when this tab becomes (in)visible: pauses rendering and keyboard capture while hidden. */
  setActive(active: boolean): void {
    this.active = active;
    if (active) {
      document.addEventListener("keydown", this.onKeyDown);
      document.addEventListener("keyup", this.onKeyUp);
      this.resize();
      this.requestRender();
    } else {
      document.removeEventListener("keydown", this.onKeyDown);
      document.removeEventListener("keyup", this.onKeyUp);
    }
  }

  /** Start of a new run: forget the previous picture. */
  reset(): void {
    this.newScene();
    for (const img of this.images)
      if (img.url.startsWith("blob:")) URL.revokeObjectURL(img.url);
    this.images = [];
    this.page = 0;
    this.keys = [];
    this.windowClosed = false;
    this.keypad.hidden = true;
    this.caption.textContent = "";
    this.closeBtn.hidden = false;
    this.setMode("empty");
  }

  handleGui(cmds: TurtleCmd[]): void {
    if (this.mode !== "turtle") {
      this.setMode("turtle");
      this.cb.onActivity();
    }
    this.scene.push(cmds);
    this.requestRender();
  }

  showImage(url: string, title = ""): void {
    this.images.push({ url, title });
    this.page = this.images.length - 1;
    this.setMode("images");
    this.updateImage();
    this.cb.onActivity();
  }

  // ----------------------------------------------------------- scene

  private newScene(): void {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    this.scene = new TurtleScene(
      (w, h): Surface => {
        const c = document.createElement("canvas");
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
        const ctx = c.getContext("2d")!;
        ctx.scale(dpr, dpr);
        return {
          ctx,
          image: c,
          clear: () => {
            ctx.save();
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.clearRect(0, 0, c.width, c.height);
            ctx.restore();
          },
        };
      },
      {
        onTitle: (t) => (this.caption.textContent = t),
        onKeys: (keys) => this.setKeys(keys),
        onAsk: (id, kind, title, prompt) =>
          void this.ask(id, kind, title, prompt),
        onBye: () => {
          this.windowClosed = true;
          this.caption.textContent = "Window closed";
          this.closeBtn.hidden = true;
          this.keypad.hidden = true;
        },
      },
    );
    this.dirty = true;
  }

  private async ask(
    id: number,
    kind: "text" | "num",
    title: string,
    prompt: string,
  ): Promise<void> {
    const value = await promptDialog({
      title: title || (kind === "num" ? "Enter a number" : "Enter text"),
      label: prompt,
      placeholder: kind === "num" ? "number" : "",
      confirmLabel: "OK",
      validate:
        kind === "num"
          ? (v) => (Number.isFinite(Number(v)) ? null : "Enter a number.")
          : undefined,
    });
    this.cb.onGuiEvent({ k: "answer", id, value });
  }

  private resize(): void {
    const rect = this.stage.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    this.dpr = Math.min(2, window.devicePixelRatio || 1);
    this.cssW = rect.width;
    this.cssH = rect.height;
    this.canvas.width = Math.round(rect.width * this.dpr);
    this.canvas.height = Math.round(rect.height * this.dpr);
    this.canvas.style.width = `${rect.width}px`;
    this.canvas.style.height = `${rect.height}px`;
    this.requestRender();
  }

  private requestRender(): void {
    this.dirty = true;
    if (this.ticking) return;
    this.ticking = true;
    requestAnimationFrame(this.tick);
  }

  private readonly tick = (now: number): void => {
    this.ticking = false;
    // Always advance the scene, even when hidden, so animations stay in step with Python's sleeps.
    const changed = this.scene.step(now);
    if ((changed || this.dirty) && this.active && this.cssW > 0) {
      this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      this.scene.render(this.ctx, this.cssW, this.cssH);
      this.dirty = false;
    }
    if (this.scene.busy) this.requestRender();
  };

  // ---------------------------------------------------------- modes

  private setMode(mode: "empty" | "turtle" | "images"): void {
    this.mode = mode;
    this.empty.hidden = mode !== "empty";
    this.stage.hidden = mode !== "turtle";
    this.imageBox.hidden = mode !== "images";
    if (mode === "turtle") this.resize();
  }

  private pagerButton(
    name: "chevronRight",
    title: string,
    delta: number,
  ): HTMLButtonElement {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "icon-btn";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.append(icon(name, 20));
    b.addEventListener("click", () => {
      this.page = Math.min(
        this.images.length - 1,
        Math.max(0, this.page + delta),
      );
      this.updateImage();
    });
    return b;
  }

  private updateImage(): void {
    const current = this.images[this.page];
    if (!current) return;
    this.image.src = current.url;
    this.image.alt = current.title || `Figure ${this.page + 1}`;
    this.pageLabel.textContent = `${current.title ? current.title + " · " : ""}${this.page + 1} / ${this.images.length}`;
    this.pager.hidden = this.images.length < 2 && !current.title;
  }

  // ------------------------------------------------------------ input

  private setKeys(keys: string[]): void {
    this.keys = keys;
    this.keypad.replaceChildren();
    if (keys.length === 0 || this.windowClosed) {
      this.keypad.hidden = true;
      return;
    }
    const press = (key: string, down: boolean): void => {
      this.cb.onGuiEvent({ k: "key", key, down });
    };
    const makeKey = (key: string): HTMLElement => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `key key-${key}`;
      b.textContent =
        { Up: "▲", Down: "▼", Left: "◀", Right: "▶" }[key] ??
        KEY_LABELS[key] ??
        key;
      b.setAttribute("aria-label", `Key ${KEY_LABELS[key] ?? key}`);
      const down = (e: Event): void => {
        e.preventDefault();
        b.classList.add("down");
        press(key, true);
      };
      const up = (e: Event): void => {
        e.preventDefault();
        if (!b.classList.contains("down")) return;
        b.classList.remove("down");
        press(key, false);
      };
      b.addEventListener("pointerdown", down);
      for (const t of ["pointerup", "pointercancel", "pointerleave"] as const)
        b.addEventListener(t, up);
      return b;
    };
    const arrows = ARROWS.filter((k) => keys.includes(k));
    const others = keys.filter((k) => !ARROWS.includes(k)).slice(0, 8);
    if (arrows.length) {
      const pad = document.createElement("div");
      pad.className = "dpad";
      for (const k of ARROWS)
        pad.append(
          arrows.includes(k) ? makeKey(k) : document.createElement("span"),
        );
      this.keypad.append(pad);
    }
    if (others.length) {
      const row = document.createElement("div");
      row.className = "keyrow";
      row.append(...others.map(makeKey));
      this.keypad.append(row);
    }
    this.keypad.hidden = false;
  }

  private physicalKey(e: KeyboardEvent, down: boolean): void {
    if (
      !this.active ||
      this.mode !== "turtle" ||
      this.windowClosed ||
      this.keys.length === 0
    )
      return;
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable)
    )
      return;
    const key = tkKeysym(e.key);
    // OS auto-repeat is forwarded as repeated presses, like Tk does: games
    // rely on holding a key to keep moving.
    e.preventDefault();
    this.cb.onGuiEvent({ k: "key", key, down });
  }
}
