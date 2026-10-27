import { computed, signal } from "xtags";
import type {
  IndexStatus,
  InstalledPackage,
  LookupResult,
  PackageInfo,
  PipApi,
  PipProgress,
  SearchHit,
  UpdateCheck,
} from "@/python/protocol";
import { PipError } from "@/python/protocol";
import {
  CATALOG,
  catalogItem,
  searchCatalog,
  type CategoryId,
} from "./catalog";
import { canonicalName, plural } from "./format";
import {
  formatRequirements,
  parseRequirements,
  validateSpec,
  type ParsedRequirements,
} from "./requirements";

/**
 * Everything behind the Packages page that is not drawing: which tab is
 * open, what the search found, what an installed package's details are,
 * which updates exist, and the install / update / remove operations with
 * their progress.
 *
 * It has no DOM and takes every outside thing (the package manager, toasts,
 * the confirm dialog, the clipboard, the workspace) as a dependency, so it is
 * tested with a fake `pip` and the views stay thin.
 */

export type TabId = "install" | "search" | "installed";
export type OpState = "idle" | "running" | "cancelling" | "done" | "failed";

export interface ModelDeps {
  pip: PipApi;
  toast(message: string, kind?: "info" | "error" | "success"): void;
  confirm(o: {
    title: string;
    message: string;
    confirmLabel: string;
    danger?: boolean;
  }): Promise<boolean>;
  storage?: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  };
  copy?(text: string): Promise<void>;
  /** The workspace's requirements.txt. `read` gives null when there is none. */
  workspace?: {
    readRequirements(): Promise<string | null>;
    /** Writes it, returns where (for the toast). */
    writeRequirements(text: string): Promise<string>;
  };
  /** Typing pause before a search starts. */
  debounceMs?: number;
}

/** One line in the Search tab. */
export interface Row extends SearchHit {
  /** From the curated catalogue ("recommended"). */
  catalog: boolean;
  /** Probably needs a native Android build. */
  compiled: boolean;
}

export interface DetailState {
  name: string;
  key: string;
  info: Extract<PackageInfo, { status: "ok" }> | null;
  /** Shown while `info` has not arrived (or never will, if it failed). */
  summary: string;
  loading: boolean;
  error: string | null;
  /** The release picked in the version list; null = the newest this device can load. */
  selected: string | null;
  compat: LookupResult | null;
  compatLoading: boolean;
  dependents: string[];
}

const PAGE = 30;
const SUMMARY_ROWS = 12;
const RECENT_KEY = "pyforge.pkg.recent";
const TAB_KEY = "pyforge.pkg.tab";

