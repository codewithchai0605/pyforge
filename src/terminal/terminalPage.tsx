import { For, computed, signal, watch } from "xtags";
import { pushBack } from "@/components/backStack";
import { icon, type IconName } from "@/components/icons";
import { Page } from "@/components/page";
import type { Router } from "@/navigation";
import type { Settings } from "@/settings";
import { createKeyBar } from "./keyBar";
import type { ShellTab, TerminalManager } from "./sessions";

/**
 * The Terminal page: a real shell, in tabs.
 *
 *   tab strip      one chip per shell (+ to open another, x to close)
 *   search bar     find text in the scrollback (header search button)
 *   terminal       xterm.js, with long-press selection and a Copy/Paste bar
 *   key bar        Esc / Tab / sticky Ctrl+Alt / arrows / | / ~ ...
 *   menu           Copy, Select all, Clear, text size, Restart, Close
 *
 * The shells belong to the TerminalManager, not to this page, so going Back
 * leaves them running and coming back finds them as they were.
 */

export interface TerminalPageOptions {
  router: Router;
  manager: TerminalManager;
  settings: Settings;
}

const FONT_MIN = 8;
const FONT_MAX = 24;

const SEARCH_DECORATIONS = {
  matchBackground: "#5a4a1a",
  matchBorder: "#b98f1d",
  matchOverviewRuler: "#b98f1d",
  activeMatchBackground: "#8a6a10",
  activeMatchBorder: "#ffcf4a",
  activeMatchColorOverviewRuler: "#ffcf4a",
};

