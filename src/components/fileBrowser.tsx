import { Show, computed, signal } from 'xtags';
import { fsOperation, type FileEntry } from '@/fileSystem';
import { saf } from '@/native/saf';
import { icon } from './icons';
import { fileIcon } from './fileIcons';
import { confirmDialog, promptDialog, sheetDialog } from './dialogs';
import { TEMPLATES } from '@/python/templates';

export interface FileBrowserOptions {
  /** The workspace folder (app-private projects on a phone). Always shown first. */
  workspaceUrl: string;
  /** `path` is relative to the opened root, for the titlebar breadcrumb. */
  onOpenFile(url: string, name: string, path: string | null): Promise<unknown>;
  /** A file or folder was deleted (so open tabs on it should close). */
  onDeleted(url: string): void;
  /** A file or folder was renamed; tabs on the old URL should be closed. */
  onRenamed(oldUrl: string): void;
  setStatus(message: string): void;
}

export interface FileBrowser extends HTMLElement {
  /** Create a new file (from a template) in the folder that was last used. */
  createFile(): Promise<void>;
  createFolder(): Promise<void>;
  refresh(): Promise<void>;
  /** The folder the tree is rooted at (workspace or an opened external folder). */
  getRootUrl(): string;
  /** Reveal-free helper used after Run creates files: reloads the tree. */
  openExternalFolder(): Promise<void>;
}

const errorText = (e: unknown): string => (e instanceof Error ? e.message : typeof e === 'string' ? e : JSON.stringify(e));

