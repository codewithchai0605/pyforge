import { For, Show, computed, h, signal } from 'xtags';
import type { InstalledPackage, PipProgress, PyRuntime, RuntimeInfo } from '@/python/protocol';
import { icon } from './icons';
import { confirmDialog } from './dialogs';
import { pushBack } from './backStack';
import { toast } from './toast';

interface Suggestion {
  name: string;
  blurb: string;
  /** Needs compiled code, so it only installs if an Android build exists for it. */
  compiled?: boolean;
}

const SUGGESTIONS: Suggestion[] = [
  { name: 'requests', blurb: 'Friendly HTTP requests' },
  { name: 'beautifulsoup4', blurb: 'Parse HTML and XML' },
  { name: 'rich', blurb: 'Beautiful terminal output' },
  { name: 'tqdm', blurb: 'Progress bars' },
  { name: 'python-dateutil', blurb: 'Powerful date parsing' },
  { name: 'flask', blurb: 'Tiny web framework' },
  { name: 'sympy', blurb: 'Symbolic mathematics' },
  { name: 'colorama', blurb: 'Coloured text output' },
  { name: 'numpy', blurb: 'Fast arrays and maths', compiled: true },
  { name: 'matplotlib', blurb: 'Charts and plots', compiled: true },
  { name: 'pandas', blurb: 'Data tables', compiled: true },
  { name: 'pillow', blurb: 'Image processing', compiled: true },
  { name: 'scipy', blurb: 'Scientific computing', compiled: true },
];

export interface PackagesPage {
  readonly el: HTMLElement;
  open(): void;
  close(): void;
}