const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export class PackagesModel {
  readonly tab = signal<TabId>("install");

  // ---- installed
  readonly installed = signal<InstalledPackage[]>([]);
  readonly loadingInstalled = signal(false);
  readonly installedFilter = signal("");
  readonly showBuiltin = signal(false);
  /** name -> version, for "Installed" badges everywhere. */
  readonly installedMap = computed(
    () => new Map(this.installed().map((p) => [p.name, p.version])),
  );
  readonly removableCount = computed(
    () => this.installed().filter((p) => p.removable).length,
  );
  readonly installedView = computed(() => {
    const q = canonicalName(this.installedFilter());
    const showBuiltin = this.showBuiltin();
    return this.installed().filter(
      (p) =>
        (showBuiltin || p.removable) &&
        (!q ||
          p.name.includes(q) ||
          p.summary
            .toLowerCase()
            .includes(this.installedFilter().trim().toLowerCase())),
    );
  });
  readonly builtinCount = computed(
    () => this.installed().filter((p) => !p.removable).length,
  );

  // ---- updates
  readonly updates = signal<ReadonlyMap<string, UpdateCheck>>(new Map());
  readonly checking = signal<{ done: number; total: number } | null>(null);
  readonly lastChecked = signal<number | null>(null);
  readonly updatable = computed(() =>
    [...this.updates().values()].filter((u) => u.update && u.latest),
  );

  // ---- install tab
  readonly installText = signal("");
  readonly installProblem = computed(() => validateSpec(this.installText()));
  readonly category = signal<CategoryId | "all">("all");
  readonly catalogView = computed(() =>
    CATALOG.filter(
      (i) => this.category() === "all" || i.category === this.category(),
    ),
  );

  // ---- search tab
  readonly query = signal("");
  readonly rows = signal<Row[]>([]);
  readonly total = signal(0);
  readonly searching = signal(false);
  readonly searchError = signal<string | null>(null);
  readonly index = signal<IndexStatus | null>(null);
  readonly indexProgress = signal<{
    done: number;
    total: number | null;
  } | null>(null);
  readonly recent = signal<string[]>([]);
  /** The query as a project name worth looking up exactly, when the results don't already contain it. */
  readonly exactCandidate = computed(() => {
    const q = this.query().trim();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(q)) return null;
    const key = canonicalName(q);
    return this.rows().some((r) => r.key === key) ? null : q;
  });
  readonly hasMore = computed(
    () => this.rows().filter((r) => !r.catalog).length < this.total(),
  );

  // ---- details
  readonly detail = signal<DetailState | null>(null);

  // ---- install/update/remove operation card
  readonly op = signal<OpState>("idle");
  readonly cardOpen = signal(false);
  readonly cardTitle = signal("");
  readonly cardError = signal<string | null>(null);
  readonly cardPct = signal<number | null>(null);
  readonly cardFile = signal("");
  readonly cancellable = signal(true);
  readonly busy = computed(
    () =>
      this.op() === "running" ||
      this.op() === "cancelling" ||
      this.checking() !== null,
  );
  /** The view appends each log line to the operation card. */
  onLog: (line: string) => void = () => {};
  /** The view clears the card's log when an operation starts. */
  onLogReset: () => void = () => {};
  /** The card opened/closed (the page hooks Android's Back button to it). */
  onCardChange: (open: boolean) => void = () => {};

  private searchSeq = 0;
  private detailSeq = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private readonly debounceMs: number;

  constructor(private readonly d: ModelDeps) {
    this.debounceMs = d.debounceMs ?? 280;
    try {
      const saved = d.storage?.getItem(RECENT_KEY);
      if (saved) {
        const list = JSON.parse(saved);
        if (Array.isArray(list))
          this.recent.set(
            list.filter((x) => typeof x === "string").slice(0, 8),
          );
      }
      const tab = d.storage?.getItem(TAB_KEY);
      if (tab === "install" || tab === "search" || tab === "installed")
        this.tab.set(tab);
    } catch {
      /* unreadable saved state: start fresh */
    }
  }

  // ================================================================ tabs

  setTab(tab: TabId): void {
    if (this.tab.peek() === tab) return;
    this.tab.set(tab);
    try {
      this.d.storage?.setItem(TAB_KEY, tab);
    } catch {
      /* private mode */
    }
    if (tab === "search") void this.enterSearch();
  }

  /** The page was opened. */
  async onShown(): Promise<void> {
    await this.refreshInstalled();
    if (this.tab.peek() === "search") await this.enterSearch();
  }

  // ========================================================== installed

  async refreshInstalled(): Promise<void> {
    this.loadingInstalled.set(true);
    try {
      this.installed.set(await this.d.pip.list());
    } catch (e) {
      this.d.toast(messageOf(e), "error");
    } finally {
      this.loadingInstalled.set(false);
    }
  }

  async checkUpdates(): Promise<void> {
    if (this.busy.peek()) return;
    this.checking.set({ done: 0, total: this.removableCount.peek() });
    try {
      const rows = await this.d.pip.outdated(null, (p) => {
        if (p.t === "check")
          this.checking.set({ done: p.done ?? 0, total: p.total ?? 0 });
      });
      this.updates.set(new Map(rows.map((r) => [r.name, r])));
      this.lastChecked.set(Date.now());
      const n = rows.filter((r) => r.update).length;
      const failed = rows.filter((r) => r.error).length;
      this.d.toast(
        n > 0
          ? `${plural(n, "update")} available`
          : failed > 0 && failed === rows.length
            ? "Couldn't check for updates. Are you online?"
            : "Everything is up to date",
        n > 0
          ? "info"
          : failed === rows.length && failed > 0
            ? "error"
            : "success",
      );
    } catch (e) {
      if (e instanceof PipError && e.cancelled)
        this.d.toast("Stopped checking.", "info");
      else this.d.toast(messageOf(e), "error");
    } finally {
      this.checking.set(null);
    }
  }

  async updateOne(name: string): Promise<void> {
    const u = this.updates.peek().get(name);
    if (!u?.update || !u.latest) return;
    await this.runInstall(
      [`${name}==${u.latest}`],
      `Updating ${name}`,
      `Updated ${name}`,
    );
  }

  async updateAll(): Promise<void> {
    const list = this.updatable.peek();
    if (list.length === 0) return;
    const specs = list.map((u) => `${u.name}==${u.latest}`);
    await this.runInstall(
      specs,
      `Updating ${plural(list.length, "package")}`,
      `Updated ${plural(list.length, "package")}`,
    );
  }

  /** What is on the clipboard / in the file. */
  requirementsText(): string {
    return formatRequirements(this.installed.peek());
  }

  async copyRequirements(): Promise<void> {
    if (this.removableCount.peek() === 0)
      return void this.d.toast("Nothing installed yet.", "info");
    try {
      await this.d.copy?.(this.requirementsText());
      this.d.toast("Copied as requirements.txt", "success");
    } catch (e) {
      this.d.toast(messageOf(e), "error");
    }
  }

  async saveRequirements(): Promise<void> {
    if (this.removableCount.peek() === 0)
      return void this.d.toast("Nothing installed yet.", "info");
    try {
      const where = await this.d.workspace?.writeRequirements(
        this.requirementsText(),
      );
      this.d.toast(
        where ? `Saved ${where}` : "Saved requirements.txt",
        "success",
      );
    } catch (e) {
      this.d.toast(messageOf(e), "error");
    }
  }

  // =============================================================== install

  async install(spec: string): Promise<void> {
    const s = spec.trim();
    if (!s || this.busy.peek()) return;
    await this.runInstall([s], `Installing ${s}`, `Installed ${s}`);
  }

  /** The install box: Enter / the Install button. */
  async submitInstallText(): Promise<void> {
    const s = this.installText.peek().trim();
    if (!s || this.installProblem.peek()) return;
    this.installText.set("");
    await this.install(s);
  }

  async workspaceRequirements(): Promise<string | null> {
    try {
      return (await this.d.workspace?.readRequirements()) ?? null;
    } catch {
      return null;
    }
  }

  previewRequirements(text: string): ParsedRequirements {
    return parseRequirements(text);
  }

  async installRequirements(specs: string[]): Promise<void> {
    if (specs.length === 0 || this.busy.peek()) return;
    await this.runInstall(
      specs,
      `Installing ${plural(specs.length, "package")}`,
      `Installed ${plural(specs.length, "package")}`,
    );
  }

  async uninstall(name: string): Promise<void> {
    if (this.busy.peek()) return;
    let usedBy: string[] = [];
    try {
      usedBy = (await this.d.pip.dependents(name)).dependents;
    } catch {
      /* the warning is a courtesy; removing still works without it */
    }
    const ok = await this.d.confirm({
      title: `Uninstall ${name}?`,
      message: usedBy.length
        ? `${usedBy.join(", ")} ${usedBy.length === 1 ? "needs" : "need"} it and will stop working until you install it again.`
        : "Programs that import it will stop working until you install it again.",
      confirmLabel: "Uninstall",
      danger: true,
    });
    if (!ok) return;
    await this.run(`Removing ${name}`, `Removed ${name}`, false, async () => {
      const r = await this.d.pip.uninstall(name, this.onProgress);
      this.d.toast(`Removed ${r.removed}`, "success");
    });
  }

  private runInstall(
    specs: string[],
    title: string,
    doneTitle: string,
  ): Promise<void> {
    return this.run(title, doneTitle, true, async () => {
      const r = await this.d.pip.install(specs, this.onProgress);
      if (r.installed.length)
        this.d.toast(
          r.installed.length <= 3
            ? `Installed ${r.installed.map((i) => `${i.name} ${i.version}`).join(", ")}`
            : `Installed ${plural(r.installed.length, "package")}`,
          "success",
        );
      else this.d.toast("Already installed", "info");
    });
  }

  // ============================================================== search

  /** Entering the Search tab: show what is on disk, and the popular list if there is a query-free state. */
  private async enterSearch(): Promise<void> {
    try {
      this.index.set(await this.d.pip.indexStatus());
    } catch {
      /* status is informational */
    }
    if (this.rows.peek().length === 0 && !this.searching.peek())
      await this.runSearch(this.query.peek());
  }

  setQuery(q: string): void {
    this.query.set(q);
    clearTimeout(this.timer);
    this.timer = setTimeout(
      () => void this.runSearch(q),
      q.trim() ? this.debounceMs : 0,
    );
  }

  /** Search now (Enter, a recent-search chip). */
  submitSearch(q = this.query.peek()): Promise<void> {
    clearTimeout(this.timer);
    this.query.set(q);
    this.remember(q);
    return this.runSearch(q);
  }

  private remember(q: string): void {
    const t = q.trim();
    if (!t) return;
    const next = [
      t,
      ...this.recent.peek().filter((r) => r.toLowerCase() !== t.toLowerCase()),
    ].slice(0, 8);
    this.recent.set(next);
    try {
      this.d.storage?.setItem(RECENT_KEY, JSON.stringify(next));
    } catch {
      /* private mode */
    }
  }

  clearRecent(): void {
    this.recent.set([]);
    try {
      this.d.storage?.setItem(RECENT_KEY, "[]");
    } catch {
      /* private mode */
    }
  }

  private catalogRows(q: string): Row[] {
    return searchCatalog(q, 8).map((c) => ({
      name: c.name,
      key: canonicalName(c.name),
      downloads: 0,
      installed: null,
      summary: c.blurb,
      version: null,
      match: "substring" as const,
      catalog: true,
      compiled: c.compiled === true,
    }));
  }

  private toRow(h: SearchHit): Row {
    const c = catalogItem(h.name);
    return {
      ...h,
      summary: h.summary ?? c?.blurb ?? null,
      catalog: false,
      compiled: c?.compiled === true,
    };
  }

  private onProgress = (p: PipProgress): void => {
    if (p.t === "log" && p.s) this.onLog(p.s);
    else if (p.t === "dl") {
      this.cardFile.set(p.file ?? "");
      this.cardPct.set(
        p.total ? Math.round(((p.done ?? 0) / p.total) * 100) : null,
      );
    }
  };

  async runSearch(q: string, more = false): Promise<void> {
    const seq = ++this.searchSeq;
    const trimmed = q.trim();
    this.searching.set(true);
    this.searchError.set(null);
    const offset = more ? this.rows.peek().filter((r) => !r.catalog).length : 0;
    const known = trimmed ? this.catalogRows(trimmed) : [];
    try {
      const res = await this.d.pip.search(
        trimmed,
        { limit: PAGE, offset },
        (p) => {
          if (seq === this.searchSeq && p.t === "dl")
            this.indexProgress.set({
              done: p.done ?? 0,
              total: p.total ?? null,
            });
        },
      );
      if (seq !== this.searchSeq) return; // a newer search has started
      this.index.set(res.index);
      const fromIndex = res.hits.map((h) => this.toRow(h));
      const seen = new Set<string>();
      const merged: Row[] = [];
      const add = (r: Row): void => {
        if (!seen.has(r.key)) {
          seen.add(r.key);
          merged.push(r);
        }
      };
      if (more) this.rows.peek().forEach(add);
      else {
        // An exact name first, then what the catalogue knows by that word, then the rest.
        fromIndex.filter((r) => r.match === "exact").forEach(add);
        known.forEach(add);
      }
      fromIndex.forEach(add);
      this.rows.set(merged);
      this.total.set(
        res.total +
          (more
            ? 0
            : known.filter((k) => !fromIndex.some((f) => f.key === k.key))
                .length),
      );
    } catch (e) {
      if (seq !== this.searchSeq) return;
      if (e instanceof PipError && e.cancelled) return;
      // No list to search in (offline, first use): the catalogue still answers.
      this.searchError.set(messageOf(e));
      this.rows.set(known);
      this.total.set(known.length);
    } finally {
      if (seq === this.searchSeq) {
        this.searching.set(false);
        this.indexProgress.set(null);
      }
    }
    if (seq === this.searchSeq) void this.fillSummaries(seq);
  }

  loadMore(): Promise<void> {
    return this.runSearch(this.query.peek(), true);
  }

  /** One-line descriptions for the first rows that don't have one. They arrive after the list is already on screen. */
  private async fillSummaries(seq: number): Promise<void> {
    const need = this.rows
      .peek()
      .slice(0, SUMMARY_ROWS * (1 + Math.floor(this.rows.peek().length / PAGE)))
      .filter((r) => !r.summary)
      .map((r) => r.name);
    if (need.length === 0) return;
    try {
      const got = await this.d.pip.summaries(need);
      if (seq !== this.searchSeq) return;
      this.rows.update((rows) =>
        rows.map((r) => {
          const s = got[r.name];
          return s
            ? {
                ...r,
                summary: s.summary || r.summary,
                version: s.version ?? r.version,
              }
            : r;
        }),
      );
    } catch {
      /* rows simply stay without a description */
    }
  }

  async refreshIndex(): Promise<void> {
    if (this.busy.peek()) return;
    this.indexProgress.set({ done: 0, total: null });
    try {
      this.index.set(
        await this.d.pip.refreshIndex((p) => {
          if (p.t === "dl")
            this.indexProgress.set({
              done: p.done ?? 0,
              total: p.total ?? null,
            });
        }),
      );
      this.d.toast("Package list updated", "success");
      await this.runSearch(this.query.peek());
    } catch (e) {
      this.d.toast(messageOf(e), "error");
    } finally {
      this.indexProgress.set(null);
    }
  }

  // ============================================================= details

  async openDetail(name: string, summary = ""): Promise<void> {
    const key = canonicalName(name);
    const known = catalogItem(name);
    const seq = ++this.detailSeq;
    this.detail.set({
      name,
      key,
      info: null,
      summary:
        summary ||
        known?.blurb ||
        this.rows.peek().find((r) => r.key === key)?.summary ||
        "",
      loading: true,
      error: null,
      selected: null,
      compat: null,
      compatLoading: false,
      dependents: [],
    });
    this.remember(this.query.peek());
    try {
      const info = await this.d.pip.info(name);
      if (seq !== this.detailSeq) return;
      if (info.status !== "ok") {
        this.patchDetail({ loading: false, error: info.message });
        return;
      }
      this.patchDetail({
        info,
        name: info.name,
        loading: false,
        summary: info.summary || this.detail.peek()?.summary || "",
      });
    } catch (e) {
      if (seq !== this.detailSeq) return;
      this.patchDetail({ loading: false, error: messageOf(e) });
      return;
    }
    void this.loadCompat(seq);
    if (this.installedMap.peek().has(key)) void this.loadDependents(seq);
  }

  closeDetail(): void {
    this.detailSeq++;
    this.detail.set(null);
  }

  private patchDetail(patch: Partial<DetailState>): void {
    const cur = this.detail.peek();
    if (cur) this.detail.set({ ...cur, ...patch });
  }

  /** Can this device load it? Asked for the chosen release, or for the best one when none is chosen. */
  private async loadCompat(seq: number): Promise<void> {
    const cur = this.detail.peek();
    if (!cur) return;
    this.patchDetail({ compatLoading: true, compat: null });
    try {
      const spec = cur.selected ? `${cur.key}==${cur.selected}` : cur.key;
      const compat = await this.d.pip.lookup(spec);
      if (
        seq === this.detailSeq &&
        this.detail.peek()?.selected === cur.selected
      )
        this.patchDetail({ compat, compatLoading: false });
    } catch (e) {
      if (seq === this.detailSeq)
        this.patchDetail({
          compatLoading: false,
          compat: { status: "not_found", name: cur.key, message: messageOf(e) },
        });
    }
  }

  private async loadDependents(seq: number): Promise<void> {
    const cur = this.detail.peek();
    if (!cur) return;
    try {
      const r = await this.d.pip.dependents(cur.key);
      if (seq === this.detailSeq)
        this.patchDetail({ dependents: r.dependents });
    } catch {
      /* informational */
    }
  }

  selectVersion(version: string | null): void {
    const cur = this.detail.peek();
    if (!cur || cur.selected === version) return;
    this.patchDetail({ selected: version });
    void this.loadCompat(this.detailSeq);
  }

  /** The button in the details sheet can do something. */
  readonly detailCanInstall = computed(() => {
    const d = this.detail();
    if (!d || d.loading || d.error) return false;
    return d.compat === null || d.compat.status === "ok";
  });

  async installFromDetail(): Promise<void> {
    const d = this.detail.peek();
    if (!d || this.busy.peek()) return;
    const spec = d.selected ? `${d.key}==${d.selected}` : d.key;
    await this.install(spec);
  }

  // =========================================================== operations

  cancelOperation(): void {
    if (this.checking.peek()) return void this.d.pip.cancel();
    if (this.op.peek() !== "running" || !this.cancellable.peek()) return;
    this.op.set("cancelling");
    this.d.pip.cancel();
  }

  closeCard(): void {
    this.cardOpen.set(false);
    this.onCardChange(false);
  }

  private async run(
    title: string,
    doneTitle: string,
    canCancel: boolean,
    work: () => Promise<void>,
  ): Promise<void> {
    if (this.busy.peek()) return;
    this.onLogReset();
    this.cardTitle.set(title);
    this.cardError.set(null);
    this.cardPct.set(null);
    this.cardFile.set("");
    this.cancellable.set(canCancel);
    this.op.set("running");
    this.cardOpen.set(true);
    this.onCardChange(true);
    try {
      await work();
      this.cardTitle.set(doneTitle);
      this.op.set("done");
      await this.afterChange();
    } catch (e) {
      if (e instanceof PipError && e.cancelled) {
        this.op.set("idle");
        this.closeCard();
        this.d.toast("Cancelled. Nothing was changed.", "info");
        return;
      }
      this.cardTitle.set(`${title} failed`);
      this.cardError.set(messageOf(e));
      this.op.set("failed");
    }
  }

  /** The installed set changed: refresh it, and everything that shows it. */
  private async afterChange(): Promise<void> {
    await this.refreshInstalled();
    const have = this.installedMap.peek();
    // An update that has been applied is no longer pending.
    const pending = new Map(this.updates.peek());
    for (const [name, u] of pending)
      if (!have.has(name) || have.get(name) === u.latest) pending.delete(name);
    this.updates.set(pending);
    const d = this.detail.peek();
    if (d) {
      const seq = this.detailSeq;
      this.patchDetail({
        info: d.info
          ? { ...d.info, installed: have.get(d.key) ?? null }
          : d.info,
      });
      void this.loadCompat(seq);
      if (have.has(d.key)) void this.loadDependents(seq);
      else this.patchDetail({ dependents: [] });
    }
  }
}