export function createTerminalPage(o: TerminalPageOptions): Node {
  const { router, manager, settings } = o;
  const menuOpen = signal(false);
  const searchOpen = signal(false);
  const query = signal("");
  const available = manager.backend.available;

  const activeView = (): ShellTab["view"] | null =>
    manager.active.peek()?.view ?? null;

  // Android's Back closes the menu / search before it leaves the page.
  for (const open of [menuOpen, searchOpen]) {
    let release = (): void => {};
    watch(
      () => open(),
      (isOpen) => {
        release();
        release = isOpen ? pushBack(() => open.set(false)) : (): void => {};
      },
      { defer: true },
    );
  }

  // A shell is opened the first time the page is shown, not at app start.
  watch(
    () => router.stack().includes("terminal"),
    (isOpen) => {
      if (isOpen) {
        manager.ensureOne();
        // Wait for the slide-in; focusing earlier makes the keyboard jump.
        setTimeout(() => activeView()?.focus(), 280);
      } else {
        menuOpen.set(false);
        searchOpen.set(false);
        activeView()?.blur();
      }
    },
  );

  // Font size / renderer changes from Settings.
  watch(
    () => [settings.terminalFontSize(), settings.terminalWebgl()] as const,
    () => manager.applyAppearance(),
    { defer: true },
  );

  // ----------------------------------------------------------------- search

  const find = (direction: "next" | "previous", incremental = false): void => {
    const view = activeView();
    const q = query.peek();
    if (!view) return;
    if (!q) {
      view.search.clearDecorations();
      return;
    }
    const opts = { decorations: SEARCH_DECORATIONS, incremental };
    if (direction === "next") view.search.findNext(q, opts);
    else view.search.findPrevious(q, opts);
  };

  watch(
    () => searchOpen(),
    (isOpen) => {
      if (!isOpen) {
        activeView()?.search.clearDecorations();
        activeView()?.focus();
      }
    },
    { defer: true },
  );

  const searchInput = (
    <input
      type="search"
      class="term-search-input"
      placeholder="Find in output"
      autocomplete="off"
      autocapitalize="off"
      spellcheck={false}
      aria-label="Find in terminal output"
      onInput={(e: Event) => {
        query.set((e.target as HTMLInputElement).value);
        find("next", true);
      }}
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          find(e.shiftKey ? "previous" : "next");
        }
      }}
    />
  ) as HTMLInputElement;

  const toggleSearch = (): void => {
    menuOpen.set(false);
    searchOpen.update((v) => !v);
    if (searchOpen.peek()) setTimeout(() => searchInput.focus(), 0);
  };

  // ------------------------------------------------------------------ menu

  const withActive = (run: (view: ShellTab["view"]) => void) => (): void => {
    menuOpen.set(false);
    const view = activeView();
    if (view) run(view);
  };

  const resize = (delta: number) =>
    withActive(() =>
      settings.terminalFontSize.set(
        Math.min(
          FONT_MAX,
          Math.max(FONT_MIN, settings.terminalFontSize.peek() + delta),
        ),
      ),
    );

  const MenuItem = (
    label: string,
    name: IconName,
    action: () => void,
  ): HTMLElement =>
    (
      <button type="button" class="menu-item" role="menuitem" onClick={action}>
        {icon(name, 20)}
        <span>{label}</span>
      </button>
    ) as HTMLElement;

  const menu = (
    <div
      class={computed(() => ({ "term-menu": true, open: menuOpen() }))}
      role="menu"
    >
      {MenuItem(
        "Copy",
        "copy",
        withActive((v) => void v.copy()),
      )}
      {MenuItem(
        "Select all",
        "selectAll",
        withActive((v) => v.selectAll()),
      )}
      {MenuItem(
        "Clear screen",
        "clear",
        withActive((v) => v.clear()),
      )}
      {MenuItem("Bigger text", "plus", resize(1))}
      {MenuItem("Smaller text", "chevronDown", resize(-1))}
      {MenuItem(
        "Restart shell",
        "refresh",
        withActive(() => {
          const tab = manager.active.peek();
          if (tab) manager.restart(tab);
        }),
      )}
      {MenuItem(
        "Close shell",
        "x",
        withActive(() => {
          const tab = manager.active.peek();
          if (tab) manager.close(tab.id);
        }),
      )}
    </div>
  ) as HTMLElement;

  // ----------------------------------------------------------------- header

  const headerButton = (
    name: IconName,
    title: string,
    onClick: () => void,
    pressed?: () => boolean,
  ): HTMLElement =>
    (
      <button
        type="button"
        class="icon-btn"
        title={title}
        aria-label={title}
        aria-pressed={pressed ? computed(() => String(pressed())) : undefined}
        disabled={!available}
        onClick={onClick}
      >
        {icon(name, 22)}
      </button>
    ) as HTMLElement;

  const actions = (
    <>
      {headerButton("search", "Search", toggleSearch, searchOpen)}
      {headerButton("paste", "Paste", () => void activeView()?.paste())}
      {headerButton("more", "More", () => menuOpen.update((v) => !v), menuOpen)}
    </>
  );

  // ------------------------------------------------------------------- tabs

  const Tab = (tab: ShellTab): Node => (
    <div
      role="tab"
      tabindex={0}
      class={computed(() => ({
        "term-tab": true,
        active: manager.active() === tab,
        exited: tab.status() === "exited",
      }))}
      aria-selected={computed(() => String(manager.active() === tab))}
      onClick={() => manager.select(tab.id)}
    >
      <span class="term-tab-title">{tab.title}</span>
      <button
        type="button"
        class="tab-close"
        title="Close shell"
        aria-label={computed(() => `Close ${tab.title()}`)}
        onClick={(e: Event) => {
          e.stopPropagation();
          manager.close(tab.id);
        }}
      >
        {icon("x", 14)}
      </button>
    </div>
  );

  const tabStrip = (
    <div class="term-tabs" role="tablist" aria-label="Shells">
      <For each={manager.tabs} key={(t: ShellTab) => t.id}>
        {(tab: ShellTab) => Tab(tab)}
      </For>
      <button
        type="button"
        class="term-tab-new"
        title="New shell"
        aria-label="New shell"
        disabled={!available}
        onClick={() => {
          manager.create();
        }}
      >
        {icon("plus", 18)}
      </button>
    </div>
  );

  const searchBar = (
    <div class={computed(() => ({ "term-search": true, open: searchOpen() }))}>
      {searchInput}
      <button
        type="button"
        class="icon-btn"
        title="Previous match"
        aria-label="Previous match"
        onClick={() => find("previous")}
      >
        {icon("chevronUp", 20)}
      </button>
      <button
        type="button"
        class="icon-btn"
        title="Next match"
        aria-label="Next match"
        onClick={() => find("next")}
      >
        {icon("chevronDown", 20)}
      </button>
      <button
        type="button"
        class="icon-btn"
        title="Close search"
        aria-label="Close search"
        onClick={() => searchOpen.set(false)}
      >
        {icon("x", 20)}
      </button>
    </div>
  );

  // ------------------------------------------------------------------ panes

  const Pane = (tab: ShellTab): Node => {
    const keys = createKeyBar({
      layout: "full",
      modifiers: tab.view.modifiers,
      send: (data) => tab.view.send(data),
      applicationCursor: () => tab.view.applicationCursor,
      onPaste: () => void tab.view.paste(),
    });
    return (
      <div
        class={computed(() => ({
          "term-pane": true,
          hidden: manager.active() !== tab,
        }))}
      >
        {tab.view.el}
        {keys}
      </div>
    );
  };

  const unavailable = (
    <div class="term-unavailable">
      {icon("terminal", 40)}
      <h2>Terminal not available</h2>
      <p>{manager.backend.reason ?? "No shell can be started here."}</p>
    </div>
  );

  return (
    <Page
      route="terminal"
      router={router}
      title="Terminal"
      actions={actions}
      flush
    >
      <div class="term-page" onPointerDown={() => menuOpen.set(false)}>
        {menu}
        {available ? (
          <>
            {tabStrip}
            {searchBar}
            <div class="term-stage">
              <For each={manager.tabs} key={(t: ShellTab) => t.id}>
                {(tab: ShellTab) => Pane(tab)}
              </For>
            </div>
          </>
        ) : (
          unavailable
        )}
      </div>
    </Page>
  );
}
