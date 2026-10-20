import { Show, computed, h, watch, type Signal } from 'xtags';
import type { EditorManager } from '@/editorManager';
import type { FileBrowser } from './fileBrowser';
import type { SearchPanelElement } from './searchPanel';
import type { RunPanel } from './runPanel';
import type { PackagesPage } from './packagesPage';
import { icon, type IconName } from './icons';
import { pushBack } from './backStack';

export type DrawerTab = 'files' | 'search';

export interface AppShellOptions {
  editorManager: EditorManager;
  editorHost: HTMLElement;
  fileBrowser: FileBrowser;
  searchPanel: SearchPanelElement;
  tabsBar: HTMLElement;
  quickTools: HTMLElement;
  runPanel: RunPanel;
  packagesPage: PackagesPage;
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
  onOpenSettings(): void;
  onCloseFile(): void;
  /** Where the open file lives, shown under its name ("Workspace / src"). */
  describeFile(file: { url: string | null; path: string | null }): string;
}

function railButton(label: string, name: IconName, active: () => boolean, onClick: () => void): HTMLElement {
  return h(
    'button',
    { type: 'button', class: computed(() => ({ 'rail-btn': true, active: active() })), title: label, 'aria-label': label, 'aria-pressed': computed(() => String(active())), onClick },
    icon(name, 22),
  ) as HTMLElement;
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
  const { editorManager: em, drawerOpen, drawerTab, menuOpen, runPanel } = o;
  closeOnBack(drawerOpen);
  closeOnBack(menuOpen);

  const fileTitle = computed(() => em.activeFile()?.name ?? 'PyForge');
  const filePath = computed(() => {
    const f = em.activeFile();
    return f ? o.describeFile(f) : 'No file open';
  });
  const dirty = computed(() => em.activeFile()?.dirty() ?? false);
  const running = runPanel.running;
  const hasFile = computed(() => em.activeFile() !== null);

  const menuItem = (label: string, name: IconName, action: () => void, disabled?: () => boolean): HTMLElement =>
    h(
      'button',
      {
        type: 'button',
        role: 'menuitem',
        class: 'menu-item',
        disabled: disabled ? computed(disabled) : false,
        onClick: () => {
          menuOpen.set(false);
          action();
        },
      },
      icon(name, 18),
      h('span', null, label),
    ) as HTMLElement;

  const titlebar = h(
    'header',
    { id: 'titlebar' },
    h('button', { type: 'button', class: 'icon-btn', title: 'Files', 'aria-label': 'Open files drawer', onClick: () => drawerOpen.set(true) }, icon('menu', 22)),
    h(
      'div',
      { class: 'title-block' },
      h('div', { class: 'title-line' }, h('span', { id: 'filename' }, fileTitle), h('span', { class: computed(() => ({ 'dirty-dot': true, visible: dirty() })), title: 'Unsaved changes' })),
      h('div', { id: 'filepath', class: 'subtle' }, filePath),
    ),
    h(
      'button',
      {
        type: 'button',
        id: 'run-btn',
        class: computed(() => ({ 'run-btn': true, stop: running() })),
        disabled: computed(() => !running() && !hasFile()),
        title: computed(() => (running() ? 'Stop' : 'Run')),
        'aria-label': computed(() => (running() ? 'Stop program' : 'Run program')),
        onClick: () => (running.peek() ? o.onStop() : o.onRun()),
      },
      computed(() => icon(running() ? 'stop' : 'play', 22)),
      h('span', { class: 'run-label' }, computed(() => (running() ? 'Stop' : 'Run'))),
    ),
    h('button', { type: 'button', class: 'icon-btn', title: 'More', 'aria-label': 'More actions', 'aria-haspopup': 'menu', 'aria-expanded': computed(() => String(menuOpen())), onClick: () => menuOpen.update((v) => !v) }, icon('more', 22)),
  ) as HTMLElement;

  const menu = h(
    'div',
    { id: 'overflow-menu', role: 'menu', class: computed(() => ({ menu: true, open: menuOpen() })) },
    menuItem('Save', 'save', o.onSave, () => !hasFile()),
    menuItem('New file', 'filePlus', o.onNewFile),
    menuItem('Python shell', 'terminal', o.onOpenRepl),
    menuItem('Output', 'image', () => runPanel.show()),
    menuItem('Packages', 'package', () => o.packagesPage.open()),
    menuItem('Close file', 'x', o.onCloseFile, () => !hasFile()),
    menuItem('Settings', 'settings', o.onOpenSettings),
  ) as HTMLElement;

  const drawer = h(
    'aside',
    { id: 'drawer', class: computed(() => ({ open: drawerOpen() })), 'aria-hidden': computed(() => String(!drawerOpen())), 'aria-label': 'Navigation' },
    h(
      'div',
      { class: 'drawer-brand' },
      h('span', { class: 'brand-mark' }, icon('logo', 22)),
      h('strong', null, 'PyForge'),
      h('span', { class: 'panel-spacer' }),
      h('button', { type: 'button', class: 'icon-btn', title: 'Close', 'aria-label': 'Close drawer', onClick: () => drawerOpen.set(false) }, icon('x', 20)),
    ),
    h(
      'div',
      { class: 'drawer-body' },
      h(
        'nav',
        { class: 'rail', 'aria-label': 'Sections' },
        railButton('Files', 'folder', () => drawerTab() === 'files', () => drawerTab.set('files')),
        railButton('Search', 'search', () => drawerTab() === 'search', () => {
          drawerTab.set('search');
          o.searchPanel.focusInput();
        }),
        railButton('Packages', 'package', () => false, () => {
          drawerOpen.set(false);
          o.packagesPage.open();
        }),
        h('span', { class: 'panel-spacer' }),
        railButton('Settings', 'settings', () => false, () => {
          drawerOpen.set(false);
          o.onOpenSettings();
        }),
      ),
      h(
        'div',
        { class: 'drawer-panels' },
        h('div', { class: computed(() => ({ 'drawer-panel': true, hidden: drawerTab() !== 'files' })) }, o.fileBrowser),
        h('div', { class: computed(() => ({ 'drawer-panel': true, hidden: drawerTab() !== 'search' })) }, o.searchPanel),
      ),
    ),
  ) as HTMLElement;

  const emptyState = Show({
    when: () => !hasFile(),
    children: h(
      'div',
      { class: 'empty-editor' },
      h('span', { class: 'brand-mark big' }, icon('logo', 40)),
      h('h2', null, 'No file open'),
      h('p', null, 'Open a file from the drawer, or start a new one.'),
      h(
        'div',
        { class: 'empty-actions' },
        h('button', { type: 'button', class: 'btn btn-primary', onClick: o.onNewFile }, icon('filePlus', 18), 'New file'),
        h('button', { type: 'button', class: 'btn', onClick: () => drawerOpen.set(true) }, icon('folder', 18), 'Browse files'),
      ),
    ),
  });

  const statusbar = h(
    'footer',
    { id: 'statusbar' },
    h('span', { id: 'status-left' }, o.statusLeft),
    h('span', { class: 'status-lang' }, o.runtimeLabel),
    h('span', { class: 'panel-spacer' }),
    h('span', { id: 'status-right', role: 'status' }, o.statusRight),
  ) as HTMLElement;

  return h(
    'div',
    { id: 'app', class: computed(() => ({ 'sheet-open': runPanel.open(), 'sheet-expanded': runPanel.expanded() })) },
    titlebar,
    o.tabsBar,
    h('div', { class: 'editor-area' }, o.editorHost, emptyState),
    o.quickTools,
    runPanel.el,
    statusbar,
    h('div', { class: computed(() => ({ scrim: true, show: drawerOpen() })), onClick: () => drawerOpen.set(false) }),
    h('div', { class: computed(() => ({ 'menu-scrim': true, show: menuOpen() })), onClick: () => menuOpen.set(false) }),
    drawer,
    menu,
    o.packagesPage.el,
  ) as HTMLElement;
}
