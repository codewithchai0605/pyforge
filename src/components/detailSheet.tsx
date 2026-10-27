import { For, Show, computed, signal } from "xtags";
import { customDialog } from "@/components/dialogs";
import { icon } from "@/components/icons";
import { openExternal } from "@/native/device";
import { formatBytes } from "@/pypi/format";
import type { PackagesModel } from "@/pypi/model";
import { COMPILED_HINT } from "./rows";
import { catalogItem } from "@/pypi/catalog";

/**
 * The details sheet. Everything worth knowing before installing: what it is,
 * whether this phone can run it (and which release can), who needs it if it
 * is already installed, and where to read more. It is a modal sheet, so the
 * Back button and a tap outside close it.
 */
export function openDetailSheet(
  model: PackagesModel,
  name: string,
  summary = "",
): void {
  void model.openDetail(name, summary);
  void customDialog((close) => buildSheet(model, close)).then(() =>
    model.closeDetail(),
  );
}

function buildSheet(
  model: PackagesModel,
  close: (v?: undefined) => void,
): HTMLElement {
  const d = model.detail;
  const info = computed(() => d()?.info ?? null);
  const installed = computed(() => {
    const cur = d();
    return cur ? (model.installedMap().get(cur.key) ?? null) : null;
  });
  const removable = computed(() => {
    const cur = d();
    return (
      !!cur && model.installed().some((p) => p.name === cur.key && p.removable)
    );
  });
  const builtin = computed(() => installed() !== null && !removable());
  const expanded = signal(false);

  // The button's wording says what will happen.
  const actionLabel = computed(() => {
    const cur = d();
    if (!cur) return "Install";
    const have = installed();
    const compat = cur.compat?.status === "ok" ? cur.compat : null;
    const target = cur.selected ?? compat?.version ?? null;
    if (!have) return target ? `Install ${target}` : "Install";
    if (target && target !== have)
      return cur.selected ? `Install ${target}` : `Update to ${target}`;
    return "Reinstall";
  });

  const compatClass = computed(() => {
    const c = d();
    if (!c) return "pkg-compat";
    if (
      c.compatLoading ||
      (!c.compat && !c.error && c.loading === false && !c.info)
    )
      return "pkg-compat loading";
    if (c.compatLoading) return "pkg-compat loading";
    if (!c.compat) return "pkg-compat loading";
    return c.compat.status === "ok" ? "pkg-compat ok" : "pkg-compat warn";
  });

  const compatText = computed(() => {
    const c = d();
    if (!c || c.error) return "";
    if (c.compatLoading || !c.compat)
      return "Checking whether this device can run it…";
    const r = c.compat;
    if (r.status !== "ok") return r.message;
    const kind =
      r.kind === "pure"
        ? "pure Python"
        : r.source === "chaquopy"
          ? "native build for Android"
          : "native build";
    const size = formatBytes(r.size);
    const newest = c.info?.version;
    const behind =
      !c.selected && newest && newest !== r.version
        ? ` The newest release (${newest}) isn't available for this device.`
        : "";
    return `Works on this device: ${r.version} · ${kind}${size ? ` · ${size}` : ""}.${behind}${r.note ? ` ${r.note}` : ""}`;
  });

  const versionOptions = computed(() => ["", ...(info()?.versions ?? [])]);

  return (
    <div
      class="dialog dialog-sheet pkg-sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Package details"
    >
      <header class="pkg-sheet-head">
        <div class="pkg-sheet-title">
          <h2>{computed(() => d()?.name ?? "")}</h2>
          <div class="pkg-sheet-sub">
            <span
              class={computed(() => ({ "pkg-version": true, hidden: !info() }))}
            >
              {computed(() => (info() ? `latest ${info()!.version}` : ""))}
            </span>
            <span
              class={computed(() => ({
                tag: true,
                "tag-installed": true,
                hidden: installed() === null,
              }))}
            >
              {computed(() => (installed() ? `installed ${installed()}` : ""))}
            </span>
            <span class={computed(() => ({ tag: true, hidden: !builtin() }))}>
              built in
            </span>
            {catalogItem(d.peek()?.name ?? "")?.compiled ? (
              <span class="tag" title={COMPILED_HINT}>
                compiled
              </span>
            ) : null}
          </div>
        </div>
        <button
          type="button"
          class="icon-btn"
          title="Close"
          aria-label="Close"
          onClick={() => close()}
        >
          {icon("x", 22)}
        </button>
      </header>

      <div class="pkg-sheet-body">
        {Show({
          when: () => d()?.error != null,
          children: (
            <div class="pkg-banner warn" role="alert">
              {icon("alert", 18)}
              <div>
                <strong>Can't show this package</strong>
                <p>{computed(() => d()?.error ?? "")}</p>
              </div>
            </div>
          ),
          fallback: (
            <>
              <p class="pkg-sheet-summary">
                {computed(
                  () =>
                    d()?.summary ||
                    (d()?.loading ? "Loading…" : "No description."),
                )}
              </p>

              <div class={compatClass} role="status">
                {icon("info", 18)}
                <span>{compatText}</span>
              </div>

              {Show({
                when: () => (info()?.versions.length ?? 0) > 0,
                children: (
                  <label class="pkg-field">
                    <span>Release</span>
                    <select
                      class="text-input"
                      aria-label="Release to install"
                      onChange={(e: Event) =>
                        model.selectVersion(
                          (e.target as HTMLSelectElement).value || null,
                        )
                      }
                    >
                      <For each={versionOptions} key={(v: string) => v}>
                        {(v: string) => (
                          <option
                            value={v}
                            selected={computed(
                              () => (d()?.selected ?? "") === v,
                            )}
                          >
                            {v === "" ? "Newest that works on this device" : v}
                          </option>
                        )}
                      </For>
                    </select>
                  </label>
                ),
              })}

              {Show({
                when: () => !!info(),
                children: (
                  <dl class="pkg-facts">
                    <div class={computed(() => ({ hidden: !info()?.license }))}>
                      <dt>License</dt>
                      <dd>{computed(() => info()?.license ?? "")}</dd>
                    </div>
                    <div
                      class={computed(() => ({
                        hidden: !info()?.requiresPython,
                      }))}
                    >
                      <dt>Python</dt>
                      <dd>{computed(() => info()?.requiresPython ?? "")}</dd>
                    </div>
                    <div class={computed(() => ({ hidden: !info()?.author }))}>
                      <dt>Author</dt>
                      <dd>{computed(() => info()?.author ?? "")}</dd>
                    </div>
                  </dl>
                ),
              })}

              {Show({
                when: () => (d()?.dependents.length ?? 0) > 0,
                children: (
                  <p class="pkg-note">
                    {icon("alert", 16)}
                    <span>
                      Needed by{" "}
                      <strong>
                        {computed(() => d()?.dependents.join(", ") ?? "")}
                      </strong>
                      . Removing it would break
                      {computed(() =>
                        (d()?.dependents.length ?? 0) === 1
                          ? " that package."
                          : " those packages.",
                      )}
                    </span>
                  </p>
                ),
              })}

              {Show({
                when: () => (info()?.requires.length ?? 0) > 0,
                children: (
                  <div class="pkg-block">
                    <h3>Installs with it</h3>
                    <div class="chip-row wrap">
                      <For
                        each={computed(() => info()?.requires ?? [])}
                        key={(r: string) => r}
                      >
                        {(r: string) => (
                          <button
                            type="button"
                            class="chip"
                            onClick={() => void model.openDetail(r)}
                          >
                            {r}
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                ),
              })}

              {Show({
                when: () => !!info()?.description,
                children: (
                  <div class="pkg-block">
                    <h3>About</h3>
                    <p
                      class={computed(() => ({
                        "pkg-desc": true,
                        expanded: expanded(),
                      }))}
                    >
                      {computed(() => info()?.description ?? "")}
                    </p>
                    <button
                      type="button"
                      class="pkg-link"
                      onClick={() => expanded.update((v) => !v)}
                    >
                      {computed(() => (expanded() ? "Show less" : "Read more"))}
                    </button>
                  </div>
                ),
              })}

              {Show({
                when: () => (info()?.links.length ?? 0) > 0,
                children: (
                  <div class="pkg-block">
                    <h3>Links</h3>
                    <div class="chip-row wrap">
                      <For
                        each={computed(() => info()?.links ?? [])}
                        key={(l: { label: string; url: string }) => l.url}
                      >
                        {(l: { label: string; url: string }) => (
                          <button
                            type="button"
                            class="chip"
                            title={l.url}
                            onClick={() => openExternal(l.url)}
                          >
                            {l.label}
                          </button>
                        )}
                      </For>
                    </div>
                  </div>
                ),
              })}
            </>
          ),
        })}
      </div>

      <div class="dialog-actions pkg-sheet-actions">
        <button
          type="button"
          class={computed(() => ({
            btn: true,
            "btn-danger": true,
            hidden: !removable(),
          }))}
          disabled={computed(() => model.busy())}
          onClick={() => {
            const name = d.peek()?.key;
            close();
            if (name) void model.uninstall(name);
          }}
        >
          Uninstall
        </button>
        <span class="panel-spacer" />
        <button
          type="button"
          class="btn btn-primary"
          disabled={computed(
            () => model.busy() || !model.detailCanInstall() || builtin(),
          )}
          onClick={() => {
            // The progress card lives on the page, under this sheet: leave first, so it can be seen.
            const spec = d.peek();
            close();
            if (spec) void model.installFromDetail();
          }}
        >
          {icon("download", 18)}
          {actionLabel}
        </button>
      </div>
    </div>
  ) as HTMLElement;
}
