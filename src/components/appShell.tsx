import { Show, computed, watch, type Signal } from "xtags";
import type { EditorManager } from "@/editorManager";
import type { Router } from "@/navigation";
import type { FileBrowser } from "./fileBrowser";
import type { SearchPanelElement } from "./searchPanel";
import type { RunPanel } from "./runPanel";
import { icon, type IconName } from "./icons";
import { pushBack } from "./backStack";

export type DrawerTab = "files" | "search";

export interface AppShellOptions {
  editorManager: EditorManager;
  editorHost: HTMLElement;
  fileBrowser: FileBrowser;
  searchPanel: SearchPanelElement;
  tabsBar: HTMLElement;
  quickTools: HTMLElement;
  /** The floating selection menu; placed inside the editor area so it is positioned (and clipped) relative to it. */
  selectionMenu: HTMLElement;
  runPanel: RunPanel;
  router: Router;
  /** Full-screen pages (packages, settings), rendered above the editor. */
  pages: Node[];
  statusLeft: Signal<string>;
  statusRight: Signal<string>;
  /** "Python 3.13.5" etc., shown in the status bar. */
  runtimeLabel: Signal<string>;
  drawerOpen: Signal<boolean>;
  drawerTab: Signal<DrawerTab>;
  menuOpen: Signal<boolean>;
  onRun(): void;
  onStop(): void;
  onSave(): void;
  onNewFile(): void;
  onOpenRepl(): void;
  onCloseFile(): void;
  /** Where the open file lives, shown under its name ("Workspace / src"). */
  describeFile(file: { url: string | null; path: string | null }): string;
}

function RailButton({
  label,
  name,
  active,
  onClick,
}: {
  label: string;
  name: IconName;
  active: () => boolean;
  onClick: () => void;
}): Node {
  return (
    <button
      type="button"
      class={computed(() => ({ "rail-btn": true, active: active() }))}
      title={label}
      aria-label={label}
      aria-pressed={computed(() => String(active()))}
      onClick={onClick}
    >
      {icon(name, 22)}
    </button>
  );
}