function sortEntries(entries: FileEntry[]): FileEntry[] {
  return entries
    .filter((e) => !e.name.startsWith('.')) // hide .scratch and friends
    .sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

function validName(name: string): string | null {
  if (/[\\/]/.test(name)) return 'Names can’t contain slashes.';
  if (name === '.' || name === '..') return 'That name isn’t allowed.';
  return null;
}

/**
 * The explorer. Rooted at the workspace by default; "Open folder" swaps the
 * root to a folder picked through Android's Storage Access Framework.
 *
 * Rows are plain DOM managed imperatively (folders lazily load their children
 * on first expand and refresh after changes); only the root/title/loading
 * state are signals. Long-press (or right-click) a row for rename / delete /
 * new file here.
 */
export function createFileBrowser(options: FileBrowserOptions): FileBrowser {
  const rootUrl = signal(options.workspaceUrl);
  const rootName = signal('Workspace');
  const isWorkspace = computed(() => rootUrl() === options.workspaceUrl);
  const loading = signal(false);
  /** Where "new file/folder" goes: the last folder tapped, else the root. */
  let targetDir = options.workspaceUrl;

  const tree = (<div class="file-tree" role="tree" />) as HTMLElement;
  const expanded = new Set<string>();

  async function list(url: string): Promise<FileEntry[]> {
    return sortEntries(await fsOperation(url).listDir());
  }

  async function renderChildren(container: HTMLElement, url: string, depth: number): Promise<void> {
    let entries: FileEntry[];
    try {
      entries = await list(url);
    } catch (e) {
      options.setStatus(`Could not read folder: ${errorText(e)}`);
      return;
    }
    const rows = entries.map((entry) => createRow(entry, rootUrl.peek(), depth));
    if (rows.length === 0 && depth === 0) {
      rows.push((<div class="tree-empty">This folder is empty. Use the buttons above to add a file.</div>) as HTMLElement);
    }
    container.replaceChildren(...rows);
  }

  function relPath(url: string): string | null {
    const root = rootUrl.peek();
    if (url.startsWith(root)) return decodeURIComponent(url.slice(root.length)).replace(/^\//, '');
    return null;
  }

  function createRow(entry: FileEntry, _root: string, depth: number): HTMLElement {
    const children = (<div class="tree-children" role="group" />) as HTMLElement;
    const chevron = (<span class="tree-chevron">{entry.isDirectory ? icon('chevronRight', 14) : null}</span>) as HTMLElement;
    const row = (
      <button type="button" class={`tree-row ${entry.isDirectory ? 'tree-folder' : 'tree-file'}`} style={{ paddingLeft: `${8 + depth * 14}px` }}>
        {chevron}
        {fileIcon(entry.name, entry.isDirectory)}
        <span class="tree-label">{entry.name}</span>
      </button>
    ) as HTMLButtonElement;
    const wrapper = (<div class="tree-node" role="treeitem" />) as HTMLElement;

    const setOpen = async (open: boolean): Promise<void> => {
      row.classList.toggle('open', open);
      if (open) {
        expanded.add(entry.url);
        await renderChildren(children, entry.url, depth + 1);
      } else {
        expanded.delete(entry.url);
        children.replaceChildren();
      }
    };

    row.addEventListener('click', () => {
      if (suppressClick) return;
      if (entry.isDirectory) {
        targetDir = entry.url;
        void setOpen(!row.classList.contains('open'));
      } else {
        void options.onOpenFile(entry.url, entry.name, relPath(entry.url));
      }
    });

    // Long-press / right-click -> actions.
    let timer: ReturnType<typeof setTimeout> | undefined;
    let suppressClick = false;
    const cancel = (): void => clearTimeout(timer);
    row.addEventListener('pointerdown', () => {
      timer = setTimeout(() => {
        suppressClick = true;
        setTimeout(() => (suppressClick = false), 400);
        void showActions(entry);
      }, 480);
    });
    for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'pointermove'] as const) row.addEventListener(ev, cancel);
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      void showActions(entry);
    });

    wrapper.append(row, children);
    if (entry.isDirectory && expanded.has(entry.url)) void setOpen(true);
    return wrapper;
  }

  async function showActions(entry: FileEntry): Promise<void> {
    const choice = await sheetDialog(entry.name, [
      ...(entry.isDirectory
        ? [
            { label: 'New file here', icon: 'filePlus' as const, value: 'new-file' as const },
            { label: 'New folder here', icon: 'folderPlus' as const, value: 'new-folder' as const },
          ]
        : []),
      { label: 'Rename', icon: 'edit' as const, value: 'rename' as const },
      { label: 'Delete', icon: 'trash' as const, danger: true, value: 'delete' as const },
    ]);
    if (!choice) return;
    try {
      if (choice === 'new-file') {
        targetDir = entry.url;
        await createFile();
      } else if (choice === 'new-folder') {
        targetDir = entry.url;
        await createFolder();
      } else if (choice === 'rename') {
        const name = await promptDialog({ title: 'Rename', value: entry.name, confirmLabel: 'Rename', validate: validName, selectStem: !entry.isDirectory });
        if (!name || name === entry.name) return;
        await fsOperation(entry.url).rename(name);
        options.onRenamed(entry.url);
        await refresh();
      } else {
        const ok = await confirmDialog({
          title: `Delete ${entry.isDirectory ? 'folder' : 'file'}?`,
          message: entry.isDirectory ? `“${entry.name}” and everything inside it will be deleted. This can’t be undone.` : `“${entry.name}” will be deleted. This can’t be undone.`,
          confirmLabel: 'Delete',
          danger: true,
        });
        if (!ok) return;
        await fsOperation(entry.url).delete();
        options.onDeleted(entry.url);
        await refresh();
      }
    } catch (e) {
      options.setStatus(`${errorText(e)}`);
    }
  }

  async function refresh(): Promise<void> {
    loading.set(true);
    try {
      await renderChildren(tree, rootUrl.peek(), 0);
    } finally {
      loading.set(false);
    }
  }

  async function createFile(): Promise<void> {
    const dir = targetDir;
    const template = await sheetDialog(
      'New file',
      TEMPLATES.map((t) => ({ label: t.label, description: t.description, icon: 'filePlus' as const, value: t })),
    );
    if (!template) return;
    const name = await promptDialog({
      title: 'File name',
      value: template.filename,
      confirmLabel: 'Create',
      validate: validName,
      selectStem: true,
    });
    if (!name) return;
    try {
      const entry = await fsOperation(dir).createFile(name);
      if (template.content) await fsOperation(entry.url).writeFile(template.content);
      expanded.add(dir);
      await refresh();
      await options.onOpenFile(entry.url, entry.name, relPath(entry.url));
    } catch (e) {
      options.setStatus(`Could not create file: ${errorText(e)}`);
    }
  }

  async function createFolder(): Promise<void> {
    const dir = targetDir;
    const name = await promptDialog({ title: 'New folder', placeholder: 'folder name', confirmLabel: 'Create', validate: validName });
    if (!name) return;
    try {
      await fsOperation(dir).createDirectory(name);
      expanded.add(dir);
      await refresh();
    } catch (e) {
      options.setStatus(`Could not create folder: ${errorText(e)}`);
    }
  }

  async function openExternalFolder(): Promise<void> {
    try {
      const url = await saf.pickFolder();
      const info = await saf.stat(url);
      rootUrl.set(url);
      rootName.set(info.name ?? 'Folder');
      targetDir = url;
      expanded.clear();
      options.setStatus('Folder opened');
      await refresh();
    } catch (e) {
      options.setStatus(`Folder was not opened: ${errorText(e)}`);
    }
  }

  async function backToWorkspace(): Promise<void> {
    rootUrl.set(options.workspaceUrl);
    rootName.set('Workspace');
    targetDir = options.workspaceUrl;
    expanded.clear();
    await refresh();
  }

  const toolbarButton = (title: string, name: Parameters<typeof icon>[0], onClick: () => void): HTMLElement =>
    (
      <button type="button" class="icon-btn" title={title} aria-label={title} onClick={onClick}>
        {icon(name, 20)}
      </button>
    ) as HTMLElement;

  const browser = (
    <section id="file-browser" class="sidebar-panel">
      <div class="panel-header">
        <strong class="panel-title">{computed(() => rootName())}</strong>
        <span class="panel-spacer" />
        {toolbarButton('New file', 'filePlus', () => void createFile())}
        {toolbarButton('New folder', 'folderPlus', () => void createFolder())}
        {toolbarButton('Refresh', 'refresh', () => void refresh())}
      </div>
      <Show when={() => !isWorkspace()}>
        <button type="button" class="back-to-workspace" onClick={() => void backToWorkspace()}>
          ← Back to workspace
        </button>
      </Show>
      <div class="tree-scroll">{tree}</div>
      <div class="panel-footer">
        <button type="button" class="btn btn-small" onClick={() => void openExternalFolder()}>
          {icon('folder', 16)}Open external folder
        </button>
      </div>
    </section>
  ) as FileBrowser;

  browser.createFile = createFile;
  browser.createFolder = createFolder;
  browser.refresh = refresh;
  browser.getRootUrl = () => rootUrl.peek();
  browser.openExternalFolder = openExternalFolder;

  void refresh();
  return browser;
}
