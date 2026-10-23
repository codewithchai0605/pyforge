import { For, Show, computed, signal, watch } from "xtags";
import type { Router } from "@/navigation";
import type {
  InstalledPackage,
  PipProgress,
  PyRuntime,
  RuntimeInfo,
} from "@/python/protocol";
import { PipError } from "@/python/protocol";
import { Page } from "./page";
import { icon } from "./icons";
import { confirmDialog } from "./dialogs";
import { pushBack } from "./backStack";
import { toast } from "./toast";

interface Suggestion {
  name: string;
  blurb: string;
  /** Needs compiled code, so it only installs if an Android build exists for it. */
  compiled?: boolean;
}

const SUGGESTIONS: Suggestion[] = [
  { name: "requests", blurb: "Friendly HTTP requests" },
  { name: "beautifulsoup4", blurb: "Parse HTML and XML" },
  { name: "rich", blurb: "Beautiful terminal output" },
  { name: "tqdm", blurb: "Progress bars" },
  { name: "python-dateutil", blurb: "Powerful date parsing" },
  { name: "flask", blurb: "Tiny web framework" },
  { name: "sympy", blurb: "Symbolic mathematics" },
  { name: "colorama", blurb: "Coloured text output" },
  { name: "numpy", blurb: "Fast arrays and maths", compiled: true },
  { name: "matplotlib", blurb: "Charts and plots", compiled: true },
  { name: "pandas", blurb: "Data tables", compiled: true },
  { name: "pillow", blurb: "Image processing", compiled: true },
  { name: "scipy", blurb: "Scientific computing", compiled: true },
];

export interface PackagesPageProps {
  router: Router;
  runtime: PyRuntime;
  info: RuntimeInfo | null;
}

type OpState = "idle" | "running" | "cancelling" | "done" | "failed";