/** While `open` is true, Android's Back button should close it (see backStack.ts). */
function closeOnBack(open: Signal<boolean>): void {
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

export function createAppShell(o: AppShellOptions): HTMLElement {
  const {
    editorManager: em,
    drawerOpen,
    drawerTab,
    menuOpen,
    runPanel,
    router,
  } = o;
  closeOnBack(drawerOpen);
  closeOnBack(menuOpen);

  const fileTitle = computed(() => em.activeFile()?.name ?? "PyForge");
  const filePath = computed(() => {
    const f = em.activeFile();
    return f ? o.describeFile(f) : "No file open";
  });
  const dirty = computed(() => em.activeFile()?.dirty() ?? false);
  const running = runPanel.running;
  const hasFile = computed(() => em.activeFile() !== null);

  const MenuItem = ({
    label,
    name,
    action,
    disabled,
  }: {
    label: string;
    name: IconName;
    action: () => void;
    disabled?: () => boolean;
  }): Node => (
    <button
      type="button"
      role="menuitem"
      class="menu-item"
      disabled={disabled ? computed(disabled) : false}
      onClick={() => {
        menuOpen.set(false);
        action();
      }}
    >
      {icon(name, 18)}
      <span>{label}</span>
    </button>
  );

  const titlebar = (
    <header id="titlebar">
      <button
        type="button"
        class="icon-btn"
        title="Files"
        aria-label="Open files drawer"
        onClick={() => drawerOpen.set(true)}
      >
        {icon("menu", 22)}
      </button>
      <div class="title-block">
        <div class="title-line">
          <span id="filename">{fileTitle}</span>
          <span
            class={computed(() => ({ "dirty-dot": true, visible: dirty() }))}
            title="Unsaved changes"
          />
        </div>
        <div id="filepath" class="subtle">
          {filePath}
        </div>
      </div>
      <button
        type="button"
        id="run-btn"
        class={computed(() => ({ "run-btn": true, stop: running() }))}
        disabled={computed(() => !running() && !hasFile())}
        title={computed(() => (running() ? "Stop" : "Run"))}
        aria-label={computed(() =>
          running() ? "Stop program" : "Run program",
        )}
        onClick={() => (running.peek() ? o.onStop() : o.onRun())}
      >
        {computed(() => icon(running() ? "stop" : "play", 22))}
        <span class="run-label">
          {computed(() => (running() ? "Stop" : "Run"))}
        </span>
      </button>
      <button
        type="button"
        class="icon-btn"
        title="More"
        aria-label="More actions"
        aria-haspopup="menu"
        aria-expanded={computed(() => String(menuOpen()))}
        onClick={() => menuOpen.update((v) => !v)}
      >
        {icon("more", 22)}
      </button>
    </header>
  ) as HTMLElement;

  const menu = (
    <div
      id="overflow-menu"
      role="menu"
      class={computed(() => ({ menu: true, open: menuOpen() }))}
    >
      <MenuItem
        label="Save"
        name="save"
        action={o.onSave}
        disabled={() => !hasFile()}
      />
      <MenuItem label="New file" name="filePlus" action={o.onNewFile} />
      <MenuItem label="Python shell" name="terminal" action={o.onOpenRepl} />
      <MenuItem label="Output" name="image" action={() => runPanel.show()} />
      <MenuItem
        label="Packages"
        name="package"
        action={() => router.push("packages")}
      />
      <MenuItem
        label="Close file"
        name="x"
        action={o.onCloseFile}
        disabled={() => !hasFile()}
      />
      <MenuItem
        label="Settings"
        name="settings"
        action={() => router.push("settings")}
      />
    </div>
  ) as HTMLElement;

  const drawer = (
    <aside
      id="drawer"
      class={computed(() => ({ open: drawerOpen() }))}
      aria-hidden={computed(() => String(!drawerOpen()))}
      aria-label="Navigation"
    >
      <div class="drawer-brand">
        <span class="brand-mark">{icon("logo", 22)}</span>
        <strong>PyForge</strong>
        <span class="panel-spacer" />
        <button
          type="button"
          class="icon-btn"
          title="Close"
          aria-label="Close drawer"
          onClick={() => drawerOpen.set(false)}
        >
          {icon("x", 20)}
        </button>
      </div>
      <div class="drawer-body">
        <nav class="rail" aria-label="Sections">
          <RailButton
            label="Files"
            name="folder"
            active={() => drawerTab() === "files"}
            onClick={() => drawerTab.set("files")}
          />
          <RailButton
            label="Search"
            name="search"
            active={() => drawerTab() === "search"}
            onClick={() => {
              drawerTab.set("search");
              o.searchPanel.focusInput();
            }}
          />
          <RailButton
            label="Packages"
            name="package"
            active={() => false}
            onClick={() => {
              drawerOpen.set(false);
              router.push("packages");
            }}
          />
          <span class="panel-spacer" />
          <RailButton
            label="Settings"
            name="settings"
            active={() => false}
            onClick={() => {
              drawerOpen.set(false);
              router.push("settings");
            }}
          />
        </nav>
        <div class="drawer-panels">
          <div
            class={computed(() => ({
              "drawer-panel": true,
              hidden: drawerTab() !== "files",
            }))}
          >
            {o.fileBrowser}
          </div>
          <div
            class={computed(() => ({
              "drawer-panel": true,
              hidden: drawerTab() !== "search",
            }))}
          >
            {o.searchPanel}
          </div>
        </div>
      </div>
    </aside>
  ) as HTMLElement;

  return (
    <div
      id="app"
      class={computed(() => ({
        "sheet-open": runPanel.open(),
        "sheet-expanded": runPanel.expanded(),
      }))}
    >
      {titlebar}
      {o.tabsBar}
      <div class="editor-area">
        {o.editorHost}
        {o.selectionMenu}
        <Show when={() => !hasFile()}>
          <div class="empty-editor">
            <span class="brand-mark big">{icon("logo", 40)}</span>
            <h2>No file open</h2>
            <p>Open a file from the drawer, or start a new one.</p>
            <div class="empty-actions">
              <button
                type="button"
                class="btn btn-primary"
                onClick={o.onNewFile}
              >
                {icon("filePlus", 18)}New file
              </button>
              <button
                type="button"
                class="btn"
                onClick={() => drawerOpen.set(true)}
              >
                {icon("folder", 18)}Browse files
              </button>
            </div>
          </div>
        </Show>
      </div>
      {o.quickTools}
      {runPanel.el}
      <footer id="statusbar">
        <span id="status-left">{o.statusLeft}</span>
        <span class="status-lang">{o.runtimeLabel}</span>
        <span class="panel-spacer" />
        <span id="status-right" role="status">
          {o.statusRight}
        </span>
      </footer>
      <div
        class={computed(() => ({ scrim: true, show: drawerOpen() }))}
        onClick={() => drawerOpen.set(false)}
      />
      <div
        class={computed(() => ({ "menu-scrim": true, show: menuOpen() }))}
        onClick={() => menuOpen.set(false)}
      />
      {drawer}
      {menu}
      {o.pages}
    </div>
  ) as HTMLElement;
}
