import { signal, watch } from "xtags";
import { EditorManager } from "@/editorManager";
import { fsOperation } from "@/fileSystem";
import { createRuntime } from "@/native/pyruntime";
import type {
  GuiEvent,
  PyEvent,
  RunHandle,
  RuntimeInfo,
} from "@/python/protocol";
import { setClipboardNotifier } from "@/editor/clipboard";
import { keyModifiers } from "@/editor/modifiers";
import { attachPinchZoom } from "@/editor/pinchZoom";
import { openExternal, suppressSystemSelectionBar } from "@/native/device";
import { createTerminalBackend } from "@/native/terminal";
import { createTerminalConsole } from "@/terminal/createConsole";
import { TerminalManager } from "@/terminal/sessions";
import { createTerminalPage } from "@/terminal/terminalPage";
import { createRouter } from "@/navigation";
import { createSettings, loadSession, saveSession } from "@/settings";
import { createWorkspace } from "@/workspace";
import { createAppShell, type DrawerTab } from "@/components/appShell";
import { dispatchBack, setRootBackHandler } from "@/components/backStack";
import { choiceDialog, confirmDialog } from "@/components/dialogs";
import { createFileBrowser } from "@/components/fileBrowser";
import { PackagesPage } from "@/components/packagesPage";
import { createQuickTools } from "@/components/quickTools";
import { ConsoleSwitch } from "@/components/consoleSwitch";
import { createRunPanel } from "@/components/runPanel";
import {
  createSelectionMenu,
  registerDefaultSelectionItems,
} from "@/components/selectionMenu";
import { createSearchPanel } from "@/components/searchPanel";
import { SettingsPage } from "@/components/settingsPage";
import { createTabsBar } from "@/components/tabsBar";
import { toast } from "@/components/toast";

const errorMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

