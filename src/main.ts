import { signal, watch } from 'xtags';
import { EditorManager } from '@/editorManager';
import { fsOperation } from '@/fileSystem';
import { createRuntime } from '@/native/pyruntime';
import type { GuiEvent, PyEvent, RunHandle, RuntimeInfo } from '@/python/protocol';
import { createSettings, loadSession, saveSession } from '@/settings';
import { createWorkspace } from '@/workspace';
import { createAppShell, type DrawerTab } from '@/components/appShell';
import { handleBack } from '@/components/backStack';
import { confirmDialog } from '@/components/dialogs';
import { createFileBrowser } from '@/components/fileBrowser';
import { createPackagesPage } from '@/components/packagesPage';
import { createQuickTools } from '@/components/quickTools';
import { createRunPanel } from '@/components/runPanel';
import { createSearchPanel } from '@/components/searchPanel';
import { showSettings } from '@/components/settingsSheet';
import { createTabsBar } from '@/components/tabsBar';
import { toast } from '@/components/toast';

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));

async function start(): Promise<void> {
  const settings = createSettings();
  const statusLeft = signal('Ln 1, Col 1');
  const statusRight = signal('');
  const drawerOpen = signal(false);
  const drawerTab = signal<DrawerTab>('files');
  const menuOpen = signal(false);

  // ---- Python runtime + workspace ---------------------------------------
  const readBase64 = (path: string): Promise<string> => fsOperation(`file://${encodeURI(path)}`).readFile('base64');
  const runtime = await createRuntime(readBase64);
  let info: RuntimeInfo | null = null;
  try {
    info = await runtime.init();
  } catch {
    /* "none" backend, or Python failed to start: Run reports the reason */
  }
  const workspace = await createWorkspace(runtime, info);
  const runtimeLabel = signal(info ? `Python ${info.python}` : runtime.kind === 'none' ? 'Python unavailable' : 'Python');

  // ---- editor --------------------------------------------------------------
  // Built as a plain element first so EditorManager can mount CodeMirror into
  // it before the shell (which will contain it) exists.
  const editorHost = document.createElement('main');
  editorHost.id = 'editor-host';
  const editorManager = new EditorManager(editorHost);
  editorManager.onUpdate(() => {
    const head = editorManager.editor.state.selection.main.head;
    const line = editorManager.editor.state.doc.lineAt(head);
    statusLeft.set(editorManager.activeFile.peek() ? `Ln ${line.number}, Col ${head - line.from + 1}` : '');
  });

  watch(
    () => settings.fontSize(),
    (size) => document.documentElement.style.setProperty('--editor-font-size', `${size}px`),
  );

  const openFile = async (url: string, name: string, path: string | null = null): Promise<void> => {
    try {
      await editorManager.openFile(url, name, path ?? workspace.relativePath(url));
      drawerOpen.set(false);
      editorManager.editor.focus();
    } catch (error) {
      toast(`Could not open ${name}: ${errorMessage(error)}`, 'error');
    }
  };

  // ---- running code ----------------------------------------------------------
  let handle: RunHandle | null = null;
  let lastRun: 'file' | 'repl' = 'file';

  const runPanel = createRunPanel({
    onInput: (text) => handle?.stdin(text),
    onGuiEvent: (event: GuiEvent) => handle?.gui(event),
    onJump: (path, line) => void jumpToTraceback(path, line),
    onStop: () => void stop(),
    onRerun: () => void (lastRun === 'repl' ? openRepl() : runActive()),
  });

  async function jumpToTraceback(path: string, line: number): Promise<void> {
    const url = workspace.urlForPythonPath(path);
    if (!url) {
      toast('That file isn’t in your workspace.', 'info');
      return;
    }
    await openFile(url, url.slice(url.lastIndexOf('/') + 1));
    runPanel.hide();
    editorManager.goToLine(line);
  }

  const onEvent = (ev: PyEvent): void => {
    const c = runPanel.console;
    switch (ev.t) {
      case 'out':
        c.write('out', ev.s);
        break;
      case 'err':
        c.write('err', ev.s);
        break;
      case 'input':
        c.showInput(ev.prompt);
        break;
      case 'gui':
        runPanel.display.handleGui(ev.cmds);
        break;
      case 'img':
        void runtime
          .imageUrl(ev.path)
          .then((url) => runPanel.display.showImage(url, ev.title))
          .catch((e) => c.system(`Could not load plot: ${errorMessage(e)}`, 'error'));
        break;
      default:
        break;
    }
  };

  function begin(title: string): void {
    runPanel.beginRun(settings.clearConsoleOnRun.peek());
    runPanel.console.system(title, 'info');
    runPanel.status.set({ kind: 'running', text: 'Running…' });
  }

  function attach(h: RunHandle): void {
    handle = h;
    void h.done.then((exit) => {
      if (handle !== h) return; // a newer run has replaced this one
      handle = null;
      runPanel.console.finish();
      const secs = (exit.ms / 1000).toFixed(exit.ms < 10000 ? 2 : 1);
      if (exit.code === 0) {
        runPanel.console.system(`Finished in ${secs}s`, 'ok');
        runPanel.status.set({ kind: 'ok', text: `Finished · ${secs}s` });
      } else if (exit.code === 137) {
        runPanel.console.system('Stopped', 'info');
        runPanel.status.set({ kind: 'idle', text: 'Stopped' });
      } else {
        runPanel.console.system(`Exited with code ${exit.code}`, 'error');
        runPanel.status.set({ kind: 'error', text: `Exit code ${exit.code}` });
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
      if (failed.length) toast(`Could not save ${failed.join(', ')}`, 'error');
    }
    lastRun = 'file';
    begin(`▶ ${file.name}`);
    attach(runtime.run(workspace.buildRunRequest(file.url, file.name, editorManager.getValue()), onEvent));
  }

  async function openRepl(): Promise<void> {
    await stop();
    lastRun = 'repl';
    begin('Python shell');
    attach(runtime.run({ mode: 'repl', ...(workspace.kind === 'dev' ? { cwd: '' } : {}) }, onEvent));
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
    onOpenMatch: (url, name, line) => void openFile(url, name).then(() => editorManager.goToLine(line)),
  });

  const save = async (): Promise<void> => {
    try {
      const saved = await editorManager.save();
      toast(saved ? 'Saved' : 'This file has nowhere to be saved yet.', saved ? 'success' : 'info', 1400);
    } catch (error) {
      toast(`Could not save: ${errorMessage(error)}`, 'error');
    }
  };

  const closeActiveFile = async (): Promise<void> => {
    const file = editorManager.activeFile.peek();
    if (!file) return;
    if (file.dirty.peek()) {
      const discard = await confirmDialog({
        title: 'Close without saving?',
        message: `“${file.name}” has unsaved changes.`,
        confirmLabel: 'Discard',
        danger: true,
      });
      if (!discard) return;
    }
    editorManager.closeFile(file.id);
  };

  const packagesPage = createPackagesPage(runtime, info);

  // ---- assemble ----------------------------------------------------------------
  const app = createAppShell({
    editorManager,
    editorHost,
    fileBrowser,
    searchPanel,
    tabsBar: createTabsBar(editorManager),
    quickTools: createQuickTools(editorManager),
    runPanel,
    packagesPage,
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
    onOpenSettings: () => void showSettings(settings, info),
    onCloseFile: () => void closeActiveFile(),
    describeFile: (file) => {
      const rel = file.url ? workspace.relativePath(file.url) : null;
      if (rel !== null) {
        const dir = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
        return dir ? `Workspace / ${dir.split('/').join(' / ')}` : 'Workspace';
      }
      return file.url ? `External folder${file.path ? ` · ${file.path}` : ''}` : 'Not saved yet';
    },
  });
  document.getElementById('root')?.appendChild(app);

  // Transient status messages fade after a few seconds.
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  watch(
    () => statusRight(),
    (message) => {
      clearTimeout(statusTimer);
      if (message) statusTimer = setTimeout(() => statusRight.set(''), 5000);
    },
  );

  // ---- restore the previous session -------------------------------------------
  const session = loadSession();
  for (const f of session.files) {
    try {
      if (await fsOperation(f.url).exists()) await editorManager.openFile(f.url, f.name, f.path);
    } catch {
      /* file vanished or its folder grant was revoked: just don't reopen it */
    }
  }
  const wanted = editorManager.activeFiles.peek().find((f) => f.url === session.active);
  if (wanted) editorManager.switchTo(wanted.id);
  if (editorManager.activeFiles.peek().length === 0) {
    const entries = await fsOperation(workspace.rootUrl).listDir().catch(() => []);
    const first = entries.filter((e) => !e.isDirectory && e.name.endsWith('.py')).sort((a, b) => a.name.localeCompare(b.name))[0];
    if (first) await openFile(first.url, first.name);
  }

  watch(
    () => ({ files: editorManager.activeFiles(), active: editorManager.activeFile() }),
    ({ files, active }) =>
      saveSession({
        files: files.flatMap((f) => (f.url ? [{ url: f.url, name: f.name, path: f.path }] : [])),
        active: active?.url ?? null,
      }),
    { defer: true },
  );

  // ---- lifecycle ----------------------------------------------------------------
  // Android can kill a backgrounded app at any time: write changes out first.
  const flush = (): void => void editorManager.saveAll();
  document.addEventListener('pause', flush);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flush();
  });

  document.addEventListener('backbutton', () => {
    if (handleBack()) return;
    (navigator as Navigator & { app?: { exitApp(): void } }).app?.exitApp();
  });
  document.addEventListener('keydown', (e) => {
    // Desktop preview: Esc plays the role of Back.
    if (e.key === 'Escape' && !e.defaultPrevented) handleBack();
    // Ctrl/Cmd+Enter runs/stops, Ctrl/Cmd+S saves (desktop preview, Bluetooth keyboards).
    if (!(e.ctrlKey || e.metaKey)) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      void (runPanel.running.peek() ? stop() : runActive());
    } else if (e.key === 's') {
      e.preventDefault();
      void save();
    }
  });

  // A handle for DevTools and the automated UI smoke test (utils/scripts/smoke-test.ts).
  Object.assign(window, { pyforge: { editorManager, runPanel, workspace, runtime } });

  if (editorManager.activeFile.peek()) editorManager.editor.focus();
}

if (typeof window.cordova !== 'undefined') {
  document.addEventListener('deviceready', () => void start(), { once: true });
} else if (document.readyState === 'loading') {
  // boot.js injects this script after the page has parsed, so DOMContentLoaded
  // may already have fired; readyState tells us which case we're in.
  document.addEventListener('DOMContentLoaded', () => void start(), { once: true });
} else {
  void start();
}