export function createPackagesPage(runtime: PyRuntime, info: RuntimeInfo | null): PackagesPage {
  const isOpen = signal(false);
  const installed = signal<InstalledPackage[]>([]);
  const loadingList = signal(false);
  const query = signal('');
  const busy = signal<string | null>(null);

  // progress card state
  const progressOpen = signal(false);
  const progressTitle = signal('');
  const progressDone = signal(false);
  const progressError = signal<string | null>(null);
  const progressPct = signal<number | null>(null);
  const progressFile = signal('');
  const logEl = h('pre', { class: 'pip-log', 'aria-live': 'polite' }) as HTMLElement;

  const installedNames = computed(() => new Map(installed().map((p) => [p.name, p.version])));

  async function refresh(): Promise<void> {
    loadingList.set(true);
    try {
      installed.set(await runtime.pip.list());
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), 'error');
    } finally {
      loadingList.set(false);
    }
  }

  const onProgress = (p: PipProgress): void => {
    if (p.t === 'log' && p.s) {
      logEl.append(document.createTextNode(p.s + '\n'));
      logEl.scrollTop = logEl.scrollHeight;
    } else if (p.t === 'dl') {
      progressFile.set(p.file ?? '');
      progressPct.set(p.total ? Math.round(((p.done ?? 0) / p.total) * 100) : null);
    }
  };

  async function runOperation(title: string, doneTitle: string, op: () => Promise<void>): Promise<void> {
    if (busy.peek()) return;
    busy.set(title);
    logEl.textContent = '';
    progressTitle.set(title);
    progressError.set(null);
    progressDone.set(false);
    progressPct.set(null);
    progressFile.set('');
    progressOpen.set(true);
    const release = pushBack(() => {
      if (progressDone.peek()) progressOpen.set(false);
    });
    try {
      await op();
      progressTitle.set(doneTitle);
      progressDone.set(true);
      await refresh();
    } catch (e) {
      progressTitle.set(`${title} failed`);
      progressError.set(e instanceof Error ? e.message : String(e));
      progressDone.set(true);
    } finally {
      busy.set(null);
      release();
    }
  }

  const install = (spec: string): Promise<void> =>
    runOperation(`Installing ${spec}`, `Installed ${spec}`, async () => {
      const result = await runtime.pip.install([spec], onProgress);
      if (result.installed.length) toast(`Installed ${result.installed.map((i) => `${i.name} ${i.version}`).join(', ')}`, 'success');
    });

  const uninstall = async (pkg: InstalledPackage): Promise<void> => {
    const ok = await confirmDialog({
      title: `Uninstall ${pkg.name}?`,
      message: 'Programs that import it will stop working until you install it again.',
      confirmLabel: 'Uninstall',
      danger: true,
    });
    if (!ok) return;
    await runOperation(`Removing ${pkg.name}`, `Removed ${pkg.name}`, async () => {
      const r = await runtime.pip.uninstall(pkg.name, onProgress);
      toast(`Removed ${r.removed}`, 'success');
    });
  };

  const submit = (): void => {
    const spec = query.peek().trim();
    if (!spec) return;
    query.set('');
    void install(spec);
  };

  const suggestionCard = (s: Suggestion): HTMLElement =>
    h(
      'div',
      { class: 'pkg-card' },
      h('div', { class: 'pkg-card-text' }, h('strong', null, s.name), s.compiled ? h('span', { class: 'tag', title: 'Needs compiled code. Installs only if an Android build exists; otherwise bundle it at build time (python/requirements.txt).' }, 'compiled') : null, h('span', { class: 'pkg-blurb' }, s.blurb)),
      h(
        'button',
        {
          type: 'button',
          class: computed(() => ({ btn: true, 'btn-small': true, 'btn-primary': !installedNames().has(s.name) })),
          disabled: computed(() => installedNames().has(s.name) || busy() !== null),
          'aria-label': computed(() => (installedNames().has(s.name) ? `${s.name} is installed` : `Install ${s.name}`)),
          onClick: () => void install(s.name),
        },
        computed(() => (installedNames().has(s.name) ? 'Installed' : 'Install')),
      ),
    ) as HTMLElement;

  const el = h(
    'div',
    { id: 'packages-page', class: computed(() => ({ page: true, open: isOpen() })), 'aria-hidden': computed(() => String(!isOpen())), role: 'dialog', 'aria-label': 'Python packages' },
    h(
      'header',
      { class: 'page-header' },
      h('button', { type: 'button', class: 'icon-btn', title: 'Back', 'aria-label': 'Back', onClick: () => close() }, icon('chevronRight', 22)),
      h('h1', { class: 'page-title' }, 'Packages'),
      h('span', { class: 'panel-spacer' }),
      h('button', { type: 'button', class: 'icon-btn', title: 'Refresh', 'aria-label': 'Refresh', onClick: () => void refresh() }, icon('refresh', 20)),
    ),
    h(
      'div',
      { class: 'page-scroll' },
      h('p', { class: 'runtime-line' }, info ? `Python ${info.python}${info.abi ? ` · ${info.abi}` : ' · desktop preview'}` : 'Python is not available here'),
      h(
        'form',
        {
          class: 'install-bar',
          onSubmit: (e: Event) => {
            e.preventDefault();
            submit();
          },
        },
        h('input', { type: 'text', class: 'text-input', placeholder: 'Package name, e.g. requests or rich>=13', 'aria-label': 'Package to install', enterkeyhint: 'go', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', spellcheck: 'false', model: query }),
        h('button', { type: 'submit', class: 'btn btn-primary', disabled: computed(() => busy() !== null || query().trim() === '') }, icon('download', 18), 'Install'),
      ),
      h('h2', { class: 'section-title' }, 'Popular'),
      h('div', { class: 'pkg-grid' }, ...SUGGESTIONS.map(suggestionCard)),
      h('h2', { class: 'section-title' }, 'Installed', h('span', { class: 'count' }, computed(() => String(installed().length)))),
      Show({
        when: () => installed().length === 0,
        children: h('p', { class: 'muted' }, computed(() => (loadingList() ? 'Loading…' : 'Nothing installed yet. Pick a package above, or type a name.'))),
      }),
      h(
        'ul',
        { class: 'pkg-list' },
        h(For<InstalledPackage>, {
          each: installed,
          key: (p) => p.name,
          children: (p) =>
            h(
              'li',
              { class: 'pkg-row' },
              h('div', { class: 'pkg-row-text' }, h('strong', null, p.name), h('span', { class: 'pkg-version' }, p.version), !p.removable ? h('span', { class: 'tag' }, 'built in') : null, p.summary ? h('span', { class: 'pkg-blurb' }, p.summary) : null),
              p.removable
                ? h('button', { type: 'button', class: 'icon-btn danger', title: `Uninstall ${p.name}`, 'aria-label': `Uninstall ${p.name}`, disabled: computed(() => busy() !== null), onClick: () => void uninstall(p) }, icon('trash', 18))
                : null,
            ),
        }),
      ),
    ),
    // Progress card
    h(
      'div',
      { class: computed(() => ({ 'progress-scrim': true, show: progressOpen() })) },
      h(
        'div',
        { class: 'progress-card', role: 'status' },
        h('h2', { class: 'dialog-title' }, progressTitle),
        h('div', { class: computed(() => ({ bar: true, indeterminate: !progressDone() && progressPct() === null, hidden: progressDone() })) }, h('div', { class: 'bar-fill', style: { width: computed(() => (progressPct() === null ? '40%' : `${progressPct()}%`)) } })),
        h('div', { class: 'bar-caption' }, computed(() => (progressDone() ? '' : progressFile()))),
        logEl,
        Show({ when: () => !!progressError(), children: h('div', { class: 'dialog-error', role: 'alert' }, progressError) }),
        h('div', { class: 'dialog-actions' }, h('button', { type: 'button', class: 'btn btn-primary', disabled: computed(() => !progressDone()), onClick: () => progressOpen.set(false) }, 'Done')),
      ),
    ),
  ) as HTMLElement;

  let release = (): void => {};
  function open(): void {
    if (isOpen.peek()) return;
    isOpen.set(true);
    release = pushBack(() => close());
    void refresh();
  }
  function close(): void {
    if (!isOpen.peek()) return;
    if (progressOpen.peek() && !progressDone.peek()) return; // don't leave mid-install
    progressOpen.set(false);
    isOpen.set(false);
    release();
  }

  return { el, open, close };
}
