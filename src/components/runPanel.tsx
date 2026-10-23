import { computed, signal, type Signal } from "xtags";
import type { GuiEvent } from "@/python/protocol";
import { ConsoleView } from "./consoleView";
import { DisplayView } from "./displayView";
import { icon } from "./icons";
import { pushBack } from "./backStack";

export type RunStatus =
  | { kind: "idle"; text: string }
  | { kind: "running"; text: string }
  | { kind: "ok" | "error"; text: string };

export interface RunPanelOptions {
  onInput(text: string | null): void;
  onGuiEvent(event: GuiEvent): void;
  onJump(path: string, line: number): void;
  onStop(): void;
  /** Re-run the last program (the ↻ button after it finished). */
  onRerun(): void;
}

export interface RunPanel {
  readonly el: HTMLElement;
  readonly console: ConsoleView;
  readonly display: DisplayView;
  readonly open: Signal<boolean>;
  readonly expanded: Signal<boolean>;
  readonly tab: Signal<"console" | "display">;
  readonly status: Signal<RunStatus>;
  readonly running: Signal<boolean>;
  show(tab?: "console" | "display"): void;
  hide(): void;
  /** Prepare for a new run: reset the display, optionally clear the console, open the sheet on the console. */
  beginRun(clearConsole: boolean): void;
}

const MIN_HEIGHT = 140;

/**
 * The bottom sheet that shows a program's output. It slides up when you tap
 * Run, can be dragged taller/shorter, expanded to full screen, and dismissed
 * without stopping the program.
 */
export function createRunPanel(options: RunPanelOptions): RunPanel {
  const open = signal(false);
  const expanded = signal(false);
  const tab = signal<"console" | "display">("console");
  const status = signal<RunStatus>({ kind: "idle", text: "Ready" });
  const running = computed(() => status().kind === "running");
  const displayBadge = signal(false);

  const consoleView = new ConsoleView({
    onInput: options.onInput,
    onJump: options.onJump,
  });
  const display = new DisplayView({
    onGuiEvent: options.onGuiEvent,
    onActivity: () => {
      // First turtle/plot output of a run: bring it forward, since that's
      // what the user is waiting to see. They can switch back to the console.
      if (tab.peek() !== "display" && !userPickedTab) setTab("display");
      else if (tab.peek() !== "display") displayBadge.set(true);
    },
  });
  let userPickedTab = false;
  let releaseBack = (): void => {};

  const setTab = (next: "console" | "display"): void => {
    tab.set(next);
    display.setActive(next === "display" && open.peek());
    if (next === "display") displayBadge.set(false);
  };
  const pickTab = (next: "console" | "display"): void => {
    userPickedTab = true;
    setTab(next);
  };

  const body = (
    <div class="sheet-body">
      <div
        class={computed(() => ({ pane: true, hidden: tab() !== "console" }))}
      >
        {consoleView.el}
      </div>
      <div
        class={computed(() => ({ pane: true, hidden: tab() !== "display" }))}
      >
        {display.el}
      </div>
    </div>
  ) as HTMLElement;

  const el = (
    <section
      id="run-panel"
      class={computed(() => ({
        "run-panel": true,
        open: open(),
        expanded: expanded(),
      }))}
      aria-hidden={computed(() => String(!open()))}
      aria-label="Program output"
    >
      <div
        class="sheet-handle"
        role="separator"
        aria-label="Drag to resize output"
        aria-orientation="horizontal"
      >
        <span class="grip" />
      </div>
      <div class="sheet-header">
        <div class="seg" role="tablist">
          <button
            type="button"
            role="tab"
            class={computed(() => ({
              "seg-btn": true,
              on: tab() === "console",
            }))}
            aria-selected={computed(() => String(tab() === "console"))}
            onClick={() => pickTab("console")}
          >
            {icon("terminal", 16)}Console
          </button>
          <button
            type="button"
            role="tab"
            class={computed(() => ({
              "seg-btn": true,
              on: tab() === "display",
            }))}
            aria-selected={computed(() => String(tab() === "display"))}
            onClick={() => pickTab("display")}
          >
            {icon("image", 16)}Display
            <span
              class={computed(() => ({ badge: true, visible: displayBadge() }))}
            />
          </button>
        </div>
        <span
          class={computed(() => `status-chip status-${status().kind}`)}
          role="status"
        >
          {computed(() => status().text)}
        </span>
        <span class="panel-spacer" />
        <button
          type="button"
          class={computed(() => ({
            "icon-btn": true,
            danger: true,
            hidden: !running(),
          }))}
          title="Stop"
          aria-label="Stop program"
          onClick={options.onStop}
        >
          {icon("stop", 18)}
        </button>
        <button
          type="button"
          class={computed(() => ({ "icon-btn": true, hidden: running() }))}
          title="Run again"
          aria-label="Run again"
          onClick={options.onRerun}
        >
          {icon("refresh", 18)}
        </button>
        <button
          type="button"
          class="icon-btn"
          title="Clear console"
          aria-label="Clear console"
          onClick={() => consoleView.clear()}
        >
          {icon("clear", 18)}
        </button>
        <button
          type="button"
          class="icon-btn"
          title={computed(() => (expanded() ? "Shrink" : "Expand"))}
          aria-label="Expand or shrink output"
          onClick={() => expanded.update((v) => !v)}
        >
          {computed(() => icon(expanded() ? "collapse" : "expand", 18))}
        </button>
        <button
          type="button"
          class="icon-btn"
          title="Close output"
          aria-label="Close output"
          onClick={() => hide()}
        >
          {icon("chevronDown", 20)}
        </button>
      </div>
      {body}
    </section>
  ) as HTMLElement;

  // Drag the handle to resize.
  const handle = el.querySelector<HTMLElement>(".sheet-handle")!;
  handle.addEventListener("pointerdown", (e) => {
    const startY = e.clientY;
    const startH = el.getBoundingClientRect().height;
    const max =
      (el.parentElement?.getBoundingClientRect().height ?? window.innerHeight) -
      96;
    handle.setPointerCapture(e.pointerId);
    expanded.set(false);
    const move = (ev: PointerEvent): void => {
      const next = Math.min(
        Math.max(startH + (startY - ev.clientY), MIN_HEIGHT),
        max,
      );
      el.style.setProperty("--sheet-h", `${next}px`);
      display.setActive(tab.peek() === "display" && open.peek());
    };
    const up = (): void => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });

  function show(next?: "console" | "display"): void {
    if (next) pickTab(next);
    if (!open.peek()) {
      open.set(true);
      releaseBack = pushBack(() => hide());
      display.setActive(tab.peek() === "display");
    }
  }
  function hide(): void {
    if (!open.peek()) return;
    open.set(false);
    expanded.set(false);
    releaseBack();
    display.setActive(false);
  }

  function beginRun(clearConsole: boolean): void {
    // A new run lets output auto-switch to the Display tab again.
    userPickedTab = false;
    displayBadge.set(false);
    if (clearConsole) consoleView.clear();
    display.reset();
    setTab("console");
    show();
  }

  return {
    el,
    console: consoleView,
    display,
    open,
    expanded,
    tab,
    status,
    running,
    show,
    hide,
    beginRun,
  };
}