async function start(): Promise<void> {
  const settings = createSettings();
  const statusLeft = signal("Ln 1, Col 1");
  const statusRight = signal("");
  const drawerOpen = signal(false);
  const drawerTab = signal<DrawerTab>("files");
  const menuOpen = signal(false);
  const router = createRouter();

  // ---- Python runtime + workspace ---------------------------------------
  const readBase64 = (path: string): Promise<string> =>
    fsOperation(`file://${encodeURI(path)}`).readFile("base64");
  const runtime = await createRuntime(readBase64);
  let info: RuntimeInfo | null = null;
  try {
    info = await runtime.init();
  } catch {
    /* "none" backend, or Python failed to start: Run reports the reason */
  }
  // The page must pad for system bars only where the WebView isn't already
  // inset from them; the native side measures that (env(safe-area-inset-*)
  // would double-count and leave a blank band under the status bar).
  const applyInsets = async (): Promise<void> => {
    const insets = await runtime.insets();
    const root = document.documentElement.style;
    for (const side of ["top", "bottom", "left", "right"] as const) {
      root.setProperty(
        `--inset-${side}`,
        `${Math.round((insets?.[side] ?? 0) * 100) / 100}px`,
      );
    }
  };
  await applyInsets();
  let insetTimer: ReturnType<typeof setTimeout> | undefined;
  window.addEventListener("resize", () => {
    clearTimeout(insetTimer);
    insetTimer = setTimeout(() => void applyInsets(), 250);
  });
  const workspace = await createWorkspace(runtime, info);
  const runtimeLabel = signal(
    info
      ? `Python ${info.python}`
      : runtime.kind === "none"
        ? "Python unavailable"
        : "Python",
  );

  // ---- editor --------------------------------------------------------------
  // Built as a plain element first so EditorManager can mount CodeMirror into
  // it before the shell (which will contain it) exists.
  const editorHost = document.createElement("main");
  editorHost.id = "editor-host";
  const editorManager = new EditorManager(editorHost);
  editorManager.onUpdate(() => {
    const head = editorManager.editor.state.selection.main.head;
    const line = editorManager.editor.state.doc.lineAt(head);
    statusLeft.set(
      editorManager.activeFile.peek()
        ? `Ln ${line.number}, Col ${head - line.from + 1}`
        : "",
    );
  });

  // The menu that replaces Android's own Cut/Copy/Paste bar. Everything on it, built-ins included, goes through
  // `selectionMenu.add(...)` / `.remove(id)`; it is also on `window.pyforge` for DevTools.
  setClipboardNotifier((message, kind) => toast(message, kind));
  const selectionMenu = createSelectionMenu({
    editorManager,
    systemBar: suppressSystemSelectionBar,
  });
  registerDefaultSelectionItems(selectionMenu);

  watch(
    () => settings.fontSize(),
    (size) =>
      document.documentElement.style.setProperty(
        "--editor-font-size",
        `${size}px`,
      ),
  );
  attachPinchZoom(editorHost, {
    getSize: () => settings.fontSize.peek(),
    setSize: (n) => settings.fontSize.set(n),
  });

  // Auto-save: a moment after typing stops. (Run, pause and exit also save.)
  let autosaveTimer: ReturnType<typeof setTimeout> | undefined;
  editorManager.onUpdate(() => {
    if (!settings.autoSave.peek()) return;
    clearTimeout(autosaveTimer);
    autosaveTimer = setTimeout(() => void editorManager.saveAll(), 1500);
  });

  const openFile = async (
    url: string,
    name: string,
    path: string | null = null,
  ): Promise<void> => {
    try {
      await editorManager.openFile(
        url,
        name,
        path ?? workspace.relativePath(url),
      );
      drawerOpen.set(false);
      editorManager.editor.focus();
    } catch (error) {
      toast(`Could not open ${name}: ${errorMessage(error)}`, "error");
    }
  };

  // ---- running code ----------------------------------------------------------
  let handle: RunHandle | null = null;
  let lastRun: "file" | "repl" = "file";

  const runPanel = createRunPanel({
    onInput: (text) => handle?.stdin(text),
    onGuiEvent: (event: GuiEvent) => handle?.gui(event),
    onJump: (path, line) => void jumpToTraceback(path, line),
    onStop: () => void stop(),
    onRerun: () => void (lastRun === "repl" ? openRepl() : runActive()),
    // The console is a terminal (xterm.js) or the classic DOM console, per
    // Settings, switchable live. If xterm.js can't start in this WebView the
    // classic console stays.
    createConsole: (callbacks) => {
      const sw = new ConsoleSwitch({
        callbacks,
        createTerminal: (cb) =>
          createTerminalConsole(cb, {
            settings,
            notify: (message, kind) => toast(message, kind),
          }),
        onFallback: () =>
          toast(
            "The terminal-style console can’t start on this device; using the classic console.",
            "info",
          ),
      });
      watch(
        () => settings.terminalConsole(),
        (on) => sw.use(on ? "terminal" : "classic"),
      );
      watch(
        () => [settings.terminalFontSize(), settings.terminalWebgl()] as const,
        () => sw.applyAppearance(),
        { defer: true },
      );
      return sw;
    },
  });

  async function jumpToTraceback(path: string, line: number): Promise<void> {
    const url = workspace.urlForPythonPath(path);
    if (!url) {
      toast("That file isn’t in your workspace.", "info");
      return;
    }
    await openFile(url, url.slice(url.lastIndexOf("/") + 1));
    runPanel.hide();
    editorManager.goToLine(line);
  }

  const onEvent = (ev: PyEvent): void => {
    const c = runPanel.console;
    switch (ev.t) {
      case "out":
        c.write("out", ev.s);
        break;
      case "err":
        c.write("err", ev.s);
        break;
      case "input":
        c.showInput(ev.prompt);
        break;
      case "gui":
        runPanel.display.handleGui(ev.cmds);
        break;
      case "img":
        void runtime
          .imageUrl(ev.path)
          .then((url) => runPanel.display.showImage(url, ev.title))
          .catch((e) =>
            c.system(`Could not load plot: ${errorMessage(e)}`, "error"),
          );
        break;
      default:
        break;
    }
  };

  function begin(title: string): void {
    runPanel.beginRun(settings.clearConsoleOnRun.peek());
    runPanel.console.system(title, "info");
    runPanel.status.set({ kind: "running", text: "Running…" });
  }

  function attach(h: RunHandle): void {
    handle = h;
    void h.done.then((exit) => {
      if (handle !== h) return; // a newer run has replaced this one
      handle = null;
      runPanel.console.finish();
      const secs = (exit.ms / 1000).toFixed(exit.ms < 10000 ? 2 : 1);
      if (exit.code === 0) {
        runPanel.console.system(`Finished in ${secs}s`, "ok");
        runPanel.status.set({ kind: "ok", text: `Finished · ${secs}s` });
      } else if (exit.code === 137) {
        runPanel.console.system("Stopped", "info");
        runPanel.status.set({ kind: "idle", text: "Stopped" });
      } else {
        runPanel.console.system(`Exited with code ${exit.code}`, "error");
        runPanel.status.set({ kind: "error", text: `Exit code ${exit.code}` });
      }
    });
  }

  async function stop(): Promise<void> {
    await handle?.stop();
  }

  async function runActive(): Promise<void> {
    const file = editorManager.activeFile.peek();
    if (!file) return;
    await stop();
    if (settings.saveOnRun.peek()) {
      const { failed } = await editorManager.saveAll();
      if (failed.length) toast(`Could not save ${failed.join(", ")}`, "error");
    }
    lastRun = "file";
    begin(`▶ ${file.name}`);
    attach(
      runtime.run(
        workspace.buildRunRequest(
          file.url,
          file.name,
          editorManager.getValue(),
        ),
        onEvent,
      ),
    );
  }

  async function openRepl(): Promise<void> {
    await stop();
    lastRun = "repl";
    begin("Python shell");
    attach(
      runtime.run(
        { mode: "repl", ...(workspace.kind === "dev" ? { cwd: "" } : {}) },
        onEvent,
      ),
    );
  }

  // ---- files -----------------------------------------------------------------
  const fileBrowser = createFileBrowser({
    workspaceUrl: workspace.rootUrl,
    onOpenFile: openFile,
    onDeleted: (url) => editorManager.closeByUrl(url),
    onRenamed: (url) => editorManager.closeByUrl(url),
    setStatus: (message) => statusRight.set(message),
  });
  const searchPanel = createSearchPanel({
    getRootUrl: () => fileBrowser.getRootUrl(),
    onOpenMatch: (url, name, line) =>
      void openFile(url, name).then(() => editorManager.goToLine(line)),
  });

  const save = async (): Promise<void> => {
    try {
      const saved = await editorManager.save();
      toast(
        saved ? "Saved" : "This file has nowhere to be saved yet.",
        saved ? "success" : "info",
        1400,
      );
    } catch (error) {
      toast(`Could not save: ${errorMessage(error)}`, "error");
    }
  };

  const closeActiveFile = async (): Promise<void> => {
    const file = editorManager.activeFile.peek();
    if (!file) return;
    if (file.dirty.peek()) {
      const discard = await confirmDialog({
        title: "Close without saving?",
        message: `“${file.name}” has unsaved changes.`,
        confirmLabel: "Discard",
        danger: true,
      });
      if (!discard) return;
    }
    editorManager.closeFile(file.id);
  };

  // Shells live in the manager, so leaving the Terminal page keeps them running.
  const terminals = new TerminalManager({
    backend: createTerminalBackend(runtime.kind),
    settings,
    notify: (message, kind) => toast(message, kind),
    openUrl: openExternal,
    cwd: info?.projects,
    onTraceback: (path, line) => {
      router.home();
      void jumpToTraceback(path, line);
    },
  });

  const pages: Node[] = [
    PackagesPage({ router, runtime, info }),
    createTerminalPage({ router, manager: terminals, settings }),
    SettingsPage({ router, settings, info }),
  ];

  // ---- leaving the app ---------------------------------------------------------
  /** Back on Home: confirm, handle unsaved files, stop anything running, then exit. */
  async function requestExit(): Promise<void> {
    const unsaved = editorManager.activeFiles
      .peek()
      .filter((f) => f.dirty.peek());
    const busy = runPanel.running.peek();
    const note = busy ? " A running program will be stopped." : "";

    if (unsaved.length > 0) {
      const names = unsaved.map((f) => f.name);
      const shown =
        names.length > 3
          ? `${names.slice(0, 3).join(", ")} and ${names.length - 3} more`
          : names.join(", ");
      const choice = await choiceDialog<"save" | "discard">({
        title: "Unsaved changes",
        message: `${shown} ${names.length === 1 ? "has" : "have"} unsaved changes.${note}`,
        choices: [
          { label: "Save and exit", value: "save", kind: "primary" },
          { label: "Discard and exit", value: "discard", kind: "danger" },
          { label: "Stay", value: undefined as never },
        ],
      });
      if (!choice) return;
      if (choice === "save") {
        const { failed } = await editorManager.saveAll();
        if (failed.length) {
          toast(`Could not save ${failed.join(", ")}. Not exiting.`, "error");
          return;
        }
      }
    } else if (settings.confirmOnExit.peek()) {
      const ok = await confirmDialog({
        title: "Exit PyForge?",
        message: `Press Exit to close the app.${note}`,
        confirmLabel: "Exit",
      });
      if (!ok) return;
    }

    await stop();
    terminals.closeAll(); // hang up the shells instead of leaving them to be killed
    const app = (navigator as Navigator & { app?: { exitApp(): void } }).app;
    if (app) app.exitApp();
    else toast("Exit is only available in the Android app.", "info");
  }

  // The whole Back chain: dialog → sheet/drawer/menu → page → Home → exit.
  setRootBackHandler(() => {
    if (!router.pop()) void requestExit();
  });

  // ---- assemble ----------------------------------------------------------------
  const app = createAppShell({
    editorManager,
    editorHost,
    fileBrowser,
    searchPanel,
    tabsBar: createTabsBar(editorManager),
    quickTools: createQuickTools(editorManager),
    selectionMenu: selectionMenu.el,
    runPanel,
    router,
    pages,
    statusLeft,
    statusRight,
    runtimeLabel,
    drawerOpen,
    drawerTab,
    menuOpen,
    onRun: () => void runActive(),
    onStop: () => void stop(),
    onSave: () => void save(),
    onNewFile: () => void fileBrowser.createFile(),
    onOpenRepl: () => void openRepl(),
    onCloseFile: () => void closeActiveFile(),
    describeFile: (file) => {
      const rel = file.url ? workspace.relativePath(file.url) : null;
      if (rel !== null) {
        const dir = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/")) : "";
        return dir ? `Workspace / ${dir.split("/").join(" / ")}` : "Workspace";
      }
      return file.url
        ? `External folder${file.path ? ` · ${file.path}` : ""}`
        : "Not saved yet";
    },
  });
  document.getElementById("root")?.appendChild(app);

  // Transient status messages fade after a few seconds.
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  watch(
    () => statusRight(),
    (message) => {
      clearTimeout(statusTimer);
      if (message) statusTimer = setTimeout(() => statusRight.set(""), 5000);
    },
  );

  // ---- restore the previous session -------------------------------------------
  const session = loadSession();
  for (const f of session.files) {
    try {
      if (await fsOperation(f.url).exists())
        await editorManager.openFile(f.url, f.name, f.path);
    } catch {
      /* file vanished or its folder grant was revoked: just don't reopen it */
    }
  }
  const wanted = editorManager.activeFiles
    .peek()
    .find((f) => f.url === session.active);
  if (wanted) editorManager.switchTo(wanted.id);
  if (editorManager.activeFiles.peek().length === 0) {
    const entries = await fsOperation(workspace.rootUrl)
      .listDir()
      .catch(() => []);
    const first = entries
      .filter((e) => !e.isDirectory && e.name.endsWith(".py"))
      .sort((a, b) => a.name.localeCompare(b.name))[0];
    if (first) await openFile(first.url, first.name);
  }

  watch(
    () => ({
      files: editorManager.activeFiles(),
      active: editorManager.activeFile(),
    }),
    ({ files, active }) =>
      saveSession({
        files: files.flatMap((f) =>
          f.url ? [{ url: f.url, name: f.name, path: f.path }] : [],
        ),
        active: active?.url ?? null,
      }),
    { defer: true },
  );

  // ---- lifecycle ----------------------------------------------------------------
  // Android can kill a backgrounded app at any time: write changes out first.
  const flush = (): void => void editorManager.saveAll();
  document.addEventListener("pause", flush);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flush();
  });

  document.addEventListener("backbutton", dispatchBack);
  document.addEventListener("keydown", (e) => {
    // Desktop preview: Esc plays the role of Back.
    if (e.key === "Escape" && !e.defaultPrevented) dispatchBack();
    // Ctrl/Cmd+Enter runs/stops, Ctrl/Cmd+S saves (desktop preview, Bluetooth keyboards).
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === "Enter") {
      e.preventDefault();
      void (runPanel.running.peek() ? stop() : runActive());
    } else if (e.key === "s") {
      e.preventDefault();
      void save();
    }
  });

  // A handle for DevTools and the automated UI smoke test (utils/scripts/smoke-test.ts).
  Object.assign(window, {
    pyforge: {
      editorManager,
      runPanel,
      workspace,
      runtime,
      router,
      selectionMenu,
      keyModifiers,
      settings,
      terminals,
    },
  });

  if (editorManager.activeFile.peek()) editorManager.editor.focus();
}

if (typeof window.cordova !== "undefined") {
  document.addEventListener("deviceready", () => void start(), { once: true });
} else if (document.readyState === "loading") {
  // boot.js injects this script after the page has parsed, so DOMContentLoaded
  // may already have fired; readyState tells us which case we're in.
  document.addEventListener("DOMContentLoaded", () => void start(), {
    once: true,
  });
} else {
  void start();
}