export function PackagesPage({
  router,
  runtime,
  info,
}: PackagesPageProps): Node {
  const installed = signal<InstalledPackage[]>([]);
  const loadingList = signal(false);
  const query = signal("");

  // The operation card (progress, log, Cancel/Done).
  const op = signal<OpState>("idle");
  const cardOpen = signal(false);
  const cardTitle = signal("");
  const cardError = signal<string | null>(null);
  const cardPct = signal<number | null>(null);
  const cardFile = signal("");
  const cancellable = signal(true);
  const busy = computed(() => op() === "running" || op() === "cancelling");
  const logEl = (<pre class="pip-log" aria-live="polite" />) as HTMLElement;

  const installedNames = computed(
    () => new Map(installed().map((p) => [p.name, p.version])),
  );

  async function refresh(): Promise<void> {
    loadingList.set(true);
    try {
      installed.set(await runtime.pip.list());
    } catch (e) {
      toast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      loadingList.set(false);
    }
  }
  // Re-read the installed list each time the page is shown (e.g. after packages changed elsewhere).
  watch(
    () => router.stack().includes("packages"),
    (open) => void (open && refresh()),
    { defer: true },
  );

  const onProgress = (p: PipProgress): void => {
    if (p.t === "log" && p.s) {
      logEl.append(document.createTextNode(p.s + "\n"));
      logEl.scrollTop = logEl.scrollHeight;
    } else if (p.t === "dl") {
      cardFile.set(p.file ?? "");
      cardPct.set(p.total ? Math.round(((p.done ?? 0) / p.total) * 100) : null);
    }
  };

  function cancelOperation(): void {
    if (op.peek() !== "running" || !cancellable.peek()) return;
    op.set("cancelling");
    runtime.pip.cancel();
  }

  let releaseBack = (): void => {};
  function closeCard(): void {
    cardOpen.set(false);
    releaseBack();
  }

  async function runOperation(
    title: string,
    doneTitle: string,
    canCancel: boolean,
    work: () => Promise<void>,
  ): Promise<void> {
    if (busy.peek()) return;
    logEl.textContent = "";
    cardTitle.set(title);
    cardError.set(null);
    cardPct.set(null);
    cardFile.set("");
    cancellable.set(canCancel);
    op.set("running");
    cardOpen.set(true);
    // Back while working = Cancel; Back when finished = dismiss. It never leaves the page mid-install.
    releaseBack = pushBack(() =>
      op.peek() === "running"
        ? cancelOperation()
        : op.peek() === "cancelling"
          ? undefined
          : closeCard(),
    );
    try {
      await work();
      cardTitle.set(doneTitle);
      op.set("done");
      await refresh();
    } catch (e) {
      if (e instanceof PipError && e.cancelled) {
        op.set("idle");
        closeCard();
        toast("Cancelled. Nothing was changed.", "info");
        return;
      }
      cardTitle.set(`${title} failed`);
      cardError.set(e instanceof Error ? e.message : String(e));
      op.set("failed");
    }
  }

  const install = (spec: string): Promise<void> =>
    runOperation(`Installing ${spec}`, `Installed ${spec}`, true, async () => {
      const result = await runtime.pip.install([spec], onProgress);
      if (result.installed.length)
        toast(
          `Installed ${result.installed.map((i) => `${i.name} ${i.version}`).join(", ")}`,
          "success",
        );
    });

  const uninstall = async (pkg: InstalledPackage): Promise<void> => {
    const ok = await confirmDialog({
      title: `Uninstall ${pkg.name}?`,
      message:
        "Programs that import it will stop working until you install it again.",
      confirmLabel: "Uninstall",
      danger: true,
    });
    if (!ok) return;
    await runOperation(
      `Removing ${pkg.name}`,
      `Removed ${pkg.name}`,
      false,
      async () => {
        const r = await runtime.pip.uninstall(pkg.name, onProgress);
        toast(`Removed ${r.removed}`, "success");
      },
    );
  };

  const submit = (): void => {
    const spec = query.peek().trim();
    if (!spec) return;
    query.set("");
    void install(spec);
  };

  const SuggestionCard = ({ s }: { s: Suggestion }): Node => (
    <div class="pkg-card">
      <div class="pkg-card-text">
        <strong>{s.name}</strong>
        {s.compiled ? (
          <span
            class="tag"
            title="Needs compiled code. Installs only if an Android build exists; otherwise bundle it at build time (python/requirements.txt)."
          >
            compiled
          </span>
        ) : null}
        <span class="pkg-blurb">{s.blurb}</span>
      </div>
      <button
        type="button"
        class={computed(() => ({
          btn: true,
          "btn-small": true,
          "btn-primary": !installedNames().has(s.name),
        }))}
        disabled={computed(() => installedNames().has(s.name) || busy())}
        aria-label={computed(() =>
          installedNames().has(s.name)
            ? `${s.name} is installed`
            : `Install ${s.name}`,
        )}
        onClick={() => void install(s.name)}
      >
        {computed(() =>
          installedNames().has(s.name) ? "Installed" : "Install",
        )}
      </button>
    </div>
  );

  const actions = (
    <>
      <button
        type="button"
        class="icon-btn"
        title="Refresh"
        aria-label="Refresh"
        onClick={() => void refresh()}
      >
        {icon("refresh", 20)}
      </button>
      <button
        type="button"
        class="icon-btn"
        title="Settings"
        aria-label="Settings"
        onClick={() => router.push("settings")}
      >
        {icon("settings", 20)}
      </button>
    </>
  );

  return (
    <Page route="packages" router={router} title="Packages" actions={actions}>
      <p class="runtime-line">
        {info
          ? `Python ${info.python}${info.abi ? ` · ${info.abi}` : " · desktop preview"}`
          : "Python is not available here"}
      </p>

      <form
        class="install-bar"
        onSubmit={(e: Event) => {
          e.preventDefault();
          submit();
        }}
      >
        <input
          type="text"
          class="text-input"
          placeholder="Package name, e.g. requests or rich>=13"
          aria-label="Package to install"
          enterkeyhint="go"
          autocapitalize="off"
          autocomplete="off"
          autocorrect="off"
          spellcheck="false"
          model={query}
        />
        <button
          type="submit"
          class="btn btn-primary"
          disabled={computed(() => busy() || query().trim() === "")}
        >
          {icon("download", 18)}Install
        </button>
      </form>

      <h2 class="section-title">Popular</h2>
      <div class="pkg-grid">
        {SUGGESTIONS.map((s) => SuggestionCard({ s }))}
      </div>

      <h2 class="section-title">
        Installed
        <span class="count">{computed(() => String(installed().length))}</span>
      </h2>
      <Show when={() => installed().length === 0}>
        <p class="muted">
          {computed(() =>
            loadingList()
              ? "Loading…"
              : "Nothing installed yet. Pick a package above, or type a name.",
          )}
        </p>
      </Show>
      <ul class="pkg-list">
        <For each={installed} key={(p: InstalledPackage) => p.name}>
          {(p: InstalledPackage) => (
            <li class="pkg-row">
              <div class="pkg-row-text">
                <strong>{p.name}</strong>
                <span class="pkg-version">{p.version}</span>
                {!p.removable ? <span class="tag">built in</span> : null}
                {p.summary ? <span class="pkg-blurb">{p.summary}</span> : null}
              </div>
              {p.removable ? (
                <button
                  type="button"
                  class="icon-btn danger"
                  title={`Uninstall ${p.name}`}
                  aria-label={`Uninstall ${p.name}`}
                  disabled={busy}
                  onClick={() => void uninstall(p)}
                >
                  {icon("trash", 18)}
                </button>
              ) : null}
            </li>
          )}
        </For>
      </ul>

      <div
        class={computed(() => ({ "progress-scrim": true, show: cardOpen() }))}
      >
        <div class="progress-card" role="status">
          <h2 class="dialog-title">{cardTitle}</h2>
          <div
            class={computed(() => ({
              bar: true,
              indeterminate: busy() && cardPct() === null,
              hidden: !busy(),
            }))}
          >
            <div
              class="bar-fill"
              style={{
                width: computed(() =>
                  cardPct() === null ? "40%" : `${cardPct()}%`,
                ),
              }}
            />
          </div>
          <div class="bar-caption">
            {computed(() => (busy() ? cardFile() : ""))}
          </div>
          {logEl}
          <Show when={() => !!cardError()}>
            <div class="dialog-error" role="alert">
              {cardError}
            </div>
          </Show>
          <div class="dialog-actions">
            <Show when={() => busy() && cancellable()}>
              <button
                type="button"
                class="btn"
                disabled={computed(() => op() === "cancelling")}
                onClick={cancelOperation}
              >
                {computed(() =>
                  op() === "cancelling" ? "Cancelling…" : "Cancel",
                )}
              </button>
            </Show>
            <Show when={() => !busy()}>
              <button type="button" class="btn btn-primary" onClick={closeCard}>
                Done
              </button>
            </Show>
          </div>
        </div>
      </div>
    </Page>
  );
}